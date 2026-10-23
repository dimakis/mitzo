import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-cached-stat-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, 'one', 'two');
  await mkdir(parent, { recursive: true });
  const file = join(parent, 'source.txt');
  await writeFile(file, 'ORIGINAL SOURCE BYTES');
  let current = true;
  const authorize = vi.fn(async () => {
    if (!current) throw Error('Current owner revoked');
  });
  const access = new LocalRepositoryReadAccess({
    deniedRoots: [],
    captureReadAnchor: fixtureReadAnchor,
    assertReadable: authorize,
    deadline: Date.now() + 15000,
  });
  await access.pinRoot(root);
  const original = await access.stat(file);
  authorize.mockClear();
  return {
    root,
    file,
    access,
    authorize,
    original,
    revoke: () => {
      current = false;
    },
  };
}
it('reuses an observed entry with one current target authorization and no redundant cached ancestor qualification', async () => {
  const f = await fixture();
  expect(await f.access.stat(f.file)).toEqual(f.original);
  expect(f.authorize.mock.calls).toEqual([[f.file]]);
});
it('still refuses cached metadata after current owner revocation', async () => {
  const f = await fixture();
  f.revoke();
  await expect(f.access.stat(f.file)).rejects.toMatchObject({ kind: 'access' });
});
it('never treats cached identity as authority to read a replaced file and final verification refuses it', async () => {
  const f = await fixture();
  await rm(f.file);
  await writeFile(f.file, 'REPLACEMENT BYTES MUST NOT BE RETURNED');
  expect(await f.access.stat(f.file)).toEqual(f.original); // Existing snapshot semantics.
  await expect(f.access.read(f.file, 4096)).rejects.toThrow();
  await expect(f.access.verify()).rejects.toThrow();
});
