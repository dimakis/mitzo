import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';

const roots: string[] = [];
const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-code-reuse-')));
  roots.push(root);
  const privateRoot = join(root, 'private'),
    source = join(root, 'codex');
  mkdirSync(privateRoot, { mode: 0o700 });
  writeFileSync(source, bytes, { mode: 0o755 });
  writeFileSync(join(root, 'codex-code-mode-host'), bytes, { mode: 0o755 });
  const home = join(privateRoot, 'host-api-fixture');
  mkdirSync(home, { mode: 0o700 });
  return { root, privateRoot, source, home };
}

it('reuses complete code custody with fresh wrappers and independent homes under concurrent admissions', async () => {
  const f = fixture();
  const selected = await Promise.all(
    Array.from({ length: 3 }, async () =>
      FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot),
    ),
  );
  expect(new Set(selected).size).toBe(3);
  expect(new Set(selected.map((entry) => entry.path)).size).toBe(1);
  expect(dirname(selected[0].path)).not.toBe(f.home);
  expect(statSync(selected[0].path).mode & 0o777).toBe(0o500);
  const snapshot = selected[0].custodySnapshot();
  expect(snapshot.sharedPlacement).toMatchObject({
    kind: 'shared-runtime-v1',
    privateRoot: f.privateRoot,
  });
  expect(snapshot.codeModeHost?.path).toBe(join(dirname(selected[0].path), 'codex-code-mode-host'));
  expect(readdirSync(dirname(selected[0].path)).sort()).toEqual([
    'codex-code-mode-host',
    'codex-runtime',
  ]);
  selected.forEach((entry) => entry.assertForLoginHome(f.home));
  snapshot.sourceIdentity.sha256 = '0'.repeat(64);
  expect(FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot).path).toBe(
    selected[0].path,
  );
  expect(FrozenHostCodexExecutable.reopen(selected[0].custodySnapshot()).path).toBe(
    selected[0].path,
  );
});

it('keeps legacy placement and exact cold custody while rejecting a different login root', () => {
  const f = fixture();
  const legacy = FrozenHostCodexExecutable.capture(f.source, f.home);
  expect(legacy.custodySnapshot().sharedPlacement).toBeUndefined();
  FrozenHostCodexExecutable.reopen(legacy.custodySnapshot()).assertForLoginHome(f.home);
  const shared = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
  const another = join(f.root, 'another');
  mkdirSync(another, { mode: 0o700 });
  const wrongHome = join(another, 'home');
  mkdirSync(wrongHome, { mode: 0o700 });
  expect(() => shared.assertForLoginHome(wrongHome)).toThrow('runtime unavailable');
  const forged = shared.custodySnapshot();
  forged.sharedPlacement!.privateRoot = another;
  expect(() => FrozenHostCodexExecutable.reopen(forged)).toThrow('runtime unavailable');
  renameSync(dirname(shared.path), join(f.privateRoot, 'retired'));
  expect(() => FrozenHostCodexExecutable.reopen(shared.custodySnapshot())).toThrow();
});

it.each(['write', 'replace', 'hardlink', 'symlink', 'mode'] as const)(
  'rejects retained shared code after %s and never repairs its custody',
  (kind) => {
    const f = fixture();
    const owned = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
    const retained = owned.custodySnapshot();
    if (kind === 'write') {
      chmodSync(owned.path, 0o700);
      writeFileSync(owned.path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 3, 2, 1]));
      chmodSync(owned.path, 0o500);
    }
    if (kind === 'replace' || kind === 'symlink') {
      renameSync(owned.path, `${owned.path}.old`);
      if (kind === 'replace') writeFileSync(owned.path, bytes, { mode: 0o500 });
      else symlinkSync(`${owned.path}.old`, owned.path);
    }
    if (kind === 'hardlink') linkSync(owned.path, join(f.root, 'alias'));
    if (kind === 'mode') chmodSync(owned.path, 0o700);
    expect(() => owned.assertLaunchCurrent()).toThrow('runtime unavailable');
    expect(() => FrozenHostCodexExecutable.reopen(retained)).toThrow('runtime unavailable');
    const replacement = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
    expect(replacement.path).not.toBe(owned.path);
    expect(existsSync(owned.path)).toBe(true);
    expect(() => FrozenHostCodexExecutable.reopen(retained)).toThrow('runtime unavailable');
  },
);

it('allocates new code after source updates without changing existing custody', () => {
  const f = fixture();
  const old = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
  const retained = old.custodySnapshot();
  renameSync(f.source, `${f.source}.old`);
  writeFileSync(f.source, bytes, { mode: 0o755 });
  const current = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
  expect(current.path).not.toBe(old.path);
  expect(readFileSync(old.path)).toEqual(bytes);
  expect(() => FrozenHostCodexExecutable.reopen(retained)).toThrow('runtime unavailable');
});

it.each(['file', 'permissions', 'replacement', 'symlink'] as const)(
  'requires an owned private login directory and pins its identity: %s',
  (kind) => {
    const f = fixture();
    const selected = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
    if (kind === 'replacement') selected.assertForLoginHome(f.home);
    if (kind === 'file' || kind === 'replacement' || kind === 'symlink') {
      renameSync(f.home, `${f.home}.old`);
      if (kind === 'file') writeFileSync(f.home, 'not a directory', { mode: 0o600 });
      if (kind === 'replacement') mkdirSync(f.home, { mode: 0o700 });
      if (kind === 'symlink') symlinkSync(`${f.home}.old`, f.home);
    }
    if (kind === 'permissions') chmodSync(f.home, 0o777);
    expect(() => selected.assertForLoginHome(f.home)).toThrow('runtime unavailable');
    if (kind === 'replacement')
      expect(() => selected.assertCurrent()).toThrow('runtime unavailable');
  },
);

it('binds a shared code wrapper to one login home while other leases receive fresh wrappers', () => {
  const f = fixture();
  const otherHome = join(f.privateRoot, 'other-home');
  mkdirSync(otherHome, { mode: 0o700 });
  const selected = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
  selected.assertForLoginHome(f.home);
  expect(() => selected.assertForLoginHome(otherHome)).toThrow('runtime unavailable');
  const next = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
  next.assertForLoginHome(otherHome);
  expect(next.path).toBe(selected.path);
});

it('reopens exact shared custody after a server restart without adopting disk bundles for new conversations', async () => {
  const f = fixture();
  const original = FrozenHostCodexExecutable.captureReusable(
    f.source,
    f.privateRoot,
  ).custodySnapshot();
  vi.resetModules();
  const { FrozenHostCodexExecutable: restarted } =
    await import('../frozen-host-codex-executable.js');
  const retained = restarted.reopen(original);
  retained.assertForLoginHome(f.home);
  expect(retained.custodySnapshot()).toEqual(original);
  expect(restarted.captureReusable(f.source, f.privateRoot).path).not.toBe(original.path);
  expect(retained.custodySnapshot()).toEqual(original);
});

it('does not publish or adopt partial captures, and never mutates a shared bundle to add a companion', () => {
  const f = fixture();
  const companion = join(f.root, 'codex-code-mode-host');
  writeFileSync(companion, 'not native');
  expect(() => FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot)).toThrow();
  const partial = readdirSync(f.privateRoot).filter((name) => name.startsWith('host-runtime-'));
  expect(partial).toHaveLength(1);
  writeFileSync(companion, bytes);
  const complete = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
  expect(dirname(complete.path)).not.toBe(join(f.privateRoot, partial[0]));
  rmSync(companion);
  const single = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
  writeFileSync(companion, bytes, { mode: 0o755 });
  expect(() => single.completeRuntimeBundle()).toThrow('runtime unavailable');
  expect(existsSync(join(dirname(single.path), 'codex-code-mode-host'))).toBe(false);
});

it.each(['root-replacement', 'source-hardlink', 'source-symlink'] as const)(
  'retains root and source ancestry protections for %s',
  (kind) => {
    const f = fixture();
    const selected = FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot);
    if (kind === 'root-replacement') {
      renameSync(f.privateRoot, `${f.privateRoot}.old`);
      mkdirSync(f.privateRoot, { mode: 0o700 });
    } else if (kind === 'source-hardlink') linkSync(f.source, `${f.source}.alias`);
    else {
      renameSync(f.source, `${f.source}.old`);
      symlinkSync(`${f.source}.old`, f.source);
    }
    expect(() => selected.assertCurrent()).toThrow('runtime unavailable');
    if (kind !== 'root-replacement')
      expect(() => FrozenHostCodexExecutable.captureReusable(f.source, f.privateRoot)).toThrow(
        'runtime unavailable',
      );
  },
);
