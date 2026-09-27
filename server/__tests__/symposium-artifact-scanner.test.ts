import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_SCANNER } from '../symposium-artifact-scanner.js';
const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
  roots.push(path);
  return path;
}
function scan(path: string, files = 100, bytes = 10000) {
  return JSON.parse(
    execFileSync(
      'python3',
      ['-I', '-c', ARTIFACT_SCANNER, path, String(files), String(bytes), '5'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
}
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
describe('bounded regular-file artifact scanner', () => {
  it('supports empty and uncommitted trees without executing repository configuration', () => {
    const path = root();
    expect(scan(path)).toEqual([]);
    mkdirSync(join(path, '.git'));
    writeFileSync(join(path, '.git/config'), '[core]\nfsmonitor=touch /tmp/must-not-run');
    writeFileSync(join(path, 'draft.txt'), 'draft');
    expect(scan(path)).toEqual([
      {
        path: 'draft.txt',
        executable: false,
        bytes: 5,
        sha256: '7743ce348d9284d677a185f33295b92266cc435a5b5f775029b300066d26693a',
      },
    ]);
  });
  it('rejects links including a linked excluded .git and special files', () => {
    const path = root();
    symlinkSync('/etc/passwd', join(path, '.git'));
    expect(() => scan(path)).toThrow();
    rmSync(join(path, '.git'));
    execFileSync('mkfifo', [join(path, 'fifo')]);
    expect(() => scan(path)).toThrow();
  });
  it('enforces file/entry and byte budgets', () => {
    const path = root();
    writeFileSync(join(path, 'a'), 'abcd');
    expect(() => scan(path, 10, 3)).toThrow();
    mkdirSync(join(path, 'b'));
    expect(() => scan(path, 1)).toThrow();
  });
});
