import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import * as sandbox from '../sandboxed-command.js';
import { captureLocalRepositoryReader } from '../local-repository-native-reader.js';
import { repositoryObservationProgram } from '../native-repository-observation.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { captureQualifiedLocalRepositoryTask } from '../qualified-local-repository-task.js';
import type { LocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import type { NativeBaseReadScope } from '../codex-conversation.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const env = {
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { env, encoding: 'utf8' },
  ).trim();
const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
async function fixture(beforeVerify?: (task: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qualified-standalone-observation-')));
  roots.push(root);
  const workspaceId = randomUUID(),
    featureBranch = `mitzo/repo-${workspaceId}`;
  const task = join(root, `repo-${workspaceId}`);
  await mkdir(task);
  git(task, 'init', '--template=', '-q', '-b', featureBranch);
  git(task, 'config', 'user.name', 'Offline');
  git(task, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(task, 'code.txt'), 'selected base');
  git(task, 'add', '.');
  git(task, 'commit', '-qm', 'base');
  const baseOid = git(task, 'rev-parse', 'HEAD');
  // This mechanism receives an already-qualified allocation; the fixture supplies
  // only the retained fields consumed here, never a native creation authorization.
  const facts = {
    layout: 'standalone',
    workspaceId,
    featureBranch,
    baseOid,
    taskRoot: { rootPath: root, identity: await identity(root) },
    source: { objectFormat: 'sha1' },
  } as unknown as LocalRepositoryAllocationFacts;
  const publication = {
    version: 1 as const,
    files: [],
    directories: [
      { directory: task, identity: await identity(task) },
      { directory: join(task, '.git'), identity: await identity(join(task, '.git')) },
    ],
  };
  const abort = new AbortController();
  const observation = vi
    .spyOn(sandbox, 'executePrivateRepositoryObservation')
    .mockImplementation(async (options) => {
      if (JSON.parse(options.requestJson).operation === 'VerifyRepositoryObservation')
        await beforeVerify?.(task);
      const pending = promisify(execFile)(
        '/usr/bin/python3',
        ['-I', '-c', repositoryObservationProgram],
        { env, signal: options.signal, maxBuffer: options.maxOutputBytes },
      );
      pending.child.stdin?.end(options.requestJson);
      return { content: '', stdout: (await pending).stdout, stderr: '', isError: false };
    });
  const individual = vi
    .spyOn(sandbox, 'executePrivateNativeFileHelper')
    .mockImplementation(async () => {
      throw Error('Standalone proof must use a bounded fresh observation');
    });
  const scope = Object.freeze({
    readableRoots: Object.freeze(['/']),
    workspaceRoots: Object.freeze([root]),
    deniedRoots: Object.freeze([]),
  }) as unknown as NativeBaseReadScope;
  const reader = await captureLocalRepositoryReader(
    scope,
    abort.signal,
    () => abort.signal.throwIfAborted(),
    async () => abort.signal.throwIfAborted(),
    { deadline: Date.now() + 30000 },
  );
  return { task, facts, publication, reader, observation, individual };
}

it.skipIf(process.platform !== 'darwin')(
  'qualifies the exact standalone receipt with one fresh capture and verification',
  async () => {
    const f = await fixture();
    try {
      expect(
        await captureQualifiedLocalRepositoryTask(
          new LocalRepositoryReadAccess(f.reader),
          f.facts,
          f.publication,
        ),
      ).toMatchObject({
        directory: f.task,
        featureBranch: f.facts.featureBranch,
        root: {
          dev: Number(f.publication.directories[0].identity.dev),
          ino: Number(f.publication.directories[0].identity.ino),
        },
        git: {
          dev: Number(f.publication.directories[1].identity.dev),
          ino: Number(f.publication.directories[1].identity.ino),
        },
      });
      expect(f.observation).toHaveBeenCalledTimes(2);
      expect(f.individual).not.toHaveBeenCalled();
      expect(await readFile(join(f.task, 'code.txt'), 'utf8')).toBe('selected base');
    } finally {
      await f.reader.dispose();
    }
  },
);

it
  .skipIf(process.platform !== 'darwin')
  .each(['HEAD', 'config', 'index', 'git-root', 'task-root', 'parent-root'] as const)(
  'refuses standalone %s mutation after proof capture before returning custody',
  async (change) => {
    const f = await fixture(async (task) => {
      if (change === 'git-root') {
        await rename(join(task, '.git'), join(task, 'retained-admin'));
        await mkdir(join(task, '.git'));
      } else if (change === 'task-root') {
        await rename(task, task + '-retained');
        await mkdir(task);
      } else if (change === 'parent-root') {
        const parent = dirname(task);
        await rename(parent, parent + '-retained');
        roots.push(parent + '-retained');
        await mkdir(parent);
      } else await writeFile(join(task, '.git', change), 'changed during proof');
    });
    try {
      await expect(
        captureQualifiedLocalRepositoryTask(
          new LocalRepositoryReadAccess(f.reader),
          f.facts,
          f.publication,
        ),
      ).rejects.toThrow('Qualified repository task unavailable');
      expect(f.observation).toHaveBeenCalledTimes(2);
      expect(f.individual).not.toHaveBeenCalled();
    } finally {
      await f.reader.dispose();
    }
  },
);

it
  .skipIf(process.platform !== 'darwin')
  .each(['base', 'branch', 'format', 'task-root', 'task', 'git'] as const)(
  'retains the exact standalone %s allocation and receipt comparison',
  async (change) => {
    const f = await fixture();
    let facts = structuredClone(f.facts);
    const publication = structuredClone(f.publication);
    if (change === 'base') facts = { ...facts, baseOid: 'a'.repeat(40) };
    if (change === 'branch') facts = { ...facts, featureBranch: 'mitzo/other' };
    if (change === 'format')
      facts = { ...facts, source: { ...facts.source, objectFormat: 'sha256' } };
    if (change === 'task-root')
      facts = {
        ...facts,
        taskRoot: { ...facts.taskRoot, identity: { ...facts.taskRoot.identity, ino: '0' } },
      };
    if (change === 'task') publication.directories[0].identity.ino = '0';
    if (change === 'git') publication.directories[1].identity.ino = '0';
    try {
      await expect(
        captureQualifiedLocalRepositoryTask(
          new LocalRepositoryReadAccess(f.reader),
          facts,
          publication,
        ),
      ).rejects.toThrow('Qualified repository task unavailable');
      expect(f.individual).not.toHaveBeenCalled();
    } finally {
      await f.reader.dispose();
    }
  },
);
