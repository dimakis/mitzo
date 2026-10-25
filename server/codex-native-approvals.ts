import { isDeepStrictEqual } from 'node:util';
import type { CodexServerRequestContext } from './codex-app-server-client.js';
import {
  NativeApprovalRequestSchema,
  parseNativeApprovalResponse,
} from './codex-native-permission-protocol.js';
import { buildPermissionHandler } from './permission-handler.js';
import type { SessionRegistry } from './session-registry.js';
import { nativeGrantFence } from './codex-native-grant-fence.js';
import { PERMISSION_TIMEOUT_MS } from './constants.js';

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
    const deny = (cancel = false): Record<string, unknown> =>
      method === 'item/permissions/requestApproval'
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
    const parsed = NativeApprovalRequestSchema.safeParse({ method, id: context.requestId, params });
    if (!parsed.success) return deny();
    const request = parsed.data;
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
    const assertCurrent = () => {
      currentSignal.throwIfAborted();
      if (
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
        !isDeepStrictEqual(context.fileChangePaths, fileChangePaths) ||
        Date.now() >= expiresAt ||
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
        assertCurrent();
        assertGrantCurrent();
        assertPreparedCurrent();
      };
      context.registerResponseFence?.(finalFence);
      timer = setTimeout(() => expiry.abort(), Math.max(0, expiresAt - Date.now()));
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
            return parseNativeApprovalResponse(request.method, {
              permissions: Object.fromEntries(
                Object.entries(profile).filter(([, value]) => value !== null),
              ),
              scope: 'turn',
            });
          }
        }
      }
      const toolName =
        request.method === 'item/commandExecution/requestApproval'
          ? 'NativeCommandApproval'
          : request.method === 'item/fileChange/requestApproval'
            ? 'NativeFileApproval'
            : 'NativePermissionsApproval';
      // Generic JSON display preserves every parameter, including requested
      // filesystem scope and callback identity. Bash display would omit them.
      const input = {
        runtimeId,
        environmentId,
        requestId: identity.requestId,
        method: request.method,
        params: request.params,
        ...(request.method === 'item/fileChange/requestApproval' ? { fileChangePaths } : {}),
      };
      const result = await permission(toolName, input, {
        signal: currentSignal,
        toolUseID: JSON.stringify([
          runtimeId,
          identity.requestId,
          identity.threadId,
          identity.turnId,
          request.params.itemId,
        ]),
        title: 'Approve native execution boundary',
        description:
          'Automatic review is not yet qualified for this account and runtime. Human review is required for this exact pending operation and scope.',
        ...(request.method === 'item/permissions/requestApproval'
          ? {
              sessionGrantDescription:
                'This exact permission profile for the remainder of this native thread',
            }
          : {}),
        nativeApproval: {
          allowSessionScope: request.method === 'item/permissions/requestApproval',
          assertCurrentSync: () => {
            assertCurrent();
            assertGrantCurrent();
          },
        },
      });
      assertCurrent();
      assertGrantCurrent();
      if (result.behavior !== 'allow' || !isDeepStrictEqual(result.updatedInput, input))
        return deny();
      const response =
        request.method === 'item/permissions/requestApproval'
          ? {
              permissions: Object.fromEntries(
                Object.entries(request.params.permissions).filter(([, value]) => value !== null),
              ),
              scope: result.decisionClassification === 'user_permanent' ? 'session' : 'turn',
            }
          : { decision: 'accept' };
      return parseNativeApprovalResponse(request.method, response);
    } catch {
      return deny(currentSignal.aborted);
    } finally {
      clearTimeout(timer);
    }
  };
}
