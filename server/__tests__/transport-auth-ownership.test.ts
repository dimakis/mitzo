import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimTransportConnection,
  acceptTransportLifecycle,
  transportConnectionReplaces,
  isTransportConnectionOwnedBy,
  liveTransportAuthSessionId,
  releaseTransportConnection,
  TRANSPORT_OWNERSHIP_GRACE_MS,
} from '../transport-auth-ownership.js';

describe('transport auth ownership', () => {
  afterEach(() => vi.useRealTimers());

  it('binds a connection to exactly one login session', () => {
    claimTransportConnection('conn-owned', 'auth-owner');

    expect(isTransportConnectionOwnedBy('conn-owned', 'auth-owner')).toBe(true);
    expect(isTransportConnectionOwnedBy('conn-owned', 'auth-other')).toBe(false);

    releaseTransportConnection('conn-owned', 'auth-owner');
  });

  it('does not let stale cleanup release a replacement binding', () => {
    claimTransportConnection('conn-replaced', 'auth-old');
    claimTransportConnection('conn-replaced', 'auth-new');

    releaseTransportConnection('conn-replaced', 'auth-old');
    expect(isTransportConnectionOwnedBy('conn-replaced', 'auth-new')).toBe(true);

    releaseTransportConnection('conn-replaced', 'auth-new');
  });

  it('retains the owner briefly for teardown beacons, then expires it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    claimTransportConnection('conn-closing', 'auth-owner');

    expect(liveTransportAuthSessionId('conn-closing')).toBe('auth-owner');
    releaseTransportConnection('conn-closing', 'auth-owner');
    expect(liveTransportAuthSessionId('conn-closing')).toBeUndefined();
    expect(isTransportConnectionOwnedBy('conn-closing', 'auth-owner')).toBe(true);
    expect(isTransportConnectionOwnedBy('conn-closing', 'auth-other')).toBe(false);

    vi.advanceTimersByTime(TRANSPORT_OWNERSHIP_GRACE_MS + 1);
    expect(isTransportConnectionOwnedBy('conn-closing', 'auth-owner')).toBe(false);
  });
});

// HTTP keepalive/beacon delivery can finish after a newer foreground replay.
it('fences stale and duplicate lifecycle transitions within the existing login lease', () => {
  claimTransportConnection('ordered-lifecycle', 'ordered-login');
  expect(acceptTransportLifecycle('ordered-lifecycle', 1)).toBe(true);
  expect(acceptTransportLifecycle('ordered-lifecycle', 3)).toBe(true);
  expect(acceptTransportLifecycle('ordered-lifecycle', 2)).toBe(false);
  expect(acceptTransportLifecycle('ordered-lifecycle', 3)).toBe(false);
  expect(acceptTransportLifecycle('ordered-lifecycle', undefined)).toBe(false);
  releaseTransportConnection('ordered-lifecycle', 'ordered-login');
  expect(acceptTransportLifecycle('ordered-lifecycle', 2)).toBe(false);
  expect(acceptTransportLifecycle('ordered-lifecycle', 4)).toBe(true);
});
it('retains compatibility for legacy connections and refuses invalid revisions', () => {
  claimTransportConnection('legacy-lifecycle', 'legacy-login');
  expect(acceptTransportLifecycle('legacy-lifecycle', undefined)).toBe(true);
  expect(acceptTransportLifecycle('legacy-lifecycle', undefined)).toBe(true);
  for (const revision of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(acceptTransportLifecycle('legacy-lifecycle', revision)).toBe(false);
  expect(acceptTransportLifecycle('missing-lifecycle', 1)).toBe(false);
});

it('shares the fence only across an explicit same-login replacement and retains it after origin expiry', () => {
  vi.useFakeTimers();
  claimTransportConnection('lineage-origin', 'lineage-login');
  claimTransportConnection('lineage-next', 'lineage-login');
  claimTransportConnection('lineage-foreign', 'foreign-login');
  expect(acceptTransportLifecycle('lineage-origin', 1)).toBe(true);
  expect(acceptTransportLifecycle('lineage-foreign', 2, 'lineage-origin')).toBe(false);
  expect(acceptTransportLifecycle('lineage-next', 2, 'lineage-origin')).toBe(true);
  expect(acceptTransportLifecycle('lineage-origin', 3)).toBe(false);
  releaseTransportConnection('lineage-origin', 'lineage-login');
  vi.advanceTimersByTime(TRANSPORT_OWNERSHIP_GRACE_MS + 1);
  claimTransportConnection('lineage-final', 'lineage-login');
  expect(acceptTransportLifecycle('lineage-final', 4, 'lineage-origin')).toBe(true);
  expect(acceptTransportLifecycle('lineage-next', 3)).toBe(false);
});

it('permits normal replay after all predecessor leases expired without granting unrelated continuity', () => {
  vi.useFakeTimers();
  claimTransportConnection('expired-origin', 'expiry-login');
  expect(acceptTransportLifecycle('expired-origin', 1)).toBe(true);
  releaseTransportConnection('expired-origin', 'expiry-login');
  vi.advanceTimersByTime(TRANSPORT_OWNERSHIP_GRACE_MS + 1);
  claimTransportConnection('expiry-successor', 'expiry-login');
  expect(acceptTransportLifecycle('expiry-successor', 2, 'expired-origin')).toBe(true);
  expect(acceptTransportLifecycle('expiry-successor', 3, 'expired-origin')).toBe(true);
});

it('keeps unrelated observers outside an explicitly established stream lineage', () => {
  claimTransportConnection('observed-driver', 'observer-login');
  claimTransportConnection('independent-observer', 'observer-login');
  expect(acceptTransportLifecycle('observed-driver', 1)).toBe(true);
  expect(acceptTransportLifecycle('independent-observer', 2)).toBe(true);
  expect(transportConnectionReplaces('independent-observer', 'observed-driver')).toBe(false);
});
