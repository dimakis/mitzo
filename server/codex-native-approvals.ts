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

export interface CodexNativeApprovalContext extends CodexServerRequestContext {
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
  deniedRoots: readonly string[];
  writeProtectedRoots: readonly string[];
}) {
  const { clientId, registry, runtimeId, environmentId } = options;
  const deniedRoots = [...options.deniedRoots];
  const writeProtectedRoots = [...options.writeProtectedRoots];
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
      };
      context.registerResponseFence?.(finalFence);
      timer = setTimeout(() => expiry.abort(), Math.max(0, expiresAt - Date.now()));
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
          'Approve this exact pending operation and the displayed native permission scope.',
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
