import { isDeepStrictEqual } from 'node:util';
import {
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import {
  captureAgentLibraryAuthorization,
  captureAgentLibraryOperation,
} from './agent-library-transport.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { buildPermissionHandler } from './permission-handler.js';
import { specialistToolSchema } from './specialist-consultation-contract.js';
import { getSpecialistConsultations } from './specialist-consultation-runtime.js';
import { createLogger } from './logger.js';
import { specialistDiagnostic } from './specialist-consultation-diagnostics.js';
import type { ProfileToolCall } from './session-profile-tools.js';

const log = createLogger('specialist-tool');
export function sessionSpecialistTools(
  sessionId: string,
  session: ManagedSession,
  registry: SessionRegistry,
  prefix: string,
  assertRuntimeCurrent?: () => Promise<void>,
  assertRuntimeCurrentSync?: () => void,
) {
  return {
    async execute(raw: unknown, externalSignal: AbortSignal, call?: ProfileToolCall) {
      let operation: ReturnType<typeof captureAgentLibraryOperation> | undefined;
      let requestId: string | undefined;
      let stage = 'authorization';
      try {
        if (!assertRuntimeCurrent || !assertRuntimeCurrentSync)
          throw Error('Specialist consultation requires a verified ordinary runtime');
        const input = specialistToolSchema.parse(raw);
        requestId = input.requestId;
        const owner = () => {
          externalSignal.throwIfAborted();
          session.abortController.signal.throwIfAborted();
          assertRuntimeCurrentSync();
          const current = registry.findBySessionId(sessionId);
          if (
            !current ||
            current.session !== session ||
            registry.isClosingOut(current.clientId) ||
            registry.isUserClose(current.clientId) ||
            !agentToolAllowed(session, 'SymposiumConsult') ||
            checkSkillPolicy(registry, current.clientId, prefix + 'SymposiumConsult') === 'deny'
          )
            throw Error('Specialist tool owner, selection or skill policy changed');
          return current;
        };
        const source = owner();
        const connectionId = sessionToolOperatorConnection(source.session, source.clientId);
        const captured = captureAgentLibraryAuthorization(connectionId);
        operation = captureAgentLibraryOperation(connectionId);
        const signal = AbortSignal.any([
          externalSignal,
          session.abortController.signal,
          operation.signal,
        ]);
        const current = () => {
          signal.throwIfAborted();
          operation!.assertCurrent();
          captured.assertCurrent();
          const next = owner();
          if (sessionToolOperatorConnection(next.session, next.clientId) !== connectionId)
            throw Error('Consultation operator changed');
        };
        await assertRuntimeCurrent();
        current();
        if (!['catalog', 'read'].includes(input.operation) && (!call?.turnId || !call.callId))
          throw Error('Verified current tool call required');
        if (
          ['authorize', 'consult', 'recover'].includes(input.operation) &&
          effectivePermissionMode(session) === 'ask'
        )
          throw Error('Ask mode cannot authorize or request specialist work');
        const service = getSpecialistConsultations();
        const authority = {
          leadSessionId: sessionId,
          operatorConnectionId: connectionId,
          auth: captured.auth,
          signal,
          assertCurrent: current,
        };
        stage = input.operation;
        let value: unknown;
        if (input.operation === 'catalog') value = await service.catalog(authority);
        else if (input.operation === 'authorize')
          value = await service.authorize(authority, input, async (display) => {
            const decision = await buildPermissionHandler(source.clientId, registry)(
              prefix + 'SymposiumConsult',
              display,
              {
                signal,
                toolUseID: call!.callId,
                forcePrompt: true,
                allowSessionGrant: false,
                rememberSessionGrant: false,
                approvalScope: 'request',
                title: 'Authorize bounded specialist consultation for this conversation?',
              },
            );
            current();
            return (
              decision.behavior === 'allow' && isDeepStrictEqual(decision.updatedInput, display)
            );
          });
        else if (input.operation === 'consult') {
          if (!input.policyId || !input.requestId || !input.role || !input.assignment)
            throw Error('Consult requires policyId, requestId, role and assignment');
          value = await service.consult(authority, input.policyId, {
            requestId: input.requestId,
            role: input.role,
            assignment: input.assignment,
            ...(input.messageIds !== undefined ? { messageIds: input.messageIds } : {}),
            ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
            ...(input.reviewOf !== undefined ? { reviewOf: input.reviewOf } : {}),
          });
        } else if (input.operation === 'revoke') {
          if (!input.policyId) throw Error('Revoke requires policyId');
          value = service.revoke(authority, input.policyId);
        } else {
          if (!input.requestId) throw Error('Read and Stop require the original requestId');
          value =
            input.operation === 'stop'
              ? await service.stop(authority, input.requestId)
              : input.operation === 'recover'
                ? await service.recover(authority, input.requestId)
                : service.read(authority, input.requestId);
        }
        current();
        const failed =
          value &&
          typeof value === 'object' &&
          'status' in value &&
          ['uncertain', 'failed'].includes(String(value.status));
        return { content: JSON.stringify(value), isError: !!failed };
      } catch (cause) {
        const diagnostic = specialistDiagnostic(cause);
        const cancelled =
          externalSignal.aborted ||
          session.abortController.signal.aborted ||
          operation?.signal.aborted === true;
        const details = {
          sessionId,
          requestId,
          callId: call?.callId,
          stage,
          code: diagnostic.code,
        };
        if (cancelled) log.info('Specialist tool request cancelled', details);
        else log.warn('Specialist tool request failed', { ...details, err: cause });
        return {
          content: JSON.stringify({
            error: diagnostic.code,
            stage,
            sessionId,
            requestId,
            message: diagnostic.message,
            cancelled,
          }),
          isError: true,
        };
      } finally {
        operation?.dispose();
      }
    },
  };
}
