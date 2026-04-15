import { describe, it, expect, beforeEach } from 'vitest';
import { registerPending, resolvePending, removePending, hasPending } from '../src/permissions.js';

describe('permissions module', () => {
  const permId = 'test-perm-001';
  const toolInput = { command: 'ls' };

  beforeEach(() => {
    removePending(permId);
  });

  it('hasPending returns false for unknown id', () => {
    expect(hasPending('nonexistent')).toBe(false);
  });

  it('registerPending makes hasPending return true', () => {
    registerPending(permId, 'Bash', () => {}, toolInput);
    expect(hasPending(permId)).toBe(true);
  });

  it('resolvePending with "once" calls resolver with allow + user_temporary + updatedInput', () => {
    let result: any = null;
    registerPending(permId, 'Bash', (r) => { result = r; }, toolInput);

    const ok = resolvePending(permId, 'once');
    expect(ok).toBe(true);
    expect(result.behavior).toBe('allow');
    expect(result.decisionClassification).toBe('user_temporary');
    expect(result.updatedInput).toEqual(toolInput);
  });

  it('resolvePending with "always" passes toolInput as updatedInput', () => {
    let result: any = null;
    registerPending(permId, 'Edit', (r) => { result = r; }, toolInput);

    resolvePending(permId, 'always');
    expect(result.behavior).toBe('allow');
    expect(result.decisionClassification).toBe('user_permanent');
    expect(result.updatedInput).toEqual(toolInput);
  });

  it('resolvePending with "deny" calls resolver with deny + user_reject', () => {
    let result: any = null;
    registerPending(permId, 'Bash', (r) => { result = r; }, toolInput);

    resolvePending(permId, 'deny');
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('User denied');
    expect(result.decisionClassification).toBe('user_reject');
  });

  it('resolvePending returns false for already-resolved id', () => {
    registerPending(permId, 'Bash', () => {}, toolInput);
    resolvePending(permId, 'once');
    expect(resolvePending(permId, 'once')).toBe(false);
  });

  it('removePending clears the pending entry', () => {
    registerPending(permId, 'Bash', () => {}, toolInput);
    removePending(permId);
    expect(hasPending(permId)).toBe(false);
    expect(resolvePending(permId, 'once')).toBe(false);
  });

  it('registerPending accepts optional tier parameter', () => {
    registerPending(permId, 'Bash', () => {}, toolInput, 'elevated');
    expect(hasPending(permId)).toBe(true);
  });
});
