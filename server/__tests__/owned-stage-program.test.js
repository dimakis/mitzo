import { afterEach, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  preparePinnedProgram,
  assertPinnedProgram,
} from '../../scripts/lib/owned-stage-program.mjs';

const fixtures = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-program-')));
  fixtures.push(root);
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'symposium'), { mode: 0o700 });
  const input = join(root, 'public-codex');
  const data = Buffer.from('synthetic native program fixture');
  writeFileSync(input, data, { mode: 0o500 });
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { root, input, data, sha256, parent: join(root, 'symposium/bin') };
}

it('creates the missing canonical bin privately and verifies the pinned copy without executing it', () => {
  const f = fixture();
  const prepared = preparePinnedProgram(f.root, f.input, f.sha256);
  expect(prepared.pin).toEqual({
    executable: join(f.parent, 'codex-device-auth-' + f.sha256.slice(0, 12)),
    sha256: f.sha256,
  });
  expect(lstatSync(f.parent).mode & 0o7777).toBe(0o700);
  expect(lstatSync(prepared.pin.executable).mode & 0o7777).toBe(0o500);
  expect(readFileSync(prepared.pin.executable)).toEqual(f.data);
  expect(() => assertPinnedProgram(f.root, prepared.pin, prepared.metadata)).not.toThrow();
  expect(preparePinnedProgram(f.root, f.input, f.sha256)).toEqual(prepared);
});

it.each([0o755, 0o770, 0o1700])(
  'refuses existing bin permissions %o without repairing them',
  (mode) => {
    const f = fixture();
    mkdirSync(f.parent, { mode });
    chmodSync(f.parent, mode);
    expect(() => preparePinnedProgram(f.root, f.input, f.sha256)).toThrow();
    expect(lstatSync(f.parent).mode & 0o7777).toBe(mode);
  },
);

it('refuses an aliased bin without writing into its target', () => {
  const f = fixture();
  const other = join(f.root, 'other');
  mkdirSync(other, { mode: 0o700 });
  symlinkSync(other, f.parent);
  expect(() => preparePinnedProgram(f.root, f.input, f.sha256)).toThrow();
  expect(lstatSync(f.parent).isSymbolicLink()).toBe(true);
});

it('refuses an aliased parent before creating bin', () => {
  const f = fixture();
  renameSync(join(f.root, 'symposium'), join(f.root, 'other'));
  symlinkSync(join(f.root, 'other'), join(f.root, 'symposium'));
  expect(() => preparePinnedProgram(f.root, f.input, f.sha256)).toThrow();
  expect(lstatSync(join(f.root, 'other/bin'), { throwIfNoEntry: false })).toBeUndefined();
});

// This host strips setuid/setgid on chmod; sticky persists and tests special-mode refusal.
it.each([0o400, 0o600, 0o700, 0o550, 0o1500])(
  'rejects pinned mode drift %o even with matching bytes',
  (mode) => {
    const f = fixture();
    const prepared = preparePinnedProgram(f.root, f.input, f.sha256);
    chmodSync(prepared.pin.executable, mode);
    expect(() => assertPinnedProgram(f.root, prepared.pin, prepared.metadata)).toThrow();
  },
);

it.each([
  'symlink',
  'hardlink',
  'replacement',
  'hash',
  'size',
  'parent-mode',
  'parent-replacement',
])('rejects pinned %s drift before service control', (kind) => {
  const f = fixture();
  const prepared = preparePinnedProgram(f.root, f.input, f.sha256);
  const path = prepared.pin.executable;
  if (kind === 'hardlink') linkSync(path, join(f.root, 'alias'));
  if (kind === 'symlink' || kind === 'replacement') {
    unlinkSync(path);
    if (kind === 'symlink') symlinkSync(f.input, path);
    else writeFileSync(path, f.data, { mode: 0o500 });
  }
  if (kind === 'hash' || kind === 'size') {
    chmodSync(path, 0o700);
    if (kind === 'hash') writeFileSync(path, Buffer.alloc(f.data.length, 42));
    else truncateSync(path, 256 * 1024 * 1024 + 1);
    chmodSync(path, 0o500);
  }
  if (kind === 'parent-mode') chmodSync(f.parent, 0o750);
  if (kind === 'parent-replacement') {
    renameSync(f.parent, f.parent + '-original');
    mkdirSync(f.parent, { mode: 0o700 });
    renameSync(join(f.parent + '-original', path.split('/').at(-1)), path);
  }
  expect(() => assertPinnedProgram(f.root, prepared.pin, prepared.metadata)).toThrow();
});

it('rejects missing or altered metadata and off-path pins', () => {
  const f = fixture();
  const prepared = preparePinnedProgram(f.root, f.input, f.sha256);
  expect(() => assertPinnedProgram(f.root, prepared.pin)).toThrow();
  expect(() =>
    assertPinnedProgram(f.root, prepared.pin, {
      ...prepared.metadata,
      file: { ...prepared.metadata.file, uid: process.getuid() + 1 },
    }),
  ).toThrow();
  expect(() =>
    assertPinnedProgram(f.root, { ...prepared.pin, executable: f.input }, prepared.metadata),
  ).toThrow();
});

it.each(['mode', 'hash', 'size', 'hardlink', 'symlink'])(
  'rejects unsafe input %s before provisioning',
  (kind) => {
    const f = fixture();
    if (kind === 'mode') chmodSync(f.input, 0o400);
    if (kind === 'hash') f.sha256 = '0'.repeat(64);
    if (kind === 'size') {
      chmodSync(f.input, 0o700);
      truncateSync(f.input, 256 * 1024 * 1024 + 1);
    }
    if (kind === 'hardlink') linkSync(f.input, join(f.root, 'alias'));
    if (kind === 'symlink') {
      renameSync(f.input, f.input + '-original');
      symlinkSync(f.input + '-original', f.input);
    }
    expect(() => preparePinnedProgram(f.root, f.input, f.sha256)).toThrow();
    expect(lstatSync(f.parent, { throwIfNoEntry: false })).toBeUndefined();
  },
);
