import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ToolTier } from './tool-tiers.js';

type PermissionResolver = (result: PermissionResult) => void;

interface PendingEntry {
  resolver: PermissionResolver;
  toolName: string;
  suggestions?: PermissionUpdate[];
  tier?: ToolTier;
}

const pending = new Map<string, PendingEntry>();

export function registerPending(
  permId: string,
  toolName: string,
  resolver: PermissionResolver,
  suggestions?: PermissionUpdate[],
  tier?: ToolTier,
) {
  pending.set(permId, { resolver, toolName, suggestions, tier });
}

export function resolvePending(permId: string, decision: 'once' | 'always' | 'deny'): boolean {
  const entry = pending.get(permId);
  if (!entry) return false;

  pending.delete(permId);
  const { resolver, suggestions } = entry;

  if (decision === 'always') {
    const result: PermissionResult = {
      behavior: 'allow',
      decisionClassification: 'user_permanent',
    };
    if (suggestions && suggestions.length > 0) {
      result.updatedPermissions = suggestions;
    }
    resolver(result);
  } else if (decision === 'once') {
    resolver({
      behavior: 'allow',
      decisionClassification: 'user_temporary',
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
