import { describe, it, expect, beforeEach } from 'vitest';
import { registerPending, resolvePending, removePending, hasPending } from '../permissions.js';

describe('permissions module', () => {
  const permId = 'test-perm-001';

  beforeEach(() => {
    removePending(permId);
  });

  it('hasPending returns false for unknown id', () => {
    expect(hasPending('nonexistent')).toBe(false);
  });

  it('registerPending makes hasPending return true', () => {
    registerPending(permId, 'Bash', () => {});
    expect(hasPending(permId)).toBe(true);
  });

  it('resolvePending with "once" calls resolver with allow + user_temporary', () => {
    let result: any = null;
    registerPending(permId, 'Bash', (r) => { result = r; });

    const ok = resolvePending(permId, 'once');
    expect(ok).toBe(true);
    expect(result).not.toBeNull();
    expect(result.behavior).toBe('allow');
    expect(result.decisionClassification).toBe('user_temporary');
    expect(result.updatedPermissions).toBeUndefined();
  });

  it('resolvePending with "always" calls resolver with allow + user_permanent + updatedPermissions', () => {
    let result: any = null;
    registerPending(permId, 'Edit', (r) => { result = r; });

    resolvePending(permId, 'always');
    expect(result.behavior).toBe('allow');
    expect(result.decisionClassification).toBe('user_permanent');
    expect(result.updatedPermissions).toHaveLength(1);
    expect(result.updatedPermissions[0].type).toBe('addRules');
    expect(result.updatedPermissions[0].rules[0].toolName).toBe('Edit');
    expect(result.updatedPermissions[0].destination).toBe('session');
  });

  it('resolvePending with "deny" calls resolver with deny + user_reject', () => {
    let result: any = null;
    registerPending(permId, 'Bash', (r) => { result = r; });

    resolvePending(permId, 'deny');
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('User denied');
    expect(result.decisionClassification).toBe('user_reject');
  });

  it('resolvePending returns false for already-resolved id', () => {
    registerPending(permId, 'Bash', () => {});
    resolvePending(permId, 'once');
    expect(resolvePending(permId, 'once')).toBe(false);
  });

  it('removePending clears the pending entry', () => {
    registerPending(permId, 'Bash', () => {});
    removePending(permId);
    expect(hasPending(permId)).toBe(false);
    expect(resolvePending(permId, 'once')).toBe(false);
  });
});
