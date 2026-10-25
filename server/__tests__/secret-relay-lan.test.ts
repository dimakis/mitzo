import { expect, it } from 'vitest';
import { validateLanRelayEndpoint } from '../secret-relay-lan.js';
it('permits only canonical literal RFC1918 HTTP origins, never controller, metadata, public or DNS destinations', () => {
  expect(validateLanRelayEndpoint('http://192.168.1.115')).toBe('http://192.168.1.115');
  for (const origin of [
    'http://127.0.0.1',
    'http://169.254.169.254',
    'http://8.8.8.8',
    'http://example.test',
    'http://192.168.1.115/path',
    'http://user:pass@192.168.1.115',
    'https://192.168.1.115',
    'http://192.168.1.115?x=1',
  ])
    expect(() => validateLanRelayEndpoint(origin)).toThrow();
});
