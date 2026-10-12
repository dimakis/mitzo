import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { captureOriginalImmutableFile } from '../native-held-file-custody.js';

const roots: string[] = [];
const held: Array<{ close(): void }> = [];
afterEach(() => {
  for (const file of held.splice(0)) file.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'held-native-file-')));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const path = join(root, 'native');
  const bytes = Buffer.alloc(192 * 1024, 7);
  fs.writeFileSync(path, bytes, { mode: 0o500 });
  const assertCurrent = vi.fn();
  const options = {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    maximumBytes: 256 * 1024,
    uid: process.getuid!(),
    assertCurrent,
  };
  const capture = () => {
    const file = captureOriginalImmutableFile(options);
    held.push(file);
    return file;
  };
  return { root, path, bytes, options, assertCurrent, capture };
}
describe('original immutable native file observations', () => {
  it('hashes at capture and explicit wire boundaries, with no body reads during stream polls', () => {
    const f = fixture(),
      file = f.capture();
    expect(fs.readSync).toHaveBeenCalled();
    vi.mocked(fs.readSync).mockClear();
    for (let i = 0; i < 100; i++) file.assertCurrent();
    expect(fs.readSync).not.toHaveBeenCalled();
    file.assertBytesCurrent();
    expect(fs.readSync).toHaveBeenCalled();
    expect(Object.isFrozen(file)).toBe(true);
    expect(Object.keys(file).sort()).toEqual(['assertBytesCurrent', 'assertCurrent', 'close']);
  });
  it('refuses changed bytes even when size and mtime are restored', () => {
    const f = fixture(),
      file = f.capture(),
      old = fs.statSync(f.path);
    fs.chmodSync(f.path, 0o700);
    fs.writeFileSync(f.path, Buffer.alloc(f.bytes.length, 8));
    fs.chmodSync(f.path, 0o500);
    fs.utimesSync(f.path, old.atime, old.mtime);
    expect(() => file.assertCurrent()).toThrow();
    expect(() => file.assertBytesCurrent()).toThrow();
  });
  it('refuses a replaced named inode and replacement of its original parent', () => {
    const f = fixture(),
      file = f.capture();
    fs.renameSync(f.path, join(f.root, 'retained'));
    fs.writeFileSync(f.path, f.bytes, { mode: 0o500 });
    expect(() => file.assertCurrent()).toThrow();
    const g = fixture(),
      original = g.capture(),
      moved = `${g.root}-old`;
    roots.push(moved);
    fs.renameSync(g.root, moved);
    fs.mkdirSync(g.root, { mode: 0o700 });
    fs.writeFileSync(g.path, g.bytes, { mode: 0o500 });
    expect(() => original.assertCurrent()).toThrow();
  });
  it('refuses symlinks, hardlinks, writable-by-others files and wrong hashes', () => {
    const f = fixture();
    fs.symlinkSync(f.path, join(f.root, 'alias'));
    expect(() =>
      captureOriginalImmutableFile({ ...f.options, path: join(f.root, 'alias') }),
    ).toThrow();
    fs.linkSync(f.path, join(f.root, 'hardlink'));
    expect(() => f.capture()).toThrow();
    fs.unlinkSync(join(f.root, 'hardlink'));
    fs.chmodSync(f.path, 0o522);
    expect(() => f.capture()).toThrow();
    fs.chmodSync(f.path, 0o500);
    expect(() => captureOriginalImmutableFile({ ...f.options, sha256: '0'.repeat(64) })).toThrow();
  });
  it('checks original custody before and after full hashing and latches its loss', () => {
    const f = fixture(),
      file = f.capture();
    f.assertCurrent
      .mockReset()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('lost');
      });
    expect(() => file.assertBytesCurrent()).toThrow('lost');
    f.assertCurrent.mockReset();
    expect(() => file.assertCurrent()).toThrow();
  });
  it('refuses asynchronous or false custody, copied methods and use after close', () => {
    const f = fixture();
    expect(() =>
      captureOriginalImmutableFile({ ...f.options, assertCurrent: () => Promise.resolve() }),
    ).toThrow();
    expect(() =>
      captureOriginalImmutableFile({ ...f.options, assertCurrent: () => false }),
    ).toThrow();
    const file = f.capture();
    expect(() => ({ ...file }).assertCurrent()).toThrow();
    file.assertCurrent();
    file.close();
    expect(() => file.assertCurrent()).toThrow();
    file.close();
  });
});
