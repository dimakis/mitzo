import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimTransportConnection,
  isTransportConnectionOwnedBy,
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

    releaseTransportConnection('conn-closing', 'auth-owner');
    expect(isTransportConnectionOwnedBy('conn-closing', 'auth-owner')).toBe(true);
    expect(isTransportConnectionOwnedBy('conn-closing', 'auth-other')).toBe(false);

    vi.advanceTimersByTime(TRANSPORT_OWNERSHIP_GRACE_MS + 1);
    expect(isTransportConnectionOwnedBy('conn-closing', 'auth-owner')).toBe(false);
  });
});
