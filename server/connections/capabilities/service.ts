import { createHash } from 'node:crypto';
import type { CapabilityTemplate, JsonValue } from '../types.js';
import { validateCapabilityInput, canonicalJson } from './input-validation.js';
import { CapabilityOperationStore } from './operation-store.js';
import { CapabilityExecutorRegistry } from './registry.js';
import type {
  CapabilityApproval,
  CapabilityConnection,
  CapabilityGrant,
  CapabilityOperation,
  CapabilityRequest,
} from './types.js';

const secretKey = /(?:secret|token|password|credential|authorization|api[-_]?key)/i;
const MAX_RESULT_BYTES = 32 * 1024;

function failCode(error: unknown): string {
  return error instanceof Error && error.name === 'AbortError' ? 'CANCELLED' : 'EXECUTION_FAILED';
}
function redact(value: JsonValue, sensitiveValues: readonly string[]): JsonValue {
  if (typeof value === 'string') {
    let output = value;
    for (const secret of sensitiveValues)
      if (secret.length >= 3) output = output.split(secret).join('[REDACTED]');
    output = output.replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]');
    return output.length > MAX_RESULT_BYTES ? `${output.slice(0, MAX_RESULT_BYTES)}…` : output;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, sensitiveValues));
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = Object.create(null);
    for (const [key, item] of Object.entries(value))
      out[key] = secretKey.test(key) ? '[REDACTED]' : redact(item, sensitiveValues);
    return out;
  }
  return value;
}
function resultIsBounded(value: JsonValue): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RESULT_BYTES;
}

export interface CapabilityServiceOptions {
  store: CapabilityOperationStore;
  executorRegistry: CapabilityExecutorRegistry;
  getTemplate(id: string, version: number): CapabilityTemplate | undefined;
  getConnection(id: string): CapabilityConnection | undefined;
  listConnections(): readonly CapabilityConnection[];
  /** Trusted lifecycle state, never supplied by a browser/tool input. */
  isConnectionActiveForConversation(
    connectionId: string,
    accountId: string,
    conversationId: string,
  ): boolean;
  approve: CapabilityApproval;
}

/** Shared browser/direct-service pipeline: validate → authorize → idempotently execute → verify → audit. */
export class CapabilityService {
  constructor(private readonly options: CapabilityServiceOptions) {}
  eligibleTools(
    accountId: string,
    conversationId: string,
    connections: readonly CapabilityConnection[],
    grants: Array<{ connectionId: string; capabilityId: string; capabilityVersion: number }>,
  ) {
    return grants
      .filter((grant) => {
        const connection = connections.find((item) => item.id === grant.connectionId);
        const template = this.options.getTemplate(grant.capabilityId, grant.capabilityVersion);
        return (
          !!connection &&
          !!template &&
          this.options.executorRegistry.supports(template) &&
          connection.status === 'active' &&
          connection.desiredAccountIds.includes(accountId) &&
          this.options.isConnectionActiveForConversation(connection.id, accountId, conversationId)
        );
      })
      .map((grant) => ({
        capabilityId: grant.capabilityId,
        capabilityVersion: grant.capabilityVersion,
        connectionId: grant.connectionId,
        connectionRevision: connections.find((connection) => connection.id === grant.connectionId)!
          .revision,
      }));
  }
  eligibleToolsForConversation(
    accountId: string,
    conversationId: string,
    attachedConnection?: Pick<CapabilityConnection, 'id' | 'revision'> | null,
  ) {
    const connections = this.options
      .listConnections()
      .filter(
        (connection) =>
          !attachedConnection ||
          (connection.id === attachedConnection.id &&
            connection.revision === attachedConnection.revision),
      );
    return this.eligibleTools(
      accountId,
      conversationId,
      connections,
      connections.flatMap((connection) =>
        this.options.store
          .grants(connection.id)
          .filter(
            (grant) =>
              grant.status === 'active' &&
              grant.connectionRevision === connection.revision &&
              grant.accountIds.includes(accountId),
          )
          .map((grant) => ({
            connectionId: grant.connectionId,
            capabilityId: grant.capabilityId,
            capabilityVersion: grant.capabilityVersion,
          })),
      ),
    );
  }
  listGrants(connectionId: string): CapabilityGrant[] {
    return this.options.store.grants(connectionId);
  }
  setGrant(input: {
    connectionId: string;
    connectionRevision: number;
    capabilityId: string;
    capabilityVersion: number;
    accountIds: string[];
    status: 'active' | 'revoked';
  }): CapabilityGrant {
    const connection = this.options.getConnection(input.connectionId);
    const template = this.options.getTemplate(input.capabilityId, input.capabilityVersion);
    if (
      !connection ||
      connection.revision !== input.connectionRevision ||
      !template ||
      !template.connectionTemplateIds.includes(connection.templateId) ||
      (input.status === 'active' && !this.options.executorRegistry.supports(template)) ||
      input.accountIds.some((id) => !connection.desiredAccountIds.includes(id))
    )
      throw new Error('Capability grant is unavailable');
    return this.options.store.upsertGrant(input);
  }
  getOperation(
    id: string,
    accountId: string,
    conversationId: string,
  ): CapabilityOperation | undefined {
    const operation = this.options.store.get(id);
    if (
      !operation ||
      operation.accountId !== accountId ||
      operation.conversationId !== conversationId ||
      this.options.getConnection(operation.connectionId)?.revision !==
        operation.connectionRevision ||
      !this.options.isConnectionActiveForConversation(
        operation.connectionId,
        accountId,
        conversationId,
      )
    )
      return undefined;
    return operation;
  }
  /** Startup hook: settle only write-ambiguous operations through executor recovery. */
  async recoverPending(signal: AbortSignal): Promise<CapabilityOperation[]> {
    const recovered: CapabilityOperation[] = [];
    for (const operation of this.options.store.pendingRecovery()) {
      const template = this.options.getTemplate(
        operation.capabilityId,
        operation.capabilityVersion,
      );
      if (!template) continue; // Unknown versions remain non-terminal for operator inspection.
      recovered.push(await this.recover(template, operation, signal));
    }
    return recovered;
  }
  /** Cancellation never overwrites a possibly-written operation. */
  cancel(id: string, accountId: string, conversationId: string): CapabilityOperation | undefined {
    const operation = this.getOperation(id, accountId, conversationId);
    if (!operation || operation.status !== 'pending_approval') return operation;
    try {
      return this.options.store.transition(id, 'pending_approval', 'cancelled', {
        failureCode: 'CANCELLED',
      });
    } catch {
      // Approval and browser cancellation may race. The transition loser must
      // report the durable winner instead of converting the race to a 500.
      const current = this.options.store.get(id);
      return current?.accountId === accountId && current.conversationId === conversationId
        ? current
        : undefined;
    }
  }
  async invoke(
    request: CapabilityRequest,
    signal: AbortSignal,
    approve: CapabilityApproval = this.options.approve,
  ): Promise<CapabilityOperation> {
    signal.throwIfAborted();
    const template = this.options.getTemplate(request.capabilityId, request.capabilityVersion);
    if (
      !template ||
      template.id !== request.capabilityId ||
      template.version !== request.capabilityVersion ||
      template.approval !== 'always' ||
      template.idempotency !== 'required'
    )
      throw new Error('Capability is unavailable');
    const connection = this.options.getConnection(request.connectionId);
    if (
      !connection ||
      connection.status !== 'active' ||
      connection.revision !== request.connectionRevision ||
      !connection.desiredAccountIds.includes(request.accountId) ||
      !template.connectionTemplateIds.includes(connection.templateId) ||
      !this.options.isConnectionActiveForConversation(
        connection.id,
        request.accountId,
        request.conversationId,
      )
    )
      throw new Error('Capability access is unavailable');
    const grant = this.options.store.getGrant(
      connection.id,
      connection.revision,
      template.id,
      template.version,
    );
    if (!grant || grant.status !== 'active' || !grant.accountIds.includes(request.accountId))
      throw new Error('Capability grant is unavailable');
    const input = validateCapabilityInput(template.inputSchema, request.input);
    // Some reviewed contracts repeat the connection ID in their structured
    // input for executor readability. It is a consistency assertion, never a
    // selector: the trusted request binding above remains authoritative.
    if ('connectionId' in input && input.connectionId !== request.connectionId)
      throw new Error('Capability input connection does not match its trusted grant');
    const inputHash = createHash('sha256').update(canonicalJson(input)).digest('hex');
    const begun = this.options.store.begin({ ...request, grantId: grant.id, inputHash });
    // Atomic uniqueness makes this the single mutation owner. A concurrent
    // retry must only observe/recover its durable record, never re-approve or
    // execute a second mutation.
    if (!begun.created) {
      if (begun.operation.status !== 'verification_pending') return begun.operation;
      return this.recover(template, begun.operation, signal);
    }
    let operation = begun.operation;
    try {
      const approved = await approve(
        {
          capabilityId: template.id,
          capabilityVersion: template.version,
          connectionId: connection.id,
          operationId: operation.id,
          input,
          forcePrompt: true,
        },
        signal,
      );
      if (signal.aborted)
        return this.options.store.transition(operation.id, 'pending_approval', 'cancelled', {
          failureCode: 'CANCELLED',
        });
      if (!approved)
        return this.options.store.transition(operation.id, 'pending_approval', 'denied', {
          failureCode: 'DENIED',
        });
      operation = this.options.store.transition(operation.id, 'pending_approval', 'running');
      // Re-read authoritative lifecycle state after the approval boundary.
      const current = this.options.getConnection(connection.id);
      if (
        !current ||
        current.status !== 'active' ||
        current.revision !== request.connectionRevision ||
        !this.options.isConnectionActiveForConversation(
          connection.id,
          request.accountId,
          request.conversationId,
        )
      )
        return this.options.store.transition(operation.id, 'running', 'cancelled', {
          failureCode: 'STALE_ACCESS',
        });
      const currentGrant = this.options.store.getGrant(
        current.id,
        current.revision,
        template.id,
        template.version,
      );
      if (
        !currentGrant ||
        currentGrant.id !== grant.id ||
        currentGrant.status !== 'active' ||
        !currentGrant.accountIds.includes(request.accountId)
      )
        return this.options.store.transition(operation.id, 'running', 'cancelled', {
          failureCode: 'STALE_ACCESS',
        });
      signal.throwIfAborted();
      const executor = this.options.executorRegistry.resolve(template);
      // Mark dispatch before the executor call. A remote provider can commit a
      // mutation and then throw/timeout before responding; from this point
      // onward the only safe path is read-after-write recovery.
      operation = this.options.store.transition(operation.id, 'running', 'verification_pending');
      const executed = await executor.execute({ operation, input, signal });
      const sensitive = Object.values(input).filter(
        (value): value is string => typeof value === 'string',
      );
      const output = redact(executed.output, sensitive);
      if (!resultIsBounded(output) || (executed.externalResultId?.length ?? 0) > 512)
        throw new Error('Executor result is invalid');
      // Keep the pre-dispatch ambiguous state while recording only bounded,
      // redacted output. Result processing itself must not create a terminal
      // failure after a potential remote write.
      operation = this.options.store.recordVerificationPending(operation.id, {
        result: output,
        externalResultId: executed.externalResultId,
      });
      signal.throwIfAborted();
      await executor.verify({ operation, input, signal }, executed);
      return this.options.store.transition(operation.id, 'verification_pending', 'succeeded', {
        result: output,
        externalResultId: executed.externalResultId,
      });
    } catch (error) {
      const current = this.options.store.get(operation.id);
      if (
        !current ||
        current.status === 'verification_pending' ||
        (current.status !== 'pending_approval' && current.status !== 'running')
      )
        return current ?? operation;
      const status = failCode(error) === 'CANCELLED' ? 'cancelled' : 'failed';
      return this.options.store.transition(operation.id, current.status, status, {
        failureCode: failCode(error),
      });
    }
  }
  private async recover(
    template: CapabilityTemplate,
    operation: CapabilityOperation,
    signal: AbortSignal,
  ): Promise<CapabilityOperation> {
    try {
      signal.throwIfAborted();
      const executor = this.options.executorRegistry.resolve(template);
      await executor.recover(operation, signal);
      signal.throwIfAborted();
      try {
        return this.options.store.transition(operation.id, 'verification_pending', 'succeeded', {
          result: operation.result ?? { recovered: true },
          externalResultId: operation.externalResultId ?? undefined,
        });
      } catch {
        // Another reconnect may have settled the same read-only recovery
        // between our verification and transition. Return that authoritative
        // result; never convert its success into a failure.
        return this.options.store.get(operation.id) ?? operation;
      }
    } catch (error) {
      // An interrupted reconnect leaves the operation recoverable. Only a
      // definitive verification failure becomes terminal.
      const current = this.options.store.get(operation.id);
      if (!current || current.status !== 'verification_pending') return current ?? operation;
      if (failCode(error) === 'CANCELLED') return current;
      try {
        return this.options.store.transition(operation.id, 'verification_pending', 'failed', {
          failureCode: 'VERIFICATION_FAILED',
        });
      } catch {
        return this.options.store.get(operation.id) ?? current;
      }
    }
  }
}
