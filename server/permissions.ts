type PermissionResolver = (result: any) => void;

const pending = new Map<string, { resolver: PermissionResolver; toolName: string }>();

export function registerPending(permId: string, toolName: string, resolver: PermissionResolver) {
  pending.set(permId, { resolver, toolName });
}

export function resolvePending(permId: string, decision: 'once' | 'always' | 'deny'): boolean {
  const entry = pending.get(permId);
  if (!entry) return false;

  pending.delete(permId);
  const { resolver, toolName } = entry;

  if (decision === 'always') {
    resolver({
      behavior: 'allow',
      decisionClassification: 'user_permanent',
      updatedPermissions: [{
        type: 'addRules',
        rules: [{ toolName }],
        behavior: 'allow',
        destination: 'session',
      }],
    });
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
