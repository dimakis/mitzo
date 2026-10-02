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
it('bounds directory enumeration before sorting or traversing entries', () => {
  const path = root();
  const probe = String.raw`
import os
class Entries:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def __iter__(self):
        for i in range(2):
            yield type('Entry', (), {'name': str(i)})()
        raise RuntimeError('enumerated beyond entry budget')
os.scandir = lambda fd: Entries()
os.listdir = lambda fd: (_ for _ in ()).throw(RuntimeError('unbounded enumeration'))
`;
  let error = '';
  try {
    execFileSync('python3', ['-I', '-c', probe + ARTIFACT_SCANNER, path, '1', '100', '5'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (failure) {
    error = String((failure as { stderr: Buffer }).stderr);
  }
  expect(error).toContain('artifact entry limit');
  expect(error).not.toContain('unbounded enumeration');
  expect(error).not.toContain('enumerated beyond entry budget');
});
