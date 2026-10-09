import { knowledgeHostCommand } from './knowledge-host-command.js';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { protectCodexProfileRoots } from './codex-private-path.js';
import { AcceptedKnowledgeSource, safeKnowledgePath } from './knowledge-library-source.js';
import { KnowledgeDraftStore } from './knowledge-draft-store.js';
import { KnowledgeReviewService } from './knowledge-review-service.js';
import { KnowledgeGithubPublisher } from './knowledge-github-publisher.js';
import { type GithubHostCommandRunner } from './connections/capabilities/github-publish-pr-transport.js';

const branch = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
  .refine(
    (value) =>
      !value.includes('..') &&
      !value.includes('//') &&
      !value.endsWith('/') &&
      !value.endsWith('.lock') &&
      !value.includes('@{'),
  );
const login = z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i);
const configuration = z
  .object({
    repository: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9][a-z0-9_.-]{0,99}$/),
    acceptedBranch: branch.default('main'),
    documentPaths: z
      .array(
        z
          .string()
          .refine((path) => safeKnowledgePath(path.endsWith('.md') ? path : path + '/document.md')),
      )
      .min(1)
      .max(100),
    stateDirectory: z.string().refine(isAbsolute),
    publisherLogin: login.optional(),
    trustedReviewer: login.optional(),
    acceptanceEnabled: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => !value.acceptanceEnabled || !!value.publisherLogin,
    'Acceptance requires explicit publisher enrollment',
  )
  .refine(
    (value) => new Set(value.documentPaths).size === value.documentPaths.length,
    'Duplicate document scopes',
  );

function physical(path: string): string {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  const parent = dirname(full);
  return parent === full
    ? full
    : join(physical(parent), full.slice(parent.length + (parent === sep ? 0 : 1)));
}
function overlaps(left: string, right: string) {
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
}
function outsideWorkspaces(path: string, workspaces: string[]) {
  const absolute = resolve(path);
  if (physical(path) !== absolute)
    throw new Error('Knowledge host storage must use a physical path');
  if (workspaces.some((root) => overlaps(physical(root), absolute)))
    throw new Error('Knowledge host storage overlaps a workspace');
  for (let ancestor = absolute; ; ancestor = dirname(ancestor)) {
    if (
      existsSync(join(ancestor, '.git')) ||
      (existsSync(join(ancestor, 'HEAD')) &&
        existsSync(join(ancestor, 'objects')) &&
        existsSync(join(ancestor, 'refs')))
    )
      throw new Error('Knowledge host storage is inside a Git checkout');
    if (ancestor === dirname(ancestor)) break;
  }
}
function privatePath(path: string, kind: 'file' | 'directory') {
  const stat = lstatSync(path);
  if (
    realpathSync(path) !== resolve(path) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (kind === 'file' ? !stat.isFile() : !stat.isDirectory())
  )
    throw new Error('Knowledge host storage must be private, physical and owned by this user');
}
export interface KnowledgeLibraryRuntime {
  source: AcceptedKnowledgeSource;
  store: KnowledgeDraftStore;
  publisher?: KnowledgeGithubPublisher;
  reviewService?: KnowledgeReviewService;
  reviewEnabled: boolean;
  acceptanceEnabled: boolean;
  readonly syncedAt: string | null;
  refresh(): Promise<void>;
  close(): void;
}
export interface KnowledgeLibraryRuntimeOptions {
  /** Test-only dependency injection; production always uses the bounded sanitized host runner. */
  runHost?: GithubHostCommandRunner;
  workspaceRoots?: string[];
}
/** Host enrollment only. Never infer a repository or read a task checkout as a knowledge source. */
export async function knowledgeLibraryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: KnowledgeLibraryRuntimeOptions = {},
): Promise<KnowledgeLibraryRuntime | undefined> {
  const configPath = env.MITZO_KNOWLEDGE_LIBRARY_CONFIG;
  if (!configPath) return undefined;
  if (!isAbsolute(configPath)) throw new Error('Knowledge library config must be absolute');
  protectCodexProfileRoots([configPath]);
  const workspaces = [
    process.cwd(),
    ...(env.REPO_PATH ? [env.REPO_PATH] : []),
    ...(options.workspaceRoots ?? []),
  ];
  outsideWorkspaces(configPath, workspaces);
  privatePath(configPath, 'file');
  privatePath(dirname(configPath), 'directory');
  if (lstatSync(configPath).size > 64 * 1024)
    throw new Error('Knowledge library config exceeds the limit');
  const config = configuration.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  protectCodexProfileRoots([config.stateDirectory]);
  outsideWorkspaces(config.stateDirectory, workspaces);
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  privatePath(config.stateDirectory, 'directory');
  const directory = join(config.stateDirectory, 'source.git');
  const expectedOrigin = `https://github.com/${config.repository}.git`;
  const refspec = `+refs/heads/${config.acceptedBranch}:refs/remotes/origin/${config.acceptedBranch}`;
  const runner = options.runHost ?? knowledgeHostCommand;
  const run = async (args: string[], signal: AbortSignal = AbortSignal.timeout(30_000)) =>
    runner('git', args, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  if (!existsSync(directory)) {
    await run(['init', '--bare', '--template=', directory]);
    await chmod(directory, 0o700);
    await run(['-C', directory, 'remote', 'add', '--no-tags', 'origin', expectedOrigin]);
    await run([
      '-C',
      directory,
      'config',
      '--local',
      '--replace-all',
      'remote.origin.fetch',
      refspec,
    ]);
  }
  const verifyMirror = async () => {
    privatePath(config.stateDirectory, 'directory');
    privatePath(directory, 'directory');
    for (const name of ['config', 'HEAD', 'objects', 'refs']) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (
        realpathSync(path) !== path ||
        stat.uid !== process.getuid?.() ||
        (['objects', 'refs'].includes(name) ? !stat.isDirectory() : !stat.isFile())
      )
        throw new Error('Knowledge mirror structure changed');
    }
    for (const name of [
      'objects/info/alternates',
      'objects/info/http-alternates',
      'commondir',
      'gitdir',
    ])
      if (existsSync(join(directory, name)))
        throw new Error('Knowledge mirror has external object storage');
    const bare = await run(['-C', directory, 'rev-parse', '--is-bare-repository']);
    if (bare.stdout.trim() !== 'true') throw new Error('Knowledge mirror is not bare');
    const settings = (
      await run(['-C', directory, 'config', '--local', '--no-includes', '--list', '--null'])
    ).stdout
      .split('\0')
      .filter(Boolean)
      .map((row) => row.split('\n'));
    const allowed = new Map([
      ['core.repositoryformatversion', '0'],
      ['core.filemode', 'true'],
      ['core.bare', 'true'],
      ['core.ignorecase', 'true'],
      ['core.precomposeunicode', 'true'],
      ['remote.origin.url', expectedOrigin],
      ['remote.origin.fetch', refspec],
      ['remote.origin.tagopt', '--no-tags'],
    ]);
    if (
      settings.some(([key, value]) => allowed.get(key!) !== value) ||
      settings.filter(([key]) => key === 'remote.origin.url').length !== 1 ||
      settings.filter(([key]) => key === 'remote.origin.fetch').length !== 1
    )
      throw new Error('Knowledge mirror configuration differs from enrollment');
  };
  await verifyMirror();
  const source = new AcceptedKnowledgeSource(
    directory,
    `refs/remotes/origin/${config.acceptedBranch}`,
    config.documentPaths,
  );
  const synchronizationPath = join(config.stateDirectory, 'synchronization.json');
  let syncedAt: string | undefined;
  if (existsSync(synchronizationPath)) {
    privatePath(synchronizationPath, 'file');
    const sync = z
      .object({
        repository: z.literal(config.repository),
        acceptedBranch: z.literal(config.acceptedBranch),
        syncedAt: z.iso.datetime(),
      })
      .strict()
      .parse(JSON.parse(readFileSync(synchronizationPath, 'utf8')));
    syncedAt = sync.syncedAt;
  }
  let refreshPromise: Promise<void> | undefined;
  const refresh = () =>
    (refreshPromise ??= (async () => {
      outsideWorkspaces(config.stateDirectory, workspaces);
      await verifyMirror();
      await run(
        [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'protocol.file.allow=never',
          '-c',
          'protocol.ext.allow=never',
          '-C',
          directory,
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          'origin',
          refspec,
        ],
        AbortSignal.timeout(60_000),
      );
      await source.revision();
      const timestamp = new Date().toISOString();
      const pending = synchronizationPath + '.pending';
      // A previous interrupted sync file is never followed through a symlink.
      if (existsSync(pending)) privatePath(pending, 'file');
      await writeFile(
        pending,
        JSON.stringify({
          repository: config.repository,
          acceptedBranch: config.acceptedBranch,
          syncedAt: timestamp,
        }),
        { mode: 0o600 },
      );
      await rename(pending, synchronizationPath);
      syncedAt = timestamp;
    })().finally(() => {
      refreshPromise = undefined;
    }));
  try {
    await source.revision();
  } catch {
    await refresh();
  }
  const databasePath = join(config.stateDirectory, 'drafts.sqlite');
  if (existsSync(databasePath)) privatePath(databasePath, 'file');
  for (const suffix of ['-wal', '-shm'])
    if (existsSync(databasePath + suffix)) privatePath(databasePath + suffix, 'file');
  // SQLite opens an existing private file; its WAL is protected by the private parent.
  if (!existsSync(databasePath)) await writeFile(databasePath, '', { mode: 0o600, flag: 'wx' });
  const store = new KnowledgeDraftStore(databasePath);
  const publisher = config.publisherLogin
    ? new KnowledgeGithubPublisher(
        {
          repository: config.repository,
          baseBranch: config.acceptedBranch,
          publisherLogin: config.publisherLogin,
          trustedReviewer: config.trustedReviewer ?? config.repository.split('/')[0]!,
          acceptanceEnabled: config.acceptanceEnabled,
        },
        runner,
      )
    : undefined;
  return {
    source,
    store,
    publisher,
    reviewService: publisher
      ? new KnowledgeReviewService(source, store, publisher, {
          repository: config.repository,
          baseBranch: config.acceptedBranch,
          publisherLogin: config.publisherLogin!,
        })
      : undefined,
    reviewEnabled: !!publisher,
    acceptanceEnabled: config.acceptanceEnabled,
    get syncedAt() {
      return syncedAt ?? null;
    },
    refresh,
    close() {
      store.close();
    },
  };
}
