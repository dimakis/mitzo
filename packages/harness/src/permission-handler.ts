import { z } from 'zod';
import type { PermissionRequest, UserQuestion } from '@mitzo/protocol';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { registerPending, resolvePending, hasPending } from './permissions.js';
import { sendPermissionNotification, isConfigured as ntfyConfigured } from './notify.js';
import {
  sendPermissionNotification as pushoverSendPermission,
  isConfigured as pushoverConfigured,
} from './pushover.js';
import { getToolTier, shouldAutoAllow } from './tool-tiers.js';
import { summarizeToolInput } from '@mitzo/protocol';
import { checkSkillPolicy } from './skill-policy.js';
import { checkWorktreePolicy, type OnDemandCreateFn } from './worktree-guard.js';
import { PERMISSION_TIMEOUT_MS, NTFY_NOTIFICATION_DELAY_MS } from './constants.js';
import type { SessionRegistry } from './session-registry.js';
import type { SessionTransport } from './session-transport.js';

const Questions = z
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
  if (transport.isOpen()) {
    transport.send(data);
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

    let questions: UserQuestion[] | undefined;
    if (toolName === 'AskUserQuestion') {
      const parsed = Questions.safeParse(_toolInput.questions);
      if (!parsed.success)
        return {
          behavior: 'deny',
          message: 'Invalid user questions. Ask up to four distinct questions.',
        };
      questions = parsed.data.map((question) => ({ id: question.question, ...question }));
    }

    const worktreeViolation = await checkWorktreePolicy(session, toolName, _toolInput, {
      onDemandCreate: handlerOpts?.onDemandCreate,
    });
    if (worktreeViolation) {
      return { behavior: 'deny', message: worktreeViolation };
    }

    if (!questions && shouldAutoAllow(toolName, session.mode)) {
      return { behavior: 'allow', updatedInput: _toolInput };
    }

    if (!questions && isAllowListed(session.sessionAllowList, toolName)) {
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

      let notificationTimer: ReturnType<typeof setTimeout> | undefined;
      const wrappedResolve = (result: PermissionResult) => {
        clearTimeout(timeout);
        clearTimeout(notificationTimer);
        opts.signal.removeEventListener('abort', onAbort);
        if (result.behavior === 'allow' && result.decisionClassification === 'user_permanent') {
          addToAllowList(session.sessionAllowList, toolName);
        }
        resolve(result);
      };

      const onAbort = () => {
        if (hasPending(permId)) {
          resolvePending(permId, 'deny');
          transportSend(session.transport, {
            type: 'permission_timeout',
            permId,
            sessionId: session.sessionId,
          });
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });

      const request: PermissionRequest = {
        permId,
        toolName,
        toolInput: inputSummary,
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
          resolvePending(permId, 'deny');
          transportSend(session.transport, {
            type: 'permission_timeout',
            permId,
            sessionId: session.sessionId,
          });
        }
      }, PERMISSION_TIMEOUT_MS);
      transportSend(session.transport, { type: 'permission_request', ...request });
    });
  };
}
