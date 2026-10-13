import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as boundedRead from '../bounded-file-read.js';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../ordinary-local-codex-host-runtime.js';
const manifest = vi.hoisted(() => ({ artifacts: undefined as Record<string, string> | undefined }));
vi.mock('../connections/reviewed-handler-artifacts.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../connections/reviewed-handler-artifacts.js')>();
  return {
    ...actual,
    get reviewedHandlerSourceArtifacts() {
      return manifest.artifacts ?? actual.reviewedHandlerSourceArtifacts;
    },
  };
});
const roots: string[] = [];
vi.mock('../bounded-file-read.js', { spy: true });
afterEach(() => {
  manifest.artifacts = undefined;
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it('binds the target contract to the exact sorted code closure with unchanged nominal revision, CLI and native bytes', async () => {
  const f = fixture();
  const runtime = new OrdinaryLocalCodexHostRuntime(f.env);
  const original = ordinaryLocalCodexHostContractRevision(f.sha256);
  const actual = await vi.importActual<
    typeof import('../connections/reviewed-handler-artifacts.js')
  >('../connections/reviewed-handler-artifacts.js');
  manifest.artifacts = Object.fromEntries(
    Object.entries(actual.reviewedHandlerSourceArtifacts).reverse(),
  );
  expect(ordinaryLocalCodexHostContractRevision(f.sha256)).toBe(original);
  const path = Object.keys(manifest.artifacts)[0];
  manifest.artifacts[path] = 'f'.repeat(64);
  expect(ordinaryLocalCodexHostContractRevision(f.sha256)).not.toBe(original);
  expect(() => runtime.assertCurrentSync()).toThrow('Host Codex runtime observation unavailable');
  expect(() => new OrdinaryLocalCodexHostRuntime(f.env)).toThrow(
    'Host Codex runtime observation unavailable',
  );
});
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
it('refuses a private settings leaf replaced during its bounded read', async () => {
  const f = fixture();
  const runtime = new OrdinaryLocalCodexHostRuntime(f.env);
  const actual = await vi.importActual<typeof boundedRead>('../bounded-file-read.js');
  vi.mocked(boundedRead.readBoundedFile).mockImplementationOnce((fd, limit) => {
    const content = actual.readBoundedFile(fd, limit);
    const replacement = join(f.root, 'settings', 'replacement.json');
    writeFileSync(replacement, content, { mode: 0o600 });
    renameSync(replacement, f.env.MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE);
    return content;
  });
  expect(() => runtime.assertCurrentSync()).toThrow('Host Codex runtime observation unavailable');
});
