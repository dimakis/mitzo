type PermissionResolver = (result: any) => void;

interface PendingEntry {
  resolver: PermissionResolver;
  toolName: string;
  suggestions?: any[];
}

const pending = new Map<string, PendingEntry>();

export function registerPending(
  permId: string,
  toolName: string,
  resolver: PermissionResolver,
  suggestions?: any[],
) {
  pending.set(permId, { resolver, toolName, suggestions });
}

export function resolvePending(permId: string, decision: 'once' | 'always' | 'deny'): boolean {
  const entry = pending.get(permId);
  if (!entry) return false;

  pending.delete(permId);
  const { resolver, suggestions } = entry;

  if (decision === 'always') {
    resolver({
      behavior: 'allow' as const,
      updatedPermissions: suggestions,
      decisionClassification: 'user_permanent' as const,
    });
  } else if (decision === 'once') {
    resolver({
      behavior: 'allow' as const,
      decisionClassification: 'user_temporary' as const,
    });
  } else {
    resolver({
      behavior: 'deny' as const,
      message: 'User denied',
      decisionClassification: 'user_reject' as const,
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
