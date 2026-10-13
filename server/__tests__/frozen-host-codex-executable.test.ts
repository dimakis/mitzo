import { expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';
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
    selected.assertCurrent();
    writeFileSync(source, 'replaced');
    expect(() => selected.assertCurrent()).toThrow('Host Codex runtime unavailable');
    expect(readFileSync(selected.path)).toEqual(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
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
