import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { registerPending, removePending, hasPending } from './permissions.js';
import { sendPermissionNotification, isConfigured as ntfyConfigured } from './notify.js';
import {
  sendPermissionNotification as pushoverSendPermission,
  isConfigured as pushoverConfigured,
} from './pushover.js';
import { getToolTier, shouldAutoAllow } from './tool-tiers.js';
import { summarizeToolInput } from '@mitzo/protocol';
import { checkSkillPolicy } from './skill-policy.js';
import { PERMISSION_TIMEOUT_MS, NTFY_NOTIFICATION_DELAY_MS } from './constants.js';
import type { SessionRegistry } from './session-registry.js';
import type { SessionTransport } from './session-transport.js';

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

export function buildPermissionHandler(clientId: string, registry: SessionRegistry) {
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

    if (shouldAutoAllow(toolName, session.mode)) {
      return { behavior: 'allow', updatedInput: _toolInput };
    }

    if (isAllowListed(session.sessionAllowList, toolName)) {
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

      const wrappedResolve = (result: PermissionResult) => {
        if (result.behavior === 'allow' && result.decisionClassification === 'user_permanent') {
          addToAllowList(session.sessionAllowList, toolName);
        }
        resolve(result);
      };

      const onAbort = () => {
        if (hasPending(permId)) {
          removePending(permId);
          resolve({ behavior: 'deny', message: 'Aborted' });
          transportSend(session.transport,{ type: 'permission_timeout', permId });
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });

      registerPending(permId, toolName, wrappedResolve, _toolInput, tier);

      transportSend(session.transport,{
        type: 'permission_request',
        permId,
        toolName,
        toolInput: inputSummary,
        title: opts.title,
        description: opts.description,
        displayName: opts.displayName,
        decisionReason: opts.decisionReason,
        tier,
      });

      if (ntfyConfigured() || pushoverConfigured()) {
        setTimeout(() => {
          if (hasPending(permId)) {
            if (ntfyConfigured())
              sendPermissionNotification(toolName, inputSummary, permId, session.sessionId);
            if (pushoverConfigured())
              pushoverSendPermission(toolName, inputSummary, permId, session.sessionId);
          }
        }, NTFY_NOTIFICATION_DELAY_MS);
      }

      setTimeout(() => {
        if (hasPending(permId)) {
          removePending(permId);
          opts.signal.removeEventListener('abort', onAbort);
          resolve({ behavior: 'deny', message: 'Permission request timed out' });
          transportSend(session.transport,{ type: 'permission_timeout', permId });
        }
      }, PERMISSION_TIMEOUT_MS);
    });
  };
}
