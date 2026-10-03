import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ICloudBackupTransport } from '../backup/icloud-transport.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mitzo-backup-test-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const cloud = join(root, 'cloud');
  await mkdir(join(repo, 'data', 'aa'), { recursive: true });
  await mkdir(join(repo, 'keys'));
  await mkdir(join(repo, 'snapshots'));
  await mkdir(join(repo, 'index'));
  await writeFile(join(repo, 'config'), 'encrypted-repository-config');
  await writeFile(join(repo, 'keys', 'a'.repeat(64)), 'encrypted-key');
  await writeFile(join(repo, 'data', 'aa', 'a'.repeat(64)), 'encrypted-shared-pack');
  await writeFile(join(repo, 'snapshots', 'b'.repeat(64)), 'encrypted-snapshot');
  return { root, repo, cloud };
}
describe('immutable iCloud transport', () => {
  it('deduplicates encrypted objects across generations and restores without the source', async () => {
    const { root, repo, cloud } = await fixture();
    const transport = new ICloudBackupTransport(cloud, async () => 'uploaded');
    const first = await transport.publish(repo);
    const objectCount = (await readdir(join(cloud, 'objects'))).length;
    await writeFile(join(repo, 'snapshots', 'c'.repeat(64)), 'encrypted-new-snapshot');
    const second = await transport.publish(repo);
    expect((await readdir(join(cloud, 'objects'))).length).toBe(objectCount + 1);
    expect(first.status).toBe('uploaded');
    await rm(repo, { recursive: true });
    const restored = join(root, 'restored');
    await transport.restore(second.id, restored);
    expect(await readFile(join(restored, 'data', 'aa', 'a'.repeat(64)), 'utf8')).toBe(
      'encrypted-shared-pack',
    );
  });
  it('never calls a local copy a confirmed upload and can resume after restart', async () => {
    const { repo, cloud } = await fixture();
    const pending = await new ICloudBackupTransport(cloud, async () => 'pending').publish(repo);
    expect(pending.status).toBe('pending');
    const completed = await new ICloudBackupTransport(cloud, async () => 'uploaded').refresh(
      pending.id,
    );
    expect(completed.status).toBe('uploaded');
  });
  it('fails verification if a required encrypted object is corrupt', async () => {
    const { root, repo, cloud } = await fixture();
    const transport = new ICloudBackupTransport(cloud, async () => 'uploaded');
    const generation = await transport.publish(repo);
    const files = await readdir(join(cloud, 'objects'));
    await writeFile(join(cloud, 'objects', files[0]), 'corrupt');
    await expect(transport.refresh(generation.id)).rejects.toThrow('integrity');
    await expect(transport.restore(generation.id, join(root, 'restore'))).rejects.toThrow(
      'integrity',
    );
  });
  it('rejects symlinks and arbitrary non-repository material before exporting it', async () => {
    const { root, repo, cloud } = await fixture();
    await writeFile(join(root, 'secret'), 'PRIVATE');
    await symlink(join(root, 'secret'), join(repo, 'index', 'd'.repeat(64)));
    const transport = new ICloudBackupTransport(cloud, async () => 'uploaded');
    await expect(transport.publish(repo)).rejects.toThrow();
    await rm(join(repo, 'index', 'd'.repeat(64)));
    await writeFile(join(repo, 'private.txt'), 'PRIVATE');
    await expect(transport.publish(repo)).rejects.toThrow();
  });
  it('rejects traversal in a catalog without creating the restore directory', async () => {
    const { root, repo, cloud } = await fixture();
    const transport = new ICloudBackupTransport(cloud, async () => 'uploaded');
    const generation = await transport.publish(repo);
    const catalog = join(cloud, 'generations', generation.id + '.json');
    const value = JSON.parse(await readFile(catalog, 'utf8'));
    value.files[0].path = '../escape';
    await writeFile(catalog, JSON.stringify(value));
    await expect(transport.restore(generation.id, join(root, 'restore'))).rejects.toThrow();
    expect(await readdir(root)).not.toContain('restore');
  });
  it('refuses to overwrite an existing restore workspace', async () => {
    const { root, repo, cloud } = await fixture();
    const transport = new ICloudBackupTransport(cloud, async () => 'uploaded');
    const generation = await transport.publish(repo);
    const target = join(root, 'restore');
    await mkdir(target);
    await writeFile(join(target, 'newer-work'), 'preserve');
    await expect(transport.restore(generation.id, target)).rejects.toThrow();
    expect(await readFile(join(target, 'newer-work'), 'utf8')).toBe('preserve');
  });
});
