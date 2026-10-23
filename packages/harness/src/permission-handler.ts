import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PermissionRequest, UserQuestion } from '@mitzo/protocol';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { registerPending, resolvePending, removePending, hasPending } from './permissions.js';
import { sendPermissionNotification, isConfigured as ntfyConfigured } from './notify.js';
import {
  sendPermissionNotification as pushoverSendPermission,
  isConfigured as pushoverConfigured,
} from './pushover.js';
import { getToolTier, isReadOnlyTool, shouldAutoAllow } from './tool-tiers.js';
import { sessionApprovalServer, summarizeToolInput } from '@mitzo/protocol';
import { checkSkillPolicy } from './skill-policy.js';
import { checkWorktreePolicy, type OnDemandCreateFn } from './worktree-guard.js';
import { PERMISSION_TIMEOUT_MS, NTFY_NOTIFICATION_DELAY_MS } from './constants.js';
import { effectivePermissionMode, type SessionRegistry } from './session-registry.js';
import type { SessionTransport } from './session-transport.js';

export const UserQuestionsSchema = z
  .array(
    z.object({
      question: z.string().min(1).max(4000),
      header: z.string().max(80).default('Question'),
      options: z
        .array(
          z.object({
            label: z.string().min(1).max(4000),
            description: z.string().max(4000).default(''),
          }),
        )
        .max(8)
        .default([]),
      multiSelect: z.boolean().default(false),
    }),
  )
  .min(1)
  .max(4)
  .refine((questions) => new Set(questions.map((q) => q.question)).size === questions.length);

export const PERMISSION_INPUT_MAX_CHARS = 10_000;

/** The exact representation sent in a permission card, before its size gate. */
export function serializePermissionDisplayInput(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  try {
    return toolName === 'Bash' && typeof input.command === 'string'
      ? input.command
      : JSON.stringify(input, null, 2);
  } catch {
    return undefined;
  }
}

export function permissionDisplayInput(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  // Summarize document bytes only; preserve the exact original input for approval/execution.
  if (
    (toolName === 'TelosSaveArtifact' || toolName === 'mcp__telos__TelosSaveArtifact') &&
    typeof input.content === 'string'
  ) {
    const { content, ...destination } = input;
    const display = JSON.stringify(
      {
        ...destination,
        contentBytes: Buffer.byteLength(content, 'utf8'),
        contentSha256: createHash('sha256').update(content).digest('hex'),
        contentPreview: content.slice(0, 1000),
        contentPreviewTruncated: content.length > 1000,
      },
      null,
      2,
    );
    return display.length <= PERMISSION_INPUT_MAX_CHARS ? display : undefined;
  }
  const full = serializePermissionDisplayInput(toolName, input);
  if (full === undefined) return undefined;
  return full.length <= PERMISSION_INPUT_MAX_CHARS ? full : undefined;
}

function transportSend(transport: SessionTransport, data: Record<string, unknown>): void {
  try {
    if (transport.isOpen()) transport.send(data);
  } catch {
    // A socket can close after isOpen(). Pending requests remain available
    // for reconnect replay; delivery failure must not reject tool resolution.
  }
}

function getMcpPrefix(toolName: string): string | null {
  const server = sessionApprovalServer(toolName);
  return server ? `mcp__${server}__` : null;
}

function addToAllowList(allowList: Set<string>, toolName: string): void {
  const mcpPrefix = getMcpPrefix(toolName);
  if (mcpPrefix) {
    allowList.add(mcpPrefix);
  } else {
    allowList.add(toolName);
  }
}

function isAllowListed(allowList: Set<string>, toolName: string): boolean {
  if (allowList.has(toolName)) return true;
  const mcpPrefix = getMcpPrefix(toolName);
  return mcpPrefix !== null && allowList.has(mcpPrefix);
}

interface PendingScopeApproval {
  acceptRetainedGrant(): Promise<void>;
}
const pendingScopeApprovals = new WeakMap<object, Map<string, Set<PendingScopeApproval>>>();
function trackScopeApproval(
  session: object,
  key: string,
  approval: PendingScopeApproval,
): () => void {
  let scopes = pendingScopeApprovals.get(session);
  if (!scopes) pendingScopeApprovals.set(session, (scopes = new Map()));
  let approvals = scopes.get(key);
  if (!approvals) scopes.set(key, (approvals = new Set()));
  approvals.add(approval);
  return () => {
    approvals.delete(approval);
    if (!approvals.size) scopes.delete(key);
  };
}

interface PermissionDecisionObservation {
  readonly permId: string;
  readonly toolUseID: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly inputSha256: string;
  readonly approvalScope: 'request';
  readonly decisionClassification: 'user_temporary';
  readonly expiresAt: number;
}

/** Lossless bounded plain JSON only: never invoke caller getters or toJSON. */
function snapshotDecisionInput(input: Record<string, unknown>) {
  let remaining = PERMISSION_INPUT_MAX_CHARS;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 64) throw Error('Input exceeds review bounds');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length <= PERMISSION_INPUT_MAX_CHARS) return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value))
      throw Error('Invalid JSON input');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype))
      throw Error('Input must contain plain JSON values');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
    if (array && keys.length !== value.length) throw Error('Sparse or extended JSON array');
    ancestors.add(value);
    const entries = keys.map((key, index) => {
      if (typeof key !== 'string' || (array && key !== String(index)))
        throw Error('Invalid JSON key');
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw Error('Invalid JSON property');
      return [key, copy(descriptor.value, depth + 1)] as const;
    });
    ancestors.delete(value);
    return Object.freeze(array ? entries.map(([, entry]) => entry) : Object.fromEntries(entries));
  };
  const snapshot = copy(input, 0) as Readonly<Record<string, unknown>>;
  const serialized = JSON.stringify(snapshot);
  const display = JSON.stringify(snapshot, null, 2);
  if (display.length > PERMISSION_INPUT_MAX_CHARS) throw Error('Input exceeds review bounds');
  return {
    input: snapshot,
    serialized,
    display,
    sha256: createHash('sha256').update(serialized).digest('hex'),
  };
}

export interface PermissionHandlerOptions {
  onDemandCreate?: OnDemandCreateFn;
}

export function buildPermissionHandler(
  clientId: string,
  registry: SessionRegistry,
  handlerOpts?: PermissionHandlerOptions,
) {
  return async (
    toolName: string,
    _toolInput: Record<string, unknown>,
    opts: {
      signal: AbortSignal;
      toolUseID: string;
      title?: string;
      displayName?: string;
      description?: string;
      decisionReason?: string;
      /** Bypass mode/tier auto-approval for an exact action or policy gate. */
      forcePrompt?: boolean;
      /** Allow a forced prompt to honor an explicit session-wide grant. */
      allowSessionGrant?: boolean;
      /** Server-owned operation/service identity; never taken from a permission response. */
      sessionGrantKey?: string;
      /** Plain description of the retained scope shown with the session choice. */
      sessionGrantDescription?: string;
      /** The caller may store a narrower account-bound consent instead of a tool-wide grant. */
      rememberSessionGrant?: boolean;
      approvalScope?: 'session' | 'conversation' | 'request';
      /** Private synchronous observation of a final explicit request approval. */
      onDecision?: (decision: PermissionDecisionObservation) => void;
      /**
       * A server-owned control-plane approval (for example, attaching a
       * reviewed integration) may bypass a skill's model-tool ceiling. It
       * still observes mode, worktree, and explicit approval checks.
       */
      controlPlane?: boolean;
      /** Provider adapter supplies validated questions, preserving provider IDs. */
      questions?: UserQuestion[];
      /** Private original native scope, never permission response or tool JSON. */
      nativeSourceScope?: { readonly operatorId: string; assertCurrentSync(): void };
    },
  ): Promise<PermissionResult> => {
    const session = registry.get(clientId);
    if (!session) return { behavior: 'deny', message: 'Session not found' };
    const telosReview = [
      'TelosCreateOutcome',
      'mcp__telos__TelosCreateOutcome',
      'TelosAdoptSource',
      'mcp__telos__TelosAdoptSource',
    ].includes(toolName);
    const onDecision = opts.onDecision;
    const originalInput = _toolInput;
    const originalSignal = opts.signal;
    const originalToolUseID = opts.toolUseID;
    const originalControlPlane = opts.controlPlane;
    const originalSessionId = session.sessionId;
    let decisionInput: ReturnType<typeof snapshotDecisionInput> | undefined;
    const observationOptionsCurrent = () =>
      opts.onDecision === onDecision &&
      opts.signal === originalSignal &&
      opts.toolUseID === originalToolUseID &&
      opts.controlPlane === originalControlPlane &&
      session.sessionId === originalSessionId &&
      opts.forcePrompt === true &&
      opts.allowSessionGrant === false &&
      opts.rememberSessionGrant === false &&
      opts.approvalScope === 'request' &&
      !opts.questions &&
      !telosReview &&
      !toolName.startsWith('Telos') &&
      !toolName.startsWith('mcp__telos__') &&
      toolName !== 'AskUserQuestion' &&
      !handlerOpts?.onDemandCreate &&
      typeof originalSessionId === 'string' &&
      !!originalSessionId.trim() &&
      typeof originalToolUseID === 'string' &&
      !!originalToolUseID.trim();
    const observationCurrent = () => {
      if (!onDecision) return true;
      try {
        return (
          observationOptionsCurrent() &&
          snapshotDecisionInput(originalInput).serialized === decisionInput?.serialized
        );
      } catch {
        return false;
      }
    };
    if (onDecision !== undefined) {
      if (typeof onDecision !== 'function' || !observationOptionsCurrent())
        return {
          behavior: 'deny',
          message: 'Decision observation requires an explicit one-shot request',
        };
      try {
        decisionInput = snapshotDecisionInput(originalInput);
        _toolInput = decisionInput.input;
      } catch {
        return { behavior: 'deny', message: 'Exact decision input is unavailable for review' };
      }
    }
    const nativeScope = opts.nativeSourceScope;
    const nativeOperatorId = nativeScope?.operatorId;
    const nativeAssertion = nativeScope?.assertCurrentSync;
    const nativeScopeCurrent = () => {
      if (!nativeScope) return true;
      try {
        if (
          !telosReview ||
          typeof nativeOperatorId !== 'string' ||
          !nativeOperatorId.trim() ||
          nativeScope.operatorId !== nativeOperatorId ||
          typeof nativeAssertion !== 'function' ||
          nativeScope.assertCurrentSync !== nativeAssertion
        )
          return false;
        const result: unknown = nativeAssertion.call(nativeScope);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          return false;
        }
        return true;
      } catch {
        return false;
      }
    };
    if (!nativeScopeCurrent())
      return { behavior: 'deny', message: 'Original native source scope is unavailable' };
    if (telosReview) {
      opts = {
        ...opts,
        forcePrompt: true,
        allowSessionGrant: false,
        rememberSessionGrant: false,
        approvalScope: 'request',
      };
      if (
        !session.sessionId ||
        !opts.toolUseID ||
        Object.hasOwn(_toolInput, '__mitzoTelosApproval')
      )
        return {
          behavior: 'deny',
          message:
            'A registered conversation and fresh host invocation are required for reviewed Telos capture.',
        };
    }
    const currentClientId = (): string | undefined => {
      if (!session.sessionId) return registry.get(clientId) === session ? clientId : undefined;
      const owner = registry.findBySessionId(session.sessionId, true);
      return owner?.session === session ? owner.clientId : undefined;
    };
    const grantKey = opts.sessionGrantKey ?? getMcpPrefix(toolName) ?? toolName;

    // Skill restrictions are checked FIRST — a safe-tier tool not in the
    // skill's allowed-tools list must be denied even if shouldAutoAllow
    // would normally permit it.
    if (!opts.controlPlane && checkSkillPolicy(registry, clientId, toolName) === 'deny') {
      return { behavior: 'deny', message: 'Tool not allowed by active skill policy' };
    }

    let questions: UserQuestion[] | undefined = opts.questions;
    if (!questions && toolName === 'AskUserQuestion') {
      const parsed = UserQuestionsSchema.safeParse(_toolInput.questions);
      if (!parsed.success)
        return {
          behavior: 'deny',
          message: 'Invalid user questions. Ask up to four distinct questions.',
        };
      questions = parsed.data.map((question) => ({ id: question.question, ...question }));
    }

    // Ask is a harness-enforced ceiling, including cached grants and providers
    // without a native read-only mode. Check before any on-demand worktree write.
    const askDenial = (): PermissionResult | undefined =>
      !questions && effectivePermissionMode(session) === 'ask' && !isReadOnlyTool(toolName)
        ? {
            behavior: 'deny',
            message:
              'Ask mode only allows read-only tools. Switch to Agent or Auto to make changes.',
          }
        : undefined;
    const deniedByMode = askDenial();
    if (deniedByMode) return deniedByMode;

    const worktreeViolation = await checkWorktreePolicy(session, toolName, _toolInput, {
      onDemandCreate: handlerOpts?.onDemandCreate,
    });
    if (worktreeViolation) {
      return { behavior: 'deny', message: worktreeViolation };
    }

    // The mode may have changed while the worktree check was awaiting I/O.
    const deniedAfterWorktree = askDenial();
    if (deniedAfterWorktree) return deniedAfterWorktree;
    if (!observationCurrent())
      return { behavior: 'deny', message: 'Original approval input or invocation changed' };

    if (
      !questions &&
      !opts.forcePrompt &&
      shouldAutoAllow(toolName, effectivePermissionMode(session))
    ) {
      return { behavior: 'allow', updatedInput: _toolInput };
    }

    // A user session grant satisfies a forced ask prompt, while mode, skill and
    // workspace checks still run first. Scoped adapters must supply their own key.
    if (
      !questions &&
      opts.allowSessionGrant !== false &&
      (opts.sessionGrantKey
        ? session.sessionAllowList.has(opts.sessionGrantKey)
        : isAllowListed(session.sessionAllowList, toolName))
    ) {
      return {
        behavior: 'allow',
        decisionClassification: 'user_permanent',
        updatedInput: _toolInput,
      };
    }

    const displayInput = decisionInput
      ? decisionInput.display
      : questions
        ? ''
        : telosReview
          ? JSON.stringify(
              {
                operation: toolName,
                summary: _toolInput.summary ?? null,
                itemId: _toolInput.itemId ?? null,
                proposalSha256: createHash('sha256')
                  .update(JSON.stringify(_toolInput))
                  .digest('hex'),
                review:
                  'Review the complete host proposal and select its original exchange before saving.',
              },
              null,
              2,
            )
          : permissionDisplayInput(toolName, _toolInput);
    if (displayInput === undefined)
      return {
        behavior: 'deny',
        message: 'Tool input is too large to review safely. Split it into smaller operations.',
      };
    const inputSummary = summarizeToolInput(toolName, _toolInput);
    const tier = getToolTier(toolName);
    const permId = telosReview
      ? 'perm-telos-' +
        createHash('sha256')
          .update(JSON.stringify([session.sessionId, toolName, opts.toolUseID]))
          .digest('hex')
      : `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (telosReview && hasPending(permId))
      return {
        behavior: 'deny',
        message:
          'This exact Telos source approval is already pending. Use its existing review card.',
      };

    return new Promise<PermissionResult>((resolve) => {
      if (originalSignal.aborted || !nativeScopeCurrent()) {
        resolve({ behavior: 'deny', message: 'Aborted' });
        return;
      }

      let settled = false;
      let settledResult: PermissionResult;
      let resolutionEvent = 'permission_resolved';
      let untrackScope = () => {};
      let notificationTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
      // Shared pre/post-observer fence; callbacks cannot make a checked allow stale.
      const revalidateAllow = (result: PermissionResult): PermissionResult => {
        if (result.behavior !== 'allow') return result;
        const activeClient = currentClientId();
        const modeDenial = askDenial();
        if (!nativeScopeCurrent())
          return { behavior: 'deny', message: 'Original native source scope changed' };
        if (!activeClient)
          return { behavior: 'deny', message: 'Session permissions changed; retry the tool' };
        if (modeDenial) return modeDenial;
        if (!opts.controlPlane && checkSkillPolicy(registry, activeClient, toolName) === 'deny')
          return { behavior: 'deny', message: 'Tool not allowed by active skill policy' };
        if (onDecision) {
          try {
            if (
              !observationCurrent() ||
              result.decisionClassification !== 'user_temporary' ||
              !decisionInput ||
              snapshotDecisionInput(result.updatedInput ?? {}).serialized !==
                decisionInput.serialized ||
              originalSignal.aborted ||
              request.expiresAt! <= Date.now()
            )
              throw Error('Original one-shot decision is no longer current');
          } catch {
            return {
              behavior: 'deny',
              message: 'Original one-shot approval changed; reconcile before retrying',
            };
          }
        }
        return result;
      };
      const wrappedResolve = (result: PermissionResult) => {
        if (settled) return settledResult;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(notificationTimer);
        originalSignal.removeEventListener('abort', onAbort);
        untrackScope();
        result = revalidateAllow(result);
        if (onDecision && result.behavior === 'allow') {
          try {
            if (!decisionInput) throw Error('Exact approval input is unavailable');
            const returned: unknown = onDecision(
              Object.freeze({
                permId,
                toolUseID: originalToolUseID,
                sessionId: originalSessionId!,
                toolName,
                input: decisionInput.input,
                inputSha256: decisionInput.sha256,
                approvalScope: 'request' as const,
                decisionClassification: 'user_temporary' as const,
                expiresAt: request.expiresAt!,
              }),
            );
            if (returned !== undefined) {
              void Promise.resolve(returned).catch(() => {});
              throw Error('Decision observer must finish synchronously');
            }
          } catch {
            // A producer may already have persisted its existing approval row.
            // Deny here; retain that producer-owned evidence for reconciliation.
            result = {
              behavior: 'deny',
              message: 'Explicit approval observation failed; reconcile before retrying',
            };
          }
        }
        // Observation may have committed evidence and then changed current policy.
        // Keep that evidence for reconciliation; never allow its source effects here.
        if (onDecision) result = revalidateAllow(result);
        settledResult = result;
        if (
          opts.allowSessionGrant !== false &&
          opts.rememberSessionGrant !== false &&
          result.behavior === 'allow' &&
          result.decisionClassification === 'user_permanent'
        ) {
          if (opts.sessionGrantKey) session.sessionAllowList.add(opts.sessionGrantKey);
          else addToAllowList(session.sessionAllowList, toolName);
          for (const pending of pendingScopeApprovals.get(session)?.get(grantKey) ?? [])
            void pending.acceptRetainedGrant();
        }
        const resolved = { type: resolutionEvent, permId, sessionId: session.sessionId };
        for (const transport of registry.getPermissionTransports(session))
          transportSend(transport, resolved);
        resolve(result);
        return result;
      };

      const onAbort = () => {
        if (hasPending(permId)) {
          resolutionEvent = 'permission_timeout';
          removePending(permId);
          wrappedResolve({
            behavior: 'deny',
            message: 'Tool approval cancelled because the operation was aborted',
          });
        }
      };
      originalSignal.addEventListener('abort', onAbort, { once: true });

      const approvalScope =
        opts.approvalScope ?? (opts.allowSessionGrant === false ? 'request' : 'session');
      const request: PermissionRequest = {
        ...(telosReview ? { reviewKind: 'telos_source' as const } : {}),
        permId,
        toolName,
        toolInput: displayInput,
        title: opts.title,
        description: opts.description,
        displayName: opts.displayName,
        tier,
        approvalScope,
        // Explicit retained scopes can belong to the caller rather than this
        // handler's generic allow list (web search, URL access, publication).
        ...(opts.allowSessionGrant === false && approvalScope === 'request'
          ? { allowSessionGrant: false }
          : {}),
        ...(opts.sessionGrantDescription
          ? { sessionGrantDescription: opts.sessionGrantDescription }
          : {}),
        sessionId: session.sessionId,
        expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
        ...(questions ? { questions } : {}),
      };
      registerPending(
        permId,
        toolName,
        wrappedResolve,
        _toolInput,
        tier,
        session.sessionId,
        request,
        telosReview
          ? {
              toolUseId: opts.toolUseID,
              ...(nativeScope ? { operatorId: nativeOperatorId } : {}),
              canApprove: () =>
                nativeScopeCurrent() &&
                !originalSignal.aborted &&
                !!currentClientId() &&
                !askDenial() &&
                (opts.controlPlane ||
                  checkSkillPolicy(registry, currentClientId()!, toolName) !== 'deny'),
            }
          : undefined,
      );

      // Lifecycle listeners may resolve synchronously during registration.
      if (settled) return;

      if (ntfyConfigured() || pushoverConfigured()) {
        notificationTimer = setTimeout(() => {
          if (hasPending(permId)) {
            if (ntfyConfigured())
              sendPermissionNotification(toolName, inputSummary, permId, session.sessionId);
            if (pushoverConfigured())
              pushoverSendPermission(toolName, inputSummary, permId, session.sessionId);
          }
        }, NTFY_NOTIFICATION_DELAY_MS);
      }

      timeout = setTimeout(() => {
        if (hasPending(permId)) {
          resolutionEvent = 'permission_timeout';
          removePending(permId);
          wrappedResolve({
            behavior: 'deny',
            message: 'Tool approval expired without a response; request approval again',
          });
        }
      }, PERMISSION_TIMEOUT_MS);
      if (!questions && opts.allowSessionGrant !== false && opts.rememberSessionGrant !== false) {
        let accepting = false;
        untrackScope = trackScopeApproval(session, grantKey, {
          async acceptRetainedGrant() {
            if (accepting) return;
            accepting = true;
            try {
              if (!hasPending(permId) || !session.sessionAllowList.has(grantKey)) return;
              if (request.expiresAt! <= Date.now()) {
                resolvePending(permId, 'always', undefined, session.sessionId);
                return;
              }
              const workspaceSnapshot = () =>
                JSON.stringify(
                  [...session.worktreePaths.entries()]
                    .map(([name, worktree]) => [name, worktree.path, worktree.wtId])
                    .sort(([left], [right]) => left!.localeCompare(right!)),
                );
              const checkedWorkspace = workspaceSnapshot();
              const violation = await checkWorktreePolicy(session, toolName, _toolInput);
              const workspaceChanged = checkedWorkspace !== workspaceSnapshot();
              if (!hasPending(permId)) return;
              if (violation || workspaceChanged || !currentClientId()) {
                resolvePending(
                  permId,
                  'deny',
                  undefined,
                  session.sessionId,
                  violation ?? 'Session permissions changed; retry the tool',
                );
              } else if (session.sessionAllowList.has(grantKey)) {
                resolvePending(permId, 'always', undefined, session.sessionId);
              }
            } catch {
              if (hasPending(permId)) {
                resolvePending(
                  permId,
                  'deny',
                  undefined,
                  session.sessionId,
                  'Permission revalidation failed; retry the tool',
                );
              }
            }
          },
        });
      }
      const event = { type: 'permission_request', ...request };
      for (const transport of registry.getPermissionTransports(session))
        transportSend(transport, event);
    });
  };
}
