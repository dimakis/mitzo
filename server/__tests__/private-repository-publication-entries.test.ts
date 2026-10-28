import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { capturePrivateRepositoryPublicationEntries } from '../private-repository-publication-entries.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'private-publication-'));
  roots.push(root);
  return root;
}
it('retains every private Git byte and identity with bounded complete owner checks', async () => {
  const root = await fixture();
  await mkdir(join(root, 'objects'));
  await Promise.all(
    Array.from({ length: 512 }, (_, n) =>
      writeFile(join(root, 'objects', String(n)), `object ${n}`),
    ),
  );
  const current = vi.fn();
  const active = vi.fn();
  const entries = await capturePrivateRepositoryPublicationEntries(root, current, active);
  expect(entries).toHaveLength(513);
  for (let n = 0; n < 512; n++) {
    const bytes = `object ${n}`;
    expect(entries.find((entry) => entry.path === `objects/${n}`)).toMatchObject({
      mode: '100644',
      size: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      identity: { dev: expect.stringMatching(/^\d+$/), ino: expect.stringMatching(/^\d+$/) },
    });
  }
  expect(current.mock.calls.length).toBeLessThan(80);
  expect(active.mock.calls.length).toBeGreaterThanOrEqual(512);
});
it.each(['symlink', 'hardlink'] as const)('refuses a private %s', async (kind) => {
  const root = await fixture();
  await writeFile(join(root, 'source'), 'bytes');
  if (kind === 'symlink') await symlink('source', join(root, 'alias'));
  else await link(join(root, 'source'), join(root, 'alias'));
  await expect(
    capturePrivateRepositoryPublicationEntries(
      root,
      () => {},
      () => {},
    ),
  ).rejects.toThrow();
});
it('refuses the complete result when the owner is revoked across an observation batch', async () => {
  const root = await fixture();
  await writeFile(join(root, 'config'), 'bytes');
  let active = true;
  let observations = 0;
  const current = vi.fn(() => {
    if (!active) throw Error('Owner revoked');
  });
  await expect(
    capturePrivateRepositoryPublicationEntries(root, current, () => {
      if (++observations === 3) active = false;
    }),
  ).rejects.toThrow('Owner revoked');
});
it('honors cancellation or expiry inside a batch before continuing private work', async () => {
  const root = await fixture();
  await writeFile(join(root, 'config'), 'bytes');
  await expect(
    capturePrivateRepositoryPublicationEntries(
      root,
      () => {},
      () => {
        throw Error('Expired');
      },
    ),
  ).rejects.toThrow('Expired');
});

it('bounds full owner checks across many empty private object shards', async () => {
  const root = await fixture();
  await Promise.all(Array.from({ length: 512 }, (_, n) => mkdir(join(root, String(n)))));
  const current = vi.fn();
  const entries = await capturePrivateRepositoryPublicationEntries(root, current, () => {});
  expect(entries).toHaveLength(512);
  expect(entries.every((entry) => entry.mode === '040000')).toBe(true);
  expect(current.mock.calls.length).toBeLessThan(80);
});
