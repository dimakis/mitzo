// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserId, sha256Hex } from '../browser-crypto';

afterEach(() => vi.unstubAllGlobals());
it.each([
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
])('hashes known SHA-256 vector %j without secure crypto', (value, expected) => {
  vi.stubGlobal('crypto', undefined);
  expect(sha256Hex(value)).toBe(expected);
});
it.each(['café 🧭 中文\r\nsecond line\n', 'Unicode 🧭\r\n'.repeat(4096)])(
  'matches independent Node SHA-256 for exact UTF-8 and multi-block input',
  (value) => {
    vi.stubGlobal('crypto', undefined);
    expect(sha256Hex(value)).toBe(createHash('sha256').update(value, 'utf8').digest('hex'));
    expect(sha256Hex(value)).not.toBe(sha256Hex(value.replaceAll('\r\n', '\n')));
  },
);
it.each(['secure', 'http', 'legacy'] as const)(
  'makes distinct valid v4 UUIDs on %s hosts',
  (host) => {
    vi.stubGlobal(
      'crypto',
      host === 'secure'
        ? webcrypto
        : host === 'http'
          ? { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
          : undefined,
    );
    const ids = Array.from({ length: 128 }, () => createBrowserId());
    for (const id of ids)
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(new Set(ids).size).toBe(ids.length);
  },
);
