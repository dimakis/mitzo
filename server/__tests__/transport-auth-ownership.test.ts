import { describe, expect, it } from 'vitest';
import {
  claimTransportConnection,
  isTransportConnectionOwnedBy,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';

describe('transport auth ownership', () => {
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
    expect(isTransportConnectionOwnedBy('conn-replaced', 'auth-new')).toBe(false);
  });
});
