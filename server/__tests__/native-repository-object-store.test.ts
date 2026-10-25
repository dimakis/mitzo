import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparationObjectStoreProgram } from '../native-repository-object-store.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const run = async (request: unknown) => {
  const pending = promisify(execFile)(
    '/usr/bin/python3',
    ['-I', '-c', preparationObjectStoreProgram],
    { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1024 * 1024 },
  );
  pending.child.stdin?.end(JSON.stringify(request));
  return JSON.parse((await pending).stdout);
};
it('streams bounded large pack containers to owned scratch and detects source changes without relaxing generic byte reads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-object-store-')));
  roots.push(root);
  const common = join(root, 'common'),
    target = join(root, 'target');
  await mkdir(join(common, 'objects', 'pack'), { recursive: true });
  await mkdir(target);
  const name = 'pack-' + 'a'.repeat(40) + '.pack',
    path = join(common, 'objects', 'pack', name);
  await writeFile(path, Buffer.alloc(17 * 1024 * 1024, 17));
  const anchor = async (rootPath: string) => {
    const s = await stat(rootPath, { bigint: true });
    return { rootPath, identity: { dev: String(s.dev), ino: String(s.ino) } };
  };
  const plan = {
    version: 'preparation-object-store-v1',
    source: await anchor(common),
    target: await anchor(target),
    objectFormat: 'sha1',
    deniedRoots: [],
  };
  const capture = await run({ operation: 'capture', plan });
  expect(capture.files).toMatchObject([{ path: 'pack/' + name, size: 17 * 1024 * 1024 }]);
  expect(
    createHash('sha256')
      .update(await readFile(join(target, 'pack', name)))
      .digest('hex'),
  ).toBe(
    createHash('sha256')
      .update(Buffer.alloc(17 * 1024 * 1024, 17))
      .digest('hex'),
  );
  expect(await run({ operation: 'verify', plan, digest: capture.digest })).toEqual({
    verified: true,
  });
  await writeFile(path, 'changed');
  expect(await run({ operation: 'verify', plan, digest: capture.digest })).toEqual({
    error: 'unavailable',
  });
});
it('refuses linked or denied object storage before copying its bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-object-store-denial-')));
  roots.push(root);
  const common = join(root, 'common'),
    target = join(root, 'target');
  await mkdir(common);
  await mkdir(target);
  await mkdir(join(root, 'private'));
  await writeFile(join(root, 'private', 'sentinel'), 'secret');
  await symlink(join(root, 'private'), join(common, 'objects'));
  const anchor = async (rootPath: string) => {
    const s = await stat(rootPath, { bigint: true });
    return { rootPath, identity: { dev: String(s.dev), ino: String(s.ino) } };
  };
  const plan = {
    version: 'preparation-object-store-v1',
    source: await anchor(common),
    target: await anchor(target),
    objectFormat: 'sha1',
    deniedRoots: [join(root, 'private')],
  };
  expect(await run({ operation: 'capture', plan })).toEqual({ error: 'unavailable' });
  expect(await readFile(join(root, 'private', 'sentinel'), 'utf8')).toBe('secret');
});
