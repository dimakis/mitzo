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
