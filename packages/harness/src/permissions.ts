import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ToolTier } from './tool-tiers.js';

type PermissionResolver = (result: PermissionResult) => void;

interface PendingEntry {
  resolver: PermissionResolver;
  toolName: string;
  toolInput: Record<string, unknown>;
  tier?: ToolTier;
  sessionId?: string;
}

const pending = new Map<string, PendingEntry>();

export function registerPending(
  permId: string,
  toolName: string,
  resolver: PermissionResolver,
  toolInput: Record<string, unknown>,
  tier?: ToolTier,
  sessionId?: string,
) {
  pending.set(permId, { resolver, toolName, toolInput, tier, sessionId });
}

export function resolvePending(permId: string, decision: 'once' | 'always' | 'deny'): boolean {
  const entry = pending.get(permId);
  if (!entry) return false;

  pending.delete(permId);
  const { resolver, toolInput } = entry;

  if (decision === 'always') {
    resolver({
      behavior: 'allow',
      decisionClassification: 'user_permanent',
      updatedInput: toolInput,
    });
  } else if (decision === 'once') {
    resolver({
      behavior: 'allow',
      decisionClassification: 'user_temporary',
      updatedInput: toolInput,
    });
  } else {
    resolver({
      behavior: 'deny',
      message: 'User denied',
      decisionClassification: 'user_reject',
    });
  }

  return true;
}

export function removePending(permId: string) {
  pending.delete(permId);
}

export function hasPending(permId: string): boolean {
  return pending.has(permId);
}

/**
 * Deny all pending permission requests associated with a session.
 * Used during session takeover to clean up stale prompts on the old device.
 */
/**
 * Count pending permission requests for a specific session.
 * Used by session-overview to derive the 'waiting' state.
 */
export function getPendingCountBySession(sessionId: string): number {
  let count = 0;
  for (const entry of pending.values()) {
    if (entry.sessionId === sessionId) count++;
  }
  return count;
}

export function denyPendingBySession(sessionId: string): number {
  let denied = 0;
  for (const [permId, entry] of pending) {
    if (entry.sessionId === sessionId) {
      pending.delete(permId);
      entry.resolver({
        behavior: 'deny',
        message: 'Session taken over by another device',
        decisionClassification: 'user_reject',
      });
      denied++;
    }
  }
  return denied;
}
