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
  writeFileSync(join(root, 'codex-code-mode-host'), bytes, { mode: 0o755 });
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

it('keeps v2 conversation identity stable across attested deployments and qualifies only reviewed legacy transitions', async () => {
  const f = fixture();
  f.writeTarget({ version: 2, continuityContract: 'codex-native-thread-v1' });
  const first = new OrdinaryLocalCodexHostRuntime(f.env);
  const identity = first.target().descriptor().targetRevision;
  const oldAttestation = ordinaryLocalCodexHostContractRevision(f.sha256);
  const actual = await vi.importActual<
    typeof import('../connections/reviewed-handler-artifacts.js')
  >('../connections/reviewed-handler-artifacts.js');
  manifest.artifacts = {
    ...actual.reviewedHandlerSourceArtifacts,
    '../unrelated-ui.tsx': 'f'.repeat(64),
  };
  expect(ordinaryLocalCodexHostContractRevision(f.sha256)).not.toBe(oldAttestation);
  expect(() => first.assertCurrentSync()).toThrow();
  f.writeTarget({ version: 2, continuityContract: 'codex-native-thread-v1' });
  const next = new OrdinaryLocalCodexHostRuntime(f.env);
  expect(next.target().descriptor().targetRevision).toBe(identity);
  expect(next.continuationDeclaration(identity).targetRevision).toBe(identity);
  expect(() => next.continuationDeclaration('unreviewed-legacy')).toThrow();
  const legacy = createHash('sha256')
    .update(
      JSON.stringify([
        'ordinary-local-codex-host-v1',
        'v1.0.531-repository-recovery-integration',
        '24f1c83ffc3759a76095f3072edcc9fdebbe5087c874469d60e286d728160462',
        '0.160.0',
        f.sha256,
      ]),
    )
    .digest('hex');
  const revision = createHash('sha256')
    .update(JSON.stringify(['ordinary-local-codex-target-v1', 'local-mac', hostname(), legacy]))
    .digest('hex');
  expect(next.continuationDeclaration(revision).targetRevision).toBe(revision);
  expect(await next.observe()).toMatchObject({
    targetRevision: identity,
    compatibleTargetRevisions: expect.arrayContaining([revision]),
  });
});

it('refuses native startup before dispatch when the bundled code-mode host is missing', () => {
  const f = fixture();
  rmSync(join(f.root, 'codex-code-mode-host'), { force: true });
  expect(() => new OrdinaryLocalCodexHostRuntime(f.env)).toThrow(
    'Host Codex runtime observation unavailable',
  );
});
