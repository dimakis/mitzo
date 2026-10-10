import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTerminalNative } from '../prepare-terminal-native.mjs';
it('repairs only the pinned macOS helper executable mode and ignores other platforms', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-pty-install-'));
  try {
    const directory = join(root, 'prebuilds', 'darwin-arm64');
    mkdirSync(directory, { recursive: true });
    const helper = join(directory, 'spawn-helper');
    writeFileSync(helper, 'test', { mode: 0o644 });
    prepareTerminalNative(root, 'linux', 'arm64');
    expect(statSync(helper).mode & 0o111).toBe(0);
    prepareTerminalNative(root, 'darwin', 'arm64');
    expect(statSync(helper).mode & 0o100).toBe(0o100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
