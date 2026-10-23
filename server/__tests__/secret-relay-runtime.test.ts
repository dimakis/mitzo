import { expect, it } from 'vitest';
import { secretRelayConfig } from '../secret-relay-runtime.js';
it('requires explicit Gateway, workspace and compatible credential-export protocol; never falls back to another vault', () => {
  expect(secretRelayConfig({})).toBeNull();
  expect(() => secretRelayConfig({ MITZO_SECRET_RELAY_ENABLED: '1' })).toThrow();
  const env = {
    MITZO_SECRET_RELAY_ENABLED: '1',
    MITZO_SECRET_RELAY_GATEWAY: 'test-gateway',
    MITZO_SECRET_RELAY_WORKSPACE: 'private-relay',
    MITZO_SECRET_RELAY_PROTOCOL: 'openshell-operator-credentials-v1',
  };
  expect(secretRelayConfig(env)).toMatchObject({
    gateway: 'test-gateway',
    workspace: 'private-relay',
  });
  expect(() =>
    secretRelayConfig({ ...env, MITZO_SECRET_RELAY_PROTOCOL: 'openshell-v1' }),
  ).toThrow();
  expect(() => secretRelayConfig({ ...env, MITZO_SECRET_RELAY_GATEWAY: '../other' })).toThrow();
});
it('refuses host network debug logging when private relay credentials are enabled', () => {
  const env = {
    MITZO_SECRET_RELAY_ENABLED: '1',
    MITZO_SECRET_RELAY_GATEWAY: 'g',
    MITZO_SECRET_RELAY_WORKSPACE: 'w',
    MITZO_SECRET_RELAY_PROTOCOL: 'openshell-operator-credentials-v1',
  };
  expect(() => secretRelayConfig({ ...env, NODE_DEBUG: 'http,https' })).toThrow();
  expect(() => secretRelayConfig({ ...env, NODE_DEBUG_NATIVE: 'TLS' })).toThrow();
});
