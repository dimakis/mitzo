import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerPending,
  resolvePending,
  removePending,
  hasPending,
  denyPendingBySession,
} from '../src/permissions.js';

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
    let result: Record<string, unknown> | null = null;
    registerPending(
      permId,
      'Bash',
      (r) => {
        result = r;
      },
      toolInput,
    );

    const ok = resolvePending(permId, 'once');
    expect(ok).toBe(true);
    expect(result.behavior).toBe('allow');
    expect(result.decisionClassification).toBe('user_temporary');
    expect(result.updatedInput).toEqual(toolInput);
  });

  it('resolvePending with "always" passes toolInput as updatedInput', () => {
    let result: Record<string, unknown> | null = null;
    registerPending(
      permId,
      'Edit',
      (r) => {
        result = r;
      },
      toolInput,
    );

    resolvePending(permId, 'always');
    expect(result.behavior).toBe('allow');
    expect(result.decisionClassification).toBe('user_permanent');
    expect(result.updatedInput).toEqual(toolInput);
  });

  it('resolvePending with "deny" calls resolver with deny + user_reject', () => {
    let result: Record<string, unknown> | null = null;
    registerPending(
      permId,
      'Bash',
      (r) => {
        result = r;
      },
      toolInput,
    );

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

describe('denyPendingBySession', () => {
  beforeEach(() => {
    removePending('p1');
    removePending('p2');
    removePending('p3');
  });

  it('denies all pending entries matching the sessionId', () => {
    const results: Record<string, unknown>[] = [];
    registerPending('p1', 'Bash', (r) => results.push(r), { cmd: 'ls' }, undefined, 'sess-A');
    registerPending('p2', 'Write', (r) => results.push(r), { path: '/f' }, undefined, 'sess-A');

    const denied = denyPendingBySession('sess-A');
    expect(denied).toBe(2);
    expect(results).toHaveLength(2);
    expect(results[0].behavior).toBe('deny');
    expect(results[1].behavior).toBe('deny');
    expect(hasPending('p1')).toBe(false);
    expect(hasPending('p2')).toBe(false);
  });

  it('skips entries from other sessions', () => {
    registerPending('p1', 'Bash', () => {}, {}, undefined, 'sess-A');
    registerPending('p2', 'Write', () => {}, {}, undefined, 'sess-B');

    const denied = denyPendingBySession('sess-A');
    expect(denied).toBe(1);
    expect(hasPending('p1')).toBe(false);
    expect(hasPending('p2')).toBe(true);
  });

  it('returns 0 when no entries match', () => {
    registerPending('p1', 'Bash', () => {}, {}, undefined, 'sess-A');
    expect(denyPendingBySession('sess-Z')).toBe(0);
    expect(hasPending('p1')).toBe(true);
  });

  it('skips entries without sessionId', () => {
    registerPending('p1', 'Bash', () => {}, {});
    expect(denyPendingBySession('sess-A')).toBe(0);
    expect(hasPending('p1')).toBe(true);
  });
});
