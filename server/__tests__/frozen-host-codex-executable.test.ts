import { expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
  renameSync,
  rmSync,
  linkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const reads = vi.hoisted(() => ({ readSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  reads.readSync.mockImplementation(original.readSync);
  return { ...original, readSync: reads.readSync };
});
import {
  FrozenHostCodexExecutable,
  measureHostCodexExecutable,
} from '../frozen-host-codex-executable.js';
it('captures and fences the native code-mode companion with the executable bundle', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-codex-bundle-')));
  try {
    const home = join(root, 'home'),
      source = join(root, 'codex');
    const helper = join(root, 'codex-code-mode-host');
    mkdirSync(home, { mode: 0o700 });
    const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
    writeFileSync(source, bytes, { mode: 0o755 });
    writeFileSync(helper, bytes, { mode: 0o755 });
    const frozen = FrozenHostCodexExecutable.capture(source, home);
    expect(readFileSync(join(home, 'codex-code-mode-host'))).toEqual(bytes);
    const snapshot = frozen.custodySnapshot();
    expect(snapshot.codeModeHost?.path).toBe(join(home, 'codex-code-mode-host'));
    const reopened = FrozenHostCodexExecutable.reopen(snapshot);
    reads.readSync.mockClear();
    reopened.assertCurrent();
    expect(reads.readSync).not.toHaveBeenCalled();
    renameSync(helper, join(root, 'old-helper'));
    writeFileSync(helper, bytes, { mode: 0o755 });
    expect(() => reopened.assertCurrent()).toThrow('Host Codex runtime unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('completes a retained single-binary bundle only through an explicit upgrade without replacing original bytes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-codex-upgrade-')));
  try {
    const home = join(root, 'home'),
      source = join(root, 'codex');
    mkdirSync(home, { mode: 0o700 });
    const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
    writeFileSync(source, bytes, { mode: 0o755 });
    const legacy = FrozenHostCodexExecutable.capture(source, home).custodySnapshot();
    writeFileSync(join(root, 'codex-code-mode-host'), bytes, { mode: 0o755 });
    const restored = FrozenHostCodexExecutable.reopen(legacy);
    expect(existsSync(join(home, 'codex-code-mode-host'))).toBe(false);
    restored.completeRuntimeBundle();
    const { codeModeHost, ...original } = restored.custodySnapshot();
    expect(original).toEqual(legacy);
    expect(codeModeHost?.path).toBe(join(home, 'codex-code-mode-host'));
    restored.completeRuntimeBundle();
    expect(restored.custodySnapshot().codeModeHost).toEqual(codeModeHost);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('refuses a multiply linked native source before reading or creating an owned copy', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-codex-hardlink-')));
  try {
    const home = join(root, 'home'),
      source = join(root, 'codex');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]), { mode: 0o755 });
    linkSync(source, join(root, 'unprotected-alias'));
    reads.readSync.mockClear();
    expect(() => measureHostCodexExecutable(source)).toThrow('Host Codex runtime unavailable');
    expect(() => FrozenHostCodexExecutable.capture(source, home)).toThrow(
      'Host Codex runtime unavailable',
    );
    expect(reads.readSync).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'codex-runtime'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('uses retained immutable native executable bytes and refuses source replacement', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-codex-runtime-')));
  try {
    const home = join(root, 'home'),
      source = join(root, 'codex');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]), { mode: 0o755 });
    const selected = FrozenHostCodexExecutable.capture(source, home);
    expect(selected.path).toBe(join(home, 'codex-runtime'));
    expect(selected.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(selected.path)).toEqual(readFileSync(source));
    expect(statSync(selected.path).mode & 0o777).toBe(0o500);
    expect(measureHostCodexExecutable(source).sha256).toBe(selected.sha256);
    reads.readSync.mockClear();
    selected.assertCurrent();
    expect(reads.readSync).not.toHaveBeenCalled();
    writeFileSync(source, 'replaced');
    expect(() => selected.assertCurrent()).toThrow('Host Codex runtime unavailable');
    expect(readFileSync(selected.path)).toEqual(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(['same-size-write', 'permissions', 'replacement'] as const)(
  'metadata fence detects %s without rehashing streamed boundaries',
  (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-codex-runtime-')));
    try {
      const home = join(root, 'home'),
        source = join(root, 'codex');
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]), { mode: 0o755 });
      const selected = FrozenHostCodexExecutable.capture(source, home);
      if (kind === 'same-size-write')
        writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 3, 2, 1]));
      if (kind === 'permissions') chmodSync(selected.path, 0o700);
      if (kind === 'replacement') {
        renameSync(source, join(root, 'old'));
        writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]), { mode: 0o755 });
      }
      reads.readSync.mockClear();
      expect(() => selected.assertCurrent()).toThrow('Host Codex runtime unavailable');
      expect(reads.readSync).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('refuses scripts whose interpreter or imported package would evade byte identity', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-codex-runtime-')));
  try {
    const home = join(root, 'home'),
      source = join(root, 'codex');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(source, '#!/usr/bin/env node\nrequire("shared-package")', { mode: 0o755 });
    expect(() => FrozenHostCodexExecutable.capture(source, home)).toThrow(
      'Host Codex runtime unavailable',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reopens retained native bytes only from exact physical custody and refuses identical-byte replacement', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-codex-reopen-')));
  try {
    const home = join(root, 'home'),
      source = join(root, 'codex');
    mkdirSync(home, { mode: 0o700 });
    const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
    writeFileSync(source, bytes, { mode: 0o755 });
    const frozen = FrozenHostCodexExecutable.capture(source, home);
    const snapshot = frozen.custodySnapshot();
    const retained = FrozenHostCodexExecutable.reopen(snapshot);
    expect(retained.path).toBe(frozen.path);
    expect(retained.sha256).toBe(frozen.sha256);
    renameSync(frozen.path, join(home, 'old-runtime'));
    writeFileSync(frozen.path, bytes, { mode: 0o500 });
    expect(() => FrozenHostCodexExecutable.reopen(snapshot)).toThrow(
      'Host Codex runtime unavailable',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
