import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ToolTier } from './tool-tiers.js';

type PermissionResolver = (result: PermissionResult) => void;

interface PendingEntry {
  resolver: PermissionResolver;
  toolName: string;
  toolInput: Record<string, unknown>;
  tier?: ToolTier;
}

const pending = new Map<string, PendingEntry>();

export function registerPending(
  permId: string,
  toolName: string,
  resolver: PermissionResolver,
  toolInput: Record<string, unknown>,
  tier?: ToolTier,
) {
  pending.set(permId, { resolver, toolName, toolInput, tier });
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
