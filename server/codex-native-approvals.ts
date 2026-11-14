import { isDeepStrictEqual } from 'node:util';
import { toolFailure, type ToolFailure } from '@mitzo/protocol';
import type { CodexServerRequestContext } from './codex-app-server-client.js';
import {
  NativeApprovalRequestSchema,
  parseNativeApprovalResponse,
} from './codex-native-permission-protocol.js';
import { buildPermissionHandler } from './permission-handler.js';
import { ApprovalExpiredError } from '@mitzo/harness';
import type { SessionRegistry } from './session-registry.js';
import { nativeGrantFence } from './codex-native-grant-fence.js';
import { PERMISSION_TIMEOUT_MS } from './constants.js';
import {
  checkSkillPolicy,
  effectivePermissionMode,
  recordPermissionAudit,
  githubCommandConsentDescription,
} from '@mitzo/harness';
import {
  nativeCommandApprovalScope,
  nativeGithubReadCommand,
} from './codex-native-approval-scope.js';
import { createLogger } from './logger.js';
import {
  captureNativeDevelopmentGrant,
  isNativeGwsBrokerEscalation,
} from './native-development-grant.js';
const log = createLogger('codex-native-approvals');

export interface PreparedWorkspaceGrantScope {
  readonly runtimeId: string;
  readonly environmentId: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly requestId: string | number;
  readonly itemId: string;
  readonly root: string;
}
export interface PreparedWorkspaceGrant {
  /** Existing preparation/authorization owner's receipt; never newly invented here. */
  readonly receiptId: string;
  /** Fresh current native request/active-command proof which revalidates the
   * retained immutable completed Prepare proof for prior operator/target/storage
   * WRITE authorization, reservation, and exact canonical root identity. Never
   * call the expired Prepare invocation's live closure. A prepared row, accepted
   * prompt or model-selected path alone confers no such authority. */
  assertCurrentSync(): void;
}
/** Existing authority only; this is neither automatic review nor a new model
 * approval loop. Undefined uses human review and a failed proof denies. */
export type ApprovePreparedWorkspaceGrant = (
  scope: Readonly<PreparedWorkspaceGrantScope>,
) => Promise<PreparedWorkspaceGrant | undefined>;

export interface CodexNativeApprovalContext extends CodexServerRequestContext {
  /** Original command observer, never supplied by the provider. */
  observeFailure?(failure: ToolFailure): void;
  readonly subagentName?: string;
  readonly commandId?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly fileChangePaths?: readonly string[];
  /** Existing runtime/account/turn owner; never derived from provider parameters. */
  assertCurrentSync(): void;
}

/** Reuse Mitzo's pending owner for human fallback. Upstream owns execution and
 * consumes this exact RPC reply; returning a permissions overlay changes its
 * native sandbox, rather than changing a separate Mitzo tool allow list.
 * Automatic review, when qualified, runs upstream before this fallback.
 */
export function createCodexNativeApprovalHandler(options: {
  clientId: string;
  registry: SessionRegistry;
  runtimeId: string;
  environmentId: string;
  policyRevision?: string;
  timeoutMs?: number;
  approvePreparedWorkspaceGrant?: ApprovePreparedWorkspaceGrant;
  deniedRoots: readonly string[];
  writeProtectedRoots: readonly string[];
}) {
  const { clientId, registry, runtimeId, environmentId } = options;
  const deniedRoots = [...options.deniedRoots];
  const writeProtectedRoots = [...options.writeProtectedRoots];
  const approvePreparedWorkspaceGrant = options.approvePreparedWorkspaceGrant;
  const timeoutMs = options.timeoutMs ?? PERMISSION_TIMEOUT_MS;
  if (!runtimeId.trim() || !environmentId.trim() || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw Error('Invalid native approval owner');
  const permission = buildPermissionHandler(clientId, registry);
  return async (
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    context: CodexNativeApprovalContext,
  ): Promise<Record<string, unknown>> => {
    let returningDenial = false;
    let preExecutionOperation = false;
    let validOperation = false;
    let explicitDenial = false;
    let expiryObserved = false;
    let grantResponse: Record<string, unknown> | undefined;
    const grant = (response: Record<string, unknown>) => {
      grantResponse = parseNativeApprovalResponse(method, response);
      return grantResponse;
    };
    const deny = (cancel = false): Record<string, unknown> => {
      returningDenial = true;
      if (validOperation) {
        try {
          context.observeFailure?.(
            toolFailure(
              signal.aborted || cancel
                ? 'cancelled'
                : explicitDenial
                  ? 'permission_denied'
                  : expiryObserved || Date.now() >= Number(params.startedAtMs) + timeoutMs
                    ? 'approval_expired'
                    : 'permission_denied',
              'approval',
              preExecutionOperation ? 'not_started' : 'unknown',
            ),
          );
        } catch {
          /* Missing observation cannot grant permission or certify recovery. */
        }
      }
      return method === 'item/permissions/requestApproval'
        ? { permissions: {}, scope: 'turn' }
        : {
            decision:
              cancel ||
              (method === 'item/commandExecution/requestApproval' &&
                Array.isArray(params.availableDecisions) &&
                !params.availableDecisions.includes('decline') &&
                params.availableDecisions.includes('cancel'))
                ? 'cancel'
                : 'decline',
          };
    };
    const parsed = NativeApprovalRequestSchema.safeParse({ method, id: context.requestId, params });
    if (!parsed.success) return deny();
    const request = parsed.data;
    validOperation = true;
    preExecutionOperation = request.method !== 'item/commandExecution/requestApproval';
    if (request.method === 'item/commandExecution/requestApproval') {
      // Subcommand and managed-network callbacks can occur after earlier effects
      // within this same parent item; declining this callback proves no rollback.
      preExecutionOperation =
        request.params.kind === 'command' &&
        request.params.approvalId == null &&
        request.params.networkApprovalContext == null;
    }
    const session = registry.get(clientId);
    if (!session) return deny();
    const mode = effectivePermissionMode(session);
    const cwd = session.cwd;
    const toolName =
      request.method === 'item/commandExecution/requestApproval'
        ? 'NativeCommandApproval'
        : request.method === 'item/fileChange/requestApproval'
          ? 'NativeFileApproval'
          : 'NativePermissionsApproval';
    const identity = {
      requestId: context.requestId,
      commandId: context.commandId,
      threadId: context.threadId,
      turnId: context.turnId,
    };
    const fileChangePaths = context.fileChangePaths ? [...context.fileChangePaths] : undefined;
    const assertOwner = context.assertCurrentSync;
    const expiresAt = request.params.startedAtMs + timeoutMs;
    const expiry = new AbortController();
    const currentSignal = AbortSignal.any([signal, expiry.signal]);
    const assertCurrent = (allowExpired = false) => {
      (allowExpired ? signal : currentSignal).throwIfAborted();
      const owner = session.sessionId
        ? registry.findBySessionId(session.sessionId, true)
        : undefined;
      const activeClient =
        owner?.session === session
          ? owner.clientId
          : !session.sessionId && registry.get(clientId) === session
            ? clientId
            : undefined;
      if (
        !activeClient ||
        (!returningDenial && checkSkillPolicy(registry, activeClient, toolName) === 'deny') ||
        !request.params.itemId.trim() ||
        !identity.threadId.trim() ||
        !identity.turnId.trim() ||
        request.params.threadId !== identity.threadId ||
        request.params.turnId !== identity.turnId ||
        context.requestId !== identity.requestId ||
        context.commandId !== identity.commandId ||
        context.threadId !== identity.threadId ||
        context.turnId !== identity.turnId ||
        context.assertCurrentSync !== assertOwner ||
        effectivePermissionMode(session) !== mode ||
        session.cwd !== cwd ||
        !isDeepStrictEqual(context.fileChangePaths, fileChangePaths) ||
        (!allowExpired && Date.now() >= expiresAt) ||
        request.params.startedAtMs > Date.now() + 30_000
      )
        throw Error('Native approval is no longer current');
      const result: unknown = assertOwner.call(context);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw Error('Native approval requires synchronous ownership');
      }
    };
    let assertGrantCurrent = () => {};
    let assertPreparedCurrent = () => {};
    let assertConsentCurrent = () => {};
    let assertCommandCurrent = () => {};
    let sessionGrantKey: string | undefined;
    const toolUseID = JSON.stringify([
      runtimeId,
      identity.requestId,
      identity.threadId,
      identity.turnId,
      request.params.itemId,
    ]);
    let deliveryRefused = false;
    const recordDeliveryRefusal = (error: unknown) => {
      if (deliveryRefused) return;
      deliveryRefused = true;
      recordPermissionAudit({
        phase: 'delivery',
        time: Date.now(),
        sessionId: session.sessionId,
        toolName,
        toolUseID,
        scopeHash: sessionGrantKey,
        outcome: signal.aborted
          ? 'cancelled'
          : expiryObserved || Date.now() >= expiresAt
            ? 'expired'
            : 'denied',
      });
      log.warn('Native approval refused during validation or RPC delivery', {
        runtimeId,
        environmentId,
        method,
        requestId: identity.requestId,
        threadId: identity.threadId,
        cancelled: signal.aborted,
        expired: expiryObserved || Date.now() >= expiresAt,
        cause: error instanceof Error ? error.message : 'non-Error validation failure',
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assertCurrent();
      // Remote environments have their own execution owner. grantRoot is
      // unstable in this pin and cannot establish an enforced filesystem grant.
      if (
        ('environmentId' in request.params && request.params.environmentId !== environmentId) ||
        (request.method === 'item/fileChange/requestApproval' && request.params.grantRoot)
      )
        return deny();
      if (
        request.method === 'item/commandExecution/requestApproval' &&
        ((!request.params.command?.trim() && !request.params.networkApprovalContext?.host.trim()) ||
          (request.params.kind === 'writeStdin' &&
            (!request.params.command?.trim() || !request.params.approvalId?.trim())) ||
          (request.params.availableDecisions &&
            !request.params.availableDecisions.includes('accept')))
      )
        return deny();
      assertGrantCurrent = nativeGrantFence(
        request,
        deniedRoots,
        writeProtectedRoots,
        fileChangePaths,
      );
      const finalFence = () => {
        try {
          // Check every non-expiry authority even if validation crossed the
          // deadline. Revocation/cancellation/path failures must still close.
          assertCurrent(true);
          assertGrantCurrent();
          assertPreparedCurrent();
          assertCommandCurrent();
          if (!returningDenial) assertConsentCurrent();
          // These synchronous checks can themselves consume the remaining time.
          // Downgrade the exact response object held by the original RPC client;
          // expiry alone authorizes only refusal, never a stale grant or retry.
          if (!returningDenial && Date.now() >= expiresAt && grantResponse) {
            recordDeliveryRefusal(Error('Native approval expired before RPC delivery'));
            Object.assign(grantResponse, deny(signal.aborted));
          }
        } catch (error) {
          recordDeliveryRefusal(error);
          throw error;
        }
      };
      context.registerResponseFence?.(finalFence);
      timer = setTimeout(
        () => {
          // Timers and wall-clock reads can disagree at the deadline (or after a
          // clock correction). Retain the observed timeout as the refusal cause.
          expiryObserved = true;
          expiry.abort(new ApprovalExpiredError());
        },
        Math.max(0, expiresAt - Date.now()),
      );
      if (isNativeGwsBrokerEscalation(request)) {
        assertCurrent();
        assertGrantCurrent();
        return grant({ decision: 'accept' });
      }
      const developmentGrant = captureNativeDevelopmentGrant(session, request);
      if (developmentGrant) {
        assertConsentCurrent = developmentGrant;
        assertCurrent();
        assertGrantCurrent();
        assertConsentCurrent();
        return grant({ decision: 'accept' });
      }
      if (
        request.method === 'item/permissions/requestApproval' &&
        approvePreparedWorkspaceGrant &&
        identity.commandId
      ) {
        const profile = request.params.permissions;
        const files = profile.fileSystem;
        if (
          profile.network === null &&
          files &&
          !files.read?.length &&
          files.write?.length === 1 &&
          !files.entries?.length
        ) {
          const scope = Object.freeze({
            runtimeId,
            environmentId,
            commandId: identity.commandId,
            threadId: identity.threadId,
            turnId: identity.turnId,
            requestId: identity.requestId,
            itemId: request.params.itemId,
            root: files.write[0],
          });
          let onAbort = () => {};
          let proof: PreparedWorkspaceGrant | undefined;
          try {
            proof = await Promise.race([
              Promise.resolve().then(() => {
                assertCurrent();
                assertGrantCurrent();
                return approvePreparedWorkspaceGrant(scope);
              }),
              new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(currentSignal.reason);
                currentSignal.addEventListener('abort', onAbort, { once: true });
                if (currentSignal.aborted) onAbort();
              }),
            ]);
          } finally {
            currentSignal.removeEventListener('abort', onAbort);
          }
          assertCurrent();
          assertGrantCurrent();
          if (proof) {
            const receipt = proof;
            const receiptId = receipt.receiptId;
            const assertReceipt = receipt.assertCurrentSync;
            assertPreparedCurrent = () => {
              if (
                typeof receiptId !== 'string' ||
                !receiptId.trim() ||
                receipt.receiptId !== receiptId ||
                typeof assertReceipt !== 'function' ||
                receipt.assertCurrentSync !== assertReceipt
              )
                throw Error('Prepared workspace receipt unavailable');
              const result: unknown = assertReceipt.call(receipt);
              if (result !== undefined) {
                void Promise.resolve(result).catch(() => {});
                throw Error('Prepared workspace receipt requires synchronous ownership');
              }
            };
            assertPreparedCurrent();
            return grant({
              permissions: Object.fromEntries(
                Object.entries(profile).filter(([, value]) => value !== null),
              ),
              scope: 'turn',
            });
          }
        }
      }
      // Generic JSON display preserves every parameter, including requested
      // filesystem scope and callback identity. Bash display would omit them.
      const input = {
        runtimeId,
        ...(context.subagentName ? { subagent: context.subagentName } : {}),
        environmentId,
        requestId: identity.requestId,
        method: request.method,
        params: request.params,
        ...(request.method === 'item/fileChange/requestApproval' ? { fileChangePaths } : {}),
      };
      const commandOwner = {
        runtimeId,
        environmentId,
        policyRevision: options.policyRevision,
        mode,
        cwd,
        deniedRoots,
        writeProtectedRoots,
      };
      sessionGrantKey = nativeCommandApprovalScope(request, commandOwner);
      if (sessionGrantKey)
        assertCommandCurrent = () => {
          if (nativeCommandApprovalScope(request, commandOwner) !== sessionGrantKey)
            throw Error('Native command directory changed during approval');
        };
      const commandRequest = request.method === 'item/commandExecution/requestApproval';
      const githubRepository =
        commandRequest && request.params.command
          ? nativeGithubReadCommand(request.params.command)?.repository
          : undefined;
      const network = commandRequest && request.params.additionalPermissions?.network?.enabled;
      const result = await permission(toolName, input, {
        signal: currentSignal,
        toolUseID,
        title:
          (context.subagentName ? `Subagent ${context.subagentName} · ` : '') +
          (commandRequest
            ? request.params.networkApprovalContext
              ? `Connect to ${request.params.networkApprovalContext.host}`
              : network
                ? 'Run command with network access'
                : 'Run local command'
            : request.method === 'item/fileChange/requestApproval'
              ? 'Apply file changes'
              : 'Allow requested access'),
        description:
          'Review the displayed operation, working directory and requested access. Existing workspace and credential protections still apply. Approval that expires during validation is refused without granting permission.',
        ...(sessionGrantKey
          ? {
              sessionGrantDescription: githubRepository
                ? githubCommandConsentDescription(githubRepository)
                : 'Allow for session repeats this exact command with the displayed access in this directory until this native thread ends. Changed commands or access require another approval.',
            }
          : {}),
        ...(request.method === 'item/permissions/requestApproval'
          ? {
              sessionGrantDescription:
                'This exact permission profile for the remainder of this native thread',
            }
          : {}),
        nativeApproval: {
          expiresAt,
          onExpiry: () => {
            expiryObserved = true;
          },
          allowSessionScope:
            request.method === 'item/permissions/requestApproval' || sessionGrantKey !== undefined,
          sessionGrantKey,
          assertCurrentSync: () => {
            assertCurrent();
            assertGrantCurrent();
            assertCommandCurrent();
          },
        },
      });
      // Preserve an actual user rejection even if resumption crosses expiry.
      explicitDenial =
        result.behavior === 'deny' && result.decisionClassification === 'user_reject';
      assertCurrent();
      assertGrantCurrent();
      assertCommandCurrent();
      if (result.behavior !== 'allow' || !isDeepStrictEqual(result.updatedInput, input))
        return deny();
      if (sessionGrantKey && result.decisionClassification === 'user_permanent') {
        const consentKey = sessionGrantKey;
        assertConsentCurrent = () => {
          if (!session.sessionAllowList.has(consentKey))
            throw Error('Native command consent was revoked');
        };
        assertConsentCurrent();
      }
      const response =
        request.method === 'item/permissions/requestApproval'
          ? {
              permissions: Object.fromEntries(
                Object.entries(request.params.permissions).filter(([, value]) => value !== null),
              ),
              scope: result.decisionClassification === 'user_permanent' ? 'session' : 'turn',
            }
          : { decision: 'accept' };
      return grant(response);
    } catch (error) {
      // Expiry denies this operation; only the owning operation's abort cancels
      // the turn. Offers without decline still use their supported cancel reply.
      recordDeliveryRefusal(error);
      return deny(signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  };
}
