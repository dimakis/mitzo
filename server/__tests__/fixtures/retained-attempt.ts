import { expect } from 'vitest';
import type { SessionMeta } from '@mitzo/protocol';

export interface ObservedTransportRefresh {
  state: SessionMeta['state'];
  reason: string | undefined;
  before: SessionMeta;
  after: SessionMeta;
}

export function expectRetainedAttemptUnchanged<T extends { session: SessionMeta }>(
  original: T,
  current: T,
  refreshes: ObservedTransportRefresh[],
) {
  // Keep every original field checked. Only apply lifecycle updates witnessed
  // through the real owner, with exact transport reasons and an unbroken chain.
  const expected = structuredClone(original);
  for (const refresh of refreshes) {
    expect(refresh.before).toEqual(expected.session);
    expect([
      ['ACTIVE', 'ACTIVE', 'reattach'],
      ['ACTIVE', 'DETACHED', 'transport_close'],
      ['DETACHED', 'ACTIVE', 'reattach'],
    ]).toContainEqual([refresh.before.state, refresh.state, refresh.reason]);
    expect(refresh.after.lastStateChange).toBeGreaterThanOrEqual(refresh.before.lastStateChange!);
    expect(refresh.after.updatedAt).toBeGreaterThanOrEqual(refresh.before.updatedAt);
    expect(refresh.after).toEqual({
      ...refresh.before,
      state: refresh.state,
      lastStateChange: refresh.after.lastStateChange,
      updatedAt: refresh.after.updatedAt,
    });
    expected.session = refresh.after;
  }
  expect(current.session.state).toBe(original.session.state);
  expect(current).toEqual(expected);
}
