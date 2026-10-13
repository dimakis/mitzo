import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../ordinary-local-codex-host-runtime.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-host-runtime-')));
  roots.push(root);
  mkdirSync(join(root, 'settings'), { mode: 0o700 });
  const executable = join(root, 'codex');
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(executable, bytes, { mode: 0o755 });
  const nativePath = join(root, 'settings/native.json'),
    targetPath = join(root, 'settings/target.json');
  const writeNative = (extra = {}) =>
    writeFileSync(
      nativePath,
      JSON.stringify({
        version: 1,
        executablePath: executable,
        executableSha256: sha256,
        ...extra,
      }),
      { mode: 0o600 },
    );
  const writeTarget = (extra = {}) =>
    writeFileSync(
      targetPath,
      JSON.stringify({
        version: 1,
        targetId: 'local-mac',
        label: 'Local Mac',
        hostId: hostname(),
        runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256),
        ...extra,
      }),
      { mode: 0o600 },
    );
  writeNative();
  writeTarget();
  const env = {
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativePath,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetPath,
  };
  return { root, env, writeNative, writeTarget, executable, sha256 };
}
it('observes this OS host and exact native bytes independently of the target declaration', async () => {
  const f = fixture();
  const runtime = new OrdinaryLocalCodexHostRuntime(f.env);
  await expect(runtime.observe()).resolves.toMatchObject({
    hostId: hostname(),
    targetId: 'local-mac',
    executablePath: f.executable,
    executableSha256: f.sha256,
    runtimeContractRevision: ordinaryLocalCodexHostContractRevision(f.sha256),
  });
});
it.each(['host', 'contract', 'native'] as const)(
  'refuses an incorrect %s declaration before any process creation',
  (kind) => {
    const f = fixture();
    if (kind === 'host') f.writeTarget({ hostId: 'another-host' });
    if (kind === 'contract') f.writeTarget({ runtimeContractRevision: 'unverified-runtime' });
    if (kind === 'native') f.writeNative({ executableSha256: 'a'.repeat(64) });
    expect(() => new OrdinaryLocalCodexHostRuntime(f.env)).toThrow(
      'Host Codex runtime observation unavailable',
    );
  },
);
it('refuses changed selected bytes and config instead of observing a substitute target', async () => {
  const f = fixture();
  const runtime = new OrdinaryLocalCodexHostRuntime(f.env);
  f.writeTarget({ targetId: 'replacement-target' });
  expect(() => runtime.assertCurrentSync()).toThrow('Host Codex runtime observation unavailable');
  await expect(runtime.observe()).rejects.toThrow('Host Codex runtime observation unavailable');
});
it('never infers an unconfigured host target from the OS or installed executable', () => {
  expect(() => new OrdinaryLocalCodexHostRuntime({})).toThrow(
    'Host Codex runtime observation unavailable',
  );
});
