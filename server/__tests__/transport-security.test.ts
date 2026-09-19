import { describe, expect, it } from 'vitest';
import {
  assertTlsAvailable,
  requireTlsForProduction,
  shouldStartPlaintextWatchOsListener,
} from '../transport-security.js';

describe('production transport security', () => {
  it.each([undefined, '', '0'])('allows TLS to remain optional for %j', (value) => {
    expect(requireTlsForProduction({ MITZO_REQUIRE_TLS: value })).toBe(false);
  });

  it('requires certificates when the production release requires TLS', () => {
    expect(requireTlsForProduction({ MITZO_REQUIRE_TLS: '1' })).toBe(true);
    expect(() => assertTlsAvailable({ MITZO_REQUIRE_TLS: '1' }, false)).toThrow(
      'requires both the TLS certificate and private key',
    );
    expect(() => assertTlsAvailable({ MITZO_REQUIRE_TLS: '1' }, true)).not.toThrow();
  });

  it('rejects ambiguous TLS settings', () => {
    expect(() => requireTlsForProduction({ MITZO_REQUIRE_TLS: 'true' })).toThrow(
      'MITZO_REQUIRE_TLS must be 0 or 1',
    );
  });

  it('does not start the plaintext watchOS listener when TLS is required', () => {
    expect(shouldStartPlaintextWatchOsListener({ MITZO_REQUIRE_TLS: '1' }, true)).toBe(false);
  });

  it('keeps the plaintext watchOS listener available for local TLS development', () => {
    expect(shouldStartPlaintextWatchOsListener({ MITZO_REQUIRE_TLS: '0' }, true)).toBe(true);
  });
});
