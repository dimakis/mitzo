import { z } from 'zod';
import type { PermissionRequest, UserQuestion } from '@mitzo/protocol';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { registerPending, resolvePending, hasPending } from './permissions.js';
import { sendPermissionNotification, isConfigured as ntfyConfigured } from './notify.js';
import {
  sendPermissionNotification as pushoverSendPermission,
  isConfigured as pushoverConfigured,
} from './pushover.js';
import { getToolTier, isReadOnlyTool, shouldAutoAllow } from './tool-tiers.js';
import { summarizeToolInput } from '@mitzo/protocol';
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

function transportSend(transport: SessionTransport, data: Record<string, unknown>): void {
  try {
    if (transport.isOpen()) transport.send(data);
  } catch {
    // A socket can close after isOpen(). Pending requests remain available
    // for reconnect replay; delivery failure must not reject tool resolution.
  }
}

function getMcpPrefix(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  if (parts.length >= 3) return `${parts[0]}__${parts[1]}__`;
  return null;
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
      /** Provider adapter supplies validated questions, preserving provider IDs. */
      questions?: UserQuestion[];
    },
  ): Promise<PermissionResult> => {
    const session = registry.get(clientId);
    if (!session) return { behavior: 'deny', message: 'Session not found' };

    // Skill restrictions are checked FIRST — a safe-tier tool not in the
    // skill's allowed-tools list must be denied even if shouldAutoAllow
    // would normally permit it.
    if (checkSkillPolicy(registry, clientId, toolName) === 'deny') {
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

    if (
      !questions &&
      !opts.forcePrompt &&
      shouldAutoAllow(toolName, effectivePermissionMode(session))
    ) {
      return { behavior: 'allow', updatedInput: _toolInput };
    }

    // Exact-action and policy gates remain non-cacheable unless the caller
    // explicitly declares that this forced prompt supports session-wide grants.
    if (
      !questions &&
      (!opts.forcePrompt || opts.allowSessionGrant) &&
      isAllowListed(session.sessionAllowList, toolName)
    ) {
      return {
        behavior: 'allow',
        decisionClassification: 'user_permanent',
        updatedInput: _toolInput,
      };
    }

    const inputSummary = summarizeToolInput(toolName, _toolInput);
    const tier = getToolTier(toolName);

    return new Promise<PermissionResult>((resolve) => {
      if (opts.signal.aborted) {
        resolve({ behavior: 'deny', message: 'Aborted' });
        return;
      }

      const permId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      let resolutionEvent = 'permission_resolved';
      let notificationTimer: ReturnType<typeof setTimeout> | undefined;
      const wrappedResolve = (result: PermissionResult) => {
        clearTimeout(timeout);
        clearTimeout(notificationTimer);
        opts.signal.removeEventListener('abort', onAbort);
        // An approval cannot override a later mode downgrade or skill ceiling.
        if (result.behavior === 'allow') {
          const modeDenial = askDenial();
          if (modeDenial) result = modeDenial;
          else if (checkSkillPolicy(registry, clientId, toolName) === 'deny') {
            result = { behavior: 'deny', message: 'Tool not allowed by active skill policy' };
          }
        }
        if (result.behavior === 'allow' && result.decisionClassification === 'user_permanent') {
          addToAllowList(session.sessionAllowList, toolName);
        }
        const resolved = { type: resolutionEvent, permId, sessionId: session.sessionId };
        transportSend(session.transport, resolved);
        for (const observer of session.observers) transportSend(observer, resolved);
        resolve(result);
      };

      const onAbort = () => {
        if (hasPending(permId)) {
          resolutionEvent = 'permission_timeout';
          resolvePending(permId, 'deny');
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });

      const request: PermissionRequest = {
        permId,
        toolName,
        toolInput: questions
          ? ''
          : toolName === 'Bash' && typeof _toolInput.command === 'string'
            ? _toolInput.command
            : JSON.stringify(_toolInput, null, 2),
        title: opts.title,
        description: opts.description,
        displayName: opts.displayName,
        tier,
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
      );

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

      const timeout = setTimeout(() => {
        if (hasPending(permId)) {
          resolutionEvent = 'permission_timeout';
          resolvePending(permId, 'deny');
        }
      }, PERMISSION_TIMEOUT_MS);
      transportSend(session.transport, { type: 'permission_request', ...request });
    });
  };
}
