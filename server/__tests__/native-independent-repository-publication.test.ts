import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  publishNativePreparedRepository,
  nativePreparationPublicationWriteRoots,
  type NativePreparationPublicationPlan,
} from '../native-preparation-publication.js';
import type { NativeExclusiveTreeEntry } from '../native-tree-publication.js';
import { privateRepositoryCheckoutConfig } from '../private-repository-checkout.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const id = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'standalone-publication-')));
  roots.push(root);
  const source = join(root, 'source'),
    tasks = join(root, 'tasks'),
    scratch = join(root, 'scratch');
  await mkdir(join(source, '.git'), { recursive: true });
  await mkdir(tasks);
  await mkdir(scratch);
  const workspaceId = randomUUID(),
    baseOid = 'a'.repeat(40);
  const sourceAnchor = { rootPath: source, identity: await id(source) };
  const commonAnchor = { rootPath: join(source, '.git'), identity: await id(join(source, '.git')) };
  const taskRoot = { rootPath: tasks, identity: await id(tasks) },
    scratchAnchor = { rootPath: scratch, identity: await id(scratch) };
  const tree = async (name: string, contents: Record<string, string>) => {
    const directory = join(scratch, name);
    await mkdir(directory);
    const entries: NativeExclusiveTreeEntry[] = [],
      directories = new Set<string>();
    for (const path of Object.keys(contents)) {
      const parts = path.split('/');
      for (let count = 1; count < parts.length; count++)
        directories.add(parts.slice(0, count).join('/'));
    }
    for (const path of [...directories].sort()) {
      await mkdir(join(directory, path));
      entries.push({
        path,
        mode: '040000',
        identity: await id(join(directory, path)),
        size: 0,
        sha256: sha(''),
      });
    }
    for (const [path, value] of Object.entries(contents)) {
      await writeFile(join(directory, path), value);
      entries.push({
        path,
        mode: '100644',
        identity: await id(join(directory, path)),
        size: Buffer.byteLength(value),
        sha256: sha(value),
      });
    }
    return {
      payload: {
        file_path: directory,
        rootAnchor: scratchAnchor,
        parentIdentity: scratchAnchor.identity,
        identity: await id(directory),
      },
      entries,
    };
  };
  const plan: NativePreparationPublicationPlan = {
    version: 'prepared-repository-publication-v1',
    layout: 'standalone',
    requestSha256: '1'.repeat(64),
    allocationFactsSha256: '2'.repeat(64),
    scopeSha256: '3'.repeat(64),
    workspaceId,
    baseOid,
    sourcePath: source,
    sourceAnchor,
    commonAnchor,
    taskRoot,
    directories: [],
    existingDirectories: [{ directory: tasks, identity: taskRoot.identity }],
    packedRefs: { kind: 'absent' },
    metadata: [],
    deniedRoots: [],
    tree: await tree('checkout', { 'code.txt': 'tracked content' }),
    standaloneGit: await tree('git', {
      HEAD: `ref: refs/heads/mitzo/repo-${workspaceId}\n`,
      config: privateRepositoryCheckoutConfig('sha1').replace('bare = true', 'bare = false'),
      [`refs/heads/mitzo/repo-${workspaceId}`]: baseOid + '\n',
      ['objects/aa/' + 'a'.repeat(38)]: 'opaque object',
    }),
  };
  return { root, plan, task: join(tasks, `repo-${workspaceId}`), source };
}
it('publishes independent Git administration with no source effects through the fixed helper', async () => {
  const f = await fixture();
  const writes = nativePreparationPublicationWriteRoots(f.plan).map((entry) => entry.path);
  expect(writes.some((path) => path.startsWith(f.source))).toBe(false);
  const receipt = await publishNativePreparedRepository(
    f.plan,
    new AbortController().signal,
    15000,
    async (invocation) => {
      const result = await execute('/bin/sh', ['-c', invocation.command], {
        signal: invocation.signal,
        maxBuffer: invocation.maxOutputBytes,
      });
      return { stdout: result.stdout, isError: false };
    },
  );
  expect(receipt.directories.map((entry) => entry.directory)).toEqual([
    f.task,
    join(f.task, '.git'),
  ]);
  expect(await readFile(join(f.task, 'code.txt'), 'utf8')).toBe('tracked content');
  expect(await readFile(join(f.task, '.git', 'HEAD'), 'utf8')).toContain(f.plan.workspaceId);
  await expect(lstat(join(f.source, '.git', 'worktrees'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('refuses occupied destinations and executable/private Git metadata before any task effects', async () => {
  const f = await fixture();
  const launch = async (invocation: {
    command: string;
    signal: AbortSignal;
    maxOutputBytes: number;
  }) => {
    const result = await execute('/bin/sh', ['-c', invocation.command], {
      signal: invocation.signal,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout: result.stdout, isError: false };
  };
  const git = f.plan.standaloneGit!;
  await expect(
    publishNativePreparedRepository(
      {
        ...f.plan,
        standaloneGit: {
          ...git,
          entries: [
            ...git.entries,
            {
              ...git.entries.find((entry) => entry.path === 'config')!,
              path: 'hooks/post-checkout',
            },
          ],
        },
      },
      new AbortController().signal,
      15000,
      launch,
    ),
  ).rejects.toThrow();
  await expect(lstat(f.task)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(f.task);
  await writeFile(join(f.task, 'foreign'), 'preserve');
  await expect(
    publishNativePreparedRepository(f.plan, new AbortController().signal, 15000, launch),
  ).rejects.toThrow();
  expect(await readFile(join(f.task, 'foreign'), 'utf8')).toBe('preserve');
});
