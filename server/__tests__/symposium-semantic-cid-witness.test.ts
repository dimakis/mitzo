import { expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  lstatSync,
  chmodSync,
  renameSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SemanticCidWitnessOwner } from '../symposium-semantic-cid-witness.js';
const binding = () => ({
  jobId: randomUUID(),
  fenceId: 'fence',
  operationId: 'original',
  inputJson: '{"case":"original"}',
  custodyDigest: 'a'.repeat(64),
  codeDigest: 'b'.repeat(64),
  image: 'sha256:' + 'c'.repeat(64),
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'semantic-cid-witness-test-'));
  const db = join(root, 'journal.db');
  writeFileSync(db, '', { mode: 0o600 });
  return { root, owner: new SemanticCidWitnessOwner(db) };
}
it('reserves an absent path and captures native-created mode0644 only with trusted original stdout', () => {
  const { owner } = fixture(),
    b = binding(),
    m = owner.prepare(b);
  expect(existsSync(m.path)).toBe(false);
  writeFileSync(m.path, 'e'.repeat(64), { flag: 'wx', mode: 0o644 });
  expect(() => owner.read(m, b)).toThrow('unconfirmed');
  const captured = owner.confirm(m, b, 'e'.repeat(64));
  expect(lstatSync(m.path).mode & 0o777).toBe(0o600);
  expect(owner.read(captured, b)).toBe('e'.repeat(64));
  expect(() => owner.prepare(b)).toThrow();
  expect(() => owner.read(captured, { ...b, operationId: 'changed' })).toThrow();
});
it.each(['', 'e'.repeat(63), 'e'.repeat(65), 'g'.repeat(64), 'e'.repeat(64) + '\n'])(
  'refuses empty, partial or malformed witness %s',
  (body) => {
    const { owner } = fixture(),
      b = binding(),
      m = owner.prepare(b);
    writeFileSync(m.path, body);
    expect(() => owner.confirm(m, b, 'e'.repeat(64))).toThrow();
  },
);
it.each(['symlink', 'hardlink', 'inode', 'mode'])(
  'refuses changed original witness identity %s',
  (kind) => {
    const { owner } = fixture(),
      b = binding(),
      m = owner.prepare(b);
    writeFileSync(m.path, 'e'.repeat(64), { mode: 0o600 });
    const captured = owner.confirm(m, b, 'e'.repeat(64));
    if (kind === 'mode') chmodSync(m.path, 0o644);
    else {
      renameSync(m.path, m.path + '.old');
      if (kind === 'symlink') symlinkSync(m.path + '.old', m.path);
      else if (kind === 'hardlink') linkSync(m.path + '.old', m.path);
      else writeFileSync(m.path, 'e'.repeat(64), { mode: 0o600 });
    }
    expect(() => owner.read(captured, b)).toThrow();
  },
);

it('refuses high-bit bytes rather than masking them into ASCII hex', () => {
  const { owner } = fixture(),
    b = binding(),
    m = owner.prepare(b);
  writeFileSync(m.path, Buffer.alloc(64, 0xe5));
  expect(() => owner.confirm(m, b, 'e'.repeat(64))).toThrow();
});

it.each(['uid', 'gid', 'path', 'bindingDigest', 'version'])(
  'refuses altered private manifest %s before trusting the recorded CID',
  (field) => {
    const { owner } = fixture(),
      b = binding(),
      m = owner.prepare(b);
    writeFileSync(m.path, 'e'.repeat(64), { mode: 0o600 });
    const captured = owner.confirm(m, b, 'e'.repeat(64));
    if (captured.version !== 2 || !captured.file) throw Error('test capture missing');
    const altered =
      field === 'uid' || field === 'gid'
        ? { ...captured, file: { ...captured.file, [field]: captured.file[field] + 1 } }
        : {
            ...captured,
            [field]:
              field === 'path'
                ? captured.path + '.other'
                : field === 'bindingDigest'
                  ? '1'.repeat(64)
                  : 1,
          };
    expect(() => owner.read(altered, b)).toThrow();
  },
);
it('refuses an existing insecure or linked owner root without preparing a new job', () => {
  const f = fixture(),
    b = binding(),
    m = f.owner.prepare(b);
  const root = m.path.slice(0, m.path.lastIndexOf('/' + b.jobId + '/'));
  chmodSync(root, 0o755);
  expect(() => f.owner.prepare(binding())).toThrow();
});

it('refuses a replaced private parent even when it contains the same original CID inode', async () => {
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { owner } = fixture(),
    b = binding(),
    m = owner.prepare(b);
  writeFileSync(m.path, 'e'.repeat(64), { mode: 0o600 });
  const captured = owner.confirm(m, b, 'e'.repeat(64));
  const parent = dirname(m.path);
  renameSync(parent, parent + '.original');
  mkdirSync(parent, { mode: 0o700 });
  renameSync(join(parent + '.original', 'cid'), m.path);
  expect(() => owner.read(captured, b)).toThrow();
});
