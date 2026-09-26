import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('refuses unsupported OpenSSL before creating the private destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'tls-prerequisite-'));
  roots.push(root);
  const binary = join(root, 'openssl');
  writeFileSync(binary, '#!/bin/sh\necho "verify supports no hostname flags" >&2\nexit 1\n', {
    mode: 0o700,
  });
  const destination = join(root, 'tls');
  const result = spawnSync(
    '/bin/sh',
    [resolve('scripts/symposium/create-disposable-tls.sh'), destination],
    { env: { ...process.env, OPENSSL_BIN: binary }, encoding: 'utf8' },
  );
  expect(result.status).not.toBe(0);
  expect(existsSync(destination)).toBe(false);
  expect(result.stderr).toContain('OPENSSL_BIN');
});
