import { it, expect } from 'vitest';
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  installFreshKeyConfiguration,
  deriveKeyConfiguration,
} from '../../scripts/lib/staging-key-configuration.mjs';
const id = '1802450e-a87e-45f1-82ce-3c4acdf91a92';
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'staging-key-config-'));
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'symposium/settings'), { recursive: true, mode: 0o700 });
  const path = join(root, 'symposium/settings/owned-host.json'),
    value = {
      gateway: {
        jwt: { signingKey: '/old/private', publicKey: '/old/public', kid: '/old/kid' },
        port: 18990,
      },
      other: 'preserved',
    };
  writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
  return { root, path, value, original: readFileSync(path) };
}
it('creates a fresh matching private Ed25519 pair and changes only JWT references', () => {
  const f = fixture();
  try {
    const result = installFreshKeyConfiguration(f.root, f.path, f.original, id),
      next = JSON.parse(readFileSync(f.path));
    expect(next).toEqual(deriveKeyConfiguration(f.root, f.value, id));
    expect(next.other).toBe('preserved');
    expect(next.gateway.port).toBe(18990);
    const signing = createPrivateKey(readFileSync(next.gateway.jwt.signingKey)),
      pub = createPublicKey(readFileSync(next.gateway.jwt.publicKey));
    expect(signing.asymmetricKeyType).toBe('ed25519');
    expect(createPublicKey(signing).export({ type: 'spki', format: 'der' })).toEqual(
      pub.export({ type: 'spki', format: 'der' }),
    );
    expect(result.freshConfigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => installFreshKeyConfiguration(f.root, f.path, readFileSync(f.path), id)).toThrow();
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
it('refuses changed original configuration before generating material', () => {
  const f = fixture();
  try {
    writeFileSync(f.path, '{}\n');
    expect(() => installFreshKeyConfiguration(f.root, f.path, f.original, id)).toThrow();
    expect(readFileSync(f.path, 'utf8')).toBe('{}\n');
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
it('refuses aliases and an unbound configuration path', () => {
  const f = fixture();
  try {
    expect(() => deriveKeyConfiguration(f.root, f.value, '../escape')).toThrow();
    expect(() =>
      installFreshKeyConfiguration(f.root, join(f.root, 'other'), f.original, id),
    ).toThrow();
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
