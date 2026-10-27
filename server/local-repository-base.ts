import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, lstat, readdir, statfs, realpath } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { isGitBranchName } from './git-branch.js';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import type { LocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
import { RepositoryHostProcessUncertainError } from './local-repository-host-git.js';

const ref = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value === 'HEAD' ||
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value) ||
      (!value.startsWith('-') && isGitBranchName(value)),
  );
export const RepositoryBaseIntentSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('default') }),
    z.strictObject({ kind: z.literal('ref'), ref }),
  ])
  .default({ kind: 'default' });
export type RepositoryBaseIntent = z.infer<typeof RepositoryBaseIntentSchema>;
export const RepositorySourceIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('existing'),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => isAbsolute(path) && resolve(path) === path && !path.includes('\0')),
  }),
  z.strictObject({
    kind: z.literal('clone'),
    url: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => {
        try {
          validateLocalRepositoryRemote(value);
          return true;
        } catch {
          return false;
        }
      })
      .overwrite(validateLocalRepositoryRemote),
  }),
  z.strictObject({
    kind: z.literal('new'),
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
      .optional(),
  }),
]);
export type RepositorySourceIntent = z.infer<typeof RepositorySourceIntentSchema>;
export function repositorySourceIdentity(source: RepositorySourceIntent): string {
  source = RepositorySourceIntentSchema.parse(source);
  return source.kind === 'existing'
    ? source.path
    : source.kind === 'clone'
      ? `clone:${source.url}`
      : `new:${source.name ?? 'repository'}`;
}
/** A task owns its allocation across calls/restarts. A deliberate new-checkout
 * command supplies its durable command identity as generation, never call ID. */
export function localRepositoryPreparationId(input: {
  conversationId: string;
  workspaceId: string;
  path: string;
  base: RepositoryBaseIntent;
  generation?: string;
}): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'task-local-repository-v1',
        input.conversationId,
        input.workspaceId,
        input.path,
        RepositoryBaseIntentSchema.parse(input.base),
        input.generation ?? null,
      ]),
    )
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** Bounded Git shallow boundaries are metadata, never paths or execution
 * authority. Canonical text also gives publication one exact content digest. */
export function validateLocalRepositoryShallow(
  value: string,
  objectFormat: 'sha1' | 'sha256',
): string {
  if (!value || Buffer.byteLength(value) > 65536)
    throw Error('Repository shallow history is unavailable');
  const lines = value.replace(/\n$/, '').split('\n');
  const oid = new RegExp(`^[a-f0-9]{${objectFormat === 'sha256' ? 64 : 40}}$`);
  if (lines.length > 1024 || lines.some((line) => !oid.test(line)))
    throw Error('Repository shallow history is unavailable');
  return [...new Set(lines)].sort().join('\n') + '\n';
}
export interface ResolvedRepositoryBase {
  repositoryId: string;
  oid: string;
  branch?: string;
  origin: 'remote' | 'local';
}
/** A current, network-authorized owner supplies this runner. It must bind cwd to
 * the exclusively owned directory and use isolated Git configuration/environment.
 * Repository bytes never select the executable, credentials, helper or options. */
export type LocalRepositoryRemoteGit = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;
export interface LocalRepositoryRemoteRequest {
  url: string;
  directory: string;
  base: RepositoryBaseIntent;
  deadline: number;
  signal: AbortSignal;
}
class RepositoryAcquisitionLimitError extends Error {
  constructor() {
    super('Repository acquisition exceeds its storage limit');
  }
}

/** Brand-new local repository only. Hosting is a separately requested action.
 * Fixed empty initial content lets the ordinary task actor use the same pinned
 * commit/materialization contract as existing and cloned repositories. */
export async function initializeLocalRepositorySource(
  directory: string,
  repositoryId: string,
  signal: AbortSignal,
): Promise<ResolvedRepositoryBase> {
  signal.throwIfAborted();
  await mkdir(directory, { mode: 0o700 });
  const execute = promisify(execFile);
  const git = async (args: string[], input?: string) => {
    signal.throwIfAborted();
    const pending = execute('/usr/bin/git', args, {
      cwd: directory,
      signal,
      timeout: 30000,
      maxBuffer: 65536,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Mitzo',
        GIT_AUTHOR_EMAIL: 'mitzo@localhost',
        GIT_COMMITTER_NAME: 'Mitzo',
        GIT_COMMITTER_EMAIL: 'mitzo@localhost',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
    });
    if (input !== undefined) pending.child.stdin?.end(input);
    const result = await pending;
    signal.throwIfAborted();
    return result.stdout.trim();
  };
  await git(['init', '--quiet', '--template=', '--initial-branch=main', directory]);
  const tree = await git(['mktree'], '');
  const oid = await git(['commit-tree', tree, '-m', 'Initialize repository']);
  await git(['update-ref', 'refs/heads/main', oid]);
  return { repositoryId, oid, branch: 'main', origin: 'local' };
}

export function validateLocalRepositoryRemote(value: string): string {
  const unavailable = () => Error('Repository remote is unsupported');
  if (!value || value.length > 4096 || /[\s\0]/.test(value)) throw unavailable();
  // SCP syntax is data-normalized to an explicit protocol; never passed to a
  // shell or to Git's extensible remote-helper dispatch.
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/.exec(value);
  if (scp) value = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unavailable();
  }
  if (
    !['https:', 'ssh:'].includes(url.protocol) ||
    !url.hostname ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === '/' ||
    (url.protocol === 'https:' && url.username) ||
    (url.protocol === 'ssh:' && url.username && !/^[A-Za-z0-9._-]+$/.test(url.username)) ||
    url.hostname.startsWith('-') ||
    /(?:^|\/)\.\.(?:\/|$)/.test(url.pathname)
  )
    throw unavailable();
  return url.href;
}

/** Interpret only this already-authorized config byte stream. Git never reads
 * source files, includes, global config, URL rewrites or executable helpers. */
export async function localRepositoryRemote(config: Buffer): Promise<string> {
  if (config.length > 65536) throw Error('Repository remote is unsupported');
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      '/usr/bin/git',
      ['config', '--no-includes', '--file', '-', '--null', '--get-all', 'remote.origin.url'],
      {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
        timeout: 5000,
        maxBuffer: 16384,
      },
      (error, output) =>
        error ? reject(Error('Repository remote is unsupported')) : resolve(output),
    );
    child.stdin?.end(config);
  });
  const urls = stdout.split('\0').filter(Boolean);
  if (urls.length !== 1) throw Error('Repository remote is unsupported');
  return validateLocalRepositoryRemote(urls[0]);
}

/** Resolve bounded, authorized reference bytes, without allowing Git to load
 * source configuration or treating an object name as proof of commit content. */
export async function readLocalRepositoryBaseReference(
  access: LocalRepositoryReadAccess,
  metadata: LocalRepositoryGitMetadata,
  selected: string,
): Promise<{ oid: string; branch?: string }> {
  RepositoryBaseIntentSchema.parse({ kind: 'ref', ref: selected });
  if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(selected)) return { oid: selected };
  const unavailable = () => Error('Selected repository reference is unavailable');
  const read = async (path: string) => {
    const entry = await access.stat(path);
    if (!entry) return undefined;
    if (entry.kind !== 'file' || entry.nlink !== 1 || entry.size > 16 * 1024 * 1024)
      throw unavailable();
    return (await access.read(path, 16 * 1024 * 1024)).toString('utf8').trim();
  };
  const packed = await read(join(metadata.commonDirectory, 'packed-refs'));
  const packedRefs = new Map<string, string>();
  for (const row of packed?.split('\n') ?? []) {
    if (!row || row.startsWith('#') || row.startsWith('^')) continue;
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) (refs\/[^\r\n\0]+)$/.exec(row);
    if (!match || !isGitBranchName(match[2]) || packedRefs.has(match[2])) throw unavailable();
    packedRefs.set(match[2], match[1]);
  }
  const resolve = async (
    name: string,
    seen = new Set<string>(),
  ): Promise<{ oid: string; branch?: string } | undefined> => {
    if (
      seen.has(name) ||
      seen.size >= 16 ||
      !(name === 'HEAD' || (name.startsWith('refs/') && isGitBranchName(name)))
    )
      throw unavailable();
    seen.add(name);
    const value =
      (await read(
        join(name === 'HEAD' ? metadata.gitDirectory : metadata.commonDirectory, name),
      )) ?? packedRefs.get(name);
    if (!value) return undefined;
    const symbolic = /^ref: (refs\/[^\r\n\0]+)$/.exec(value);
    if (symbolic) return resolve(symbolic[1], seen);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw unavailable();
    return {
      oid: value,
      ...(name.startsWith('refs/heads/') ? { branch: name.slice('refs/heads/'.length) } : {}),
    };
  };
  const candidates =
    selected === 'HEAD' || selected.startsWith('refs/')
      ? [selected]
      : [`refs/heads/${selected}`, `refs/tags/${selected}`, `refs/remotes/${selected}`];
  const matches = [];
  for (const candidate of candidates) {
    const value = await resolve(candidate);
    if (value) matches.push(value);
  }
  if (matches.length !== 1) throw unavailable();
  return matches[0];
}

/** Fresh acquisition into a NEW independent store. No source checkout/config is
 * used as a Git cwd; a failed fetch never becomes an implicit cached/HEAD base. */
export async function acquireRemoteRepositoryBase(
  input: Omit<LocalRepositoryRemoteRequest, 'deadline'> & { repositoryId: string },
  run: LocalRepositoryRemoteGit,
): Promise<ResolvedRepositoryBase> {
  const base = RepositoryBaseIntentSchema.parse(input.base);
  const url = validateLocalRepositoryRemote(input.url);
  input.signal.throwIfAborted();
  if (
    !isAbsolute(input.directory) ||
    resolve(input.directory) !== input.directory ||
    (await realpath(dirname(input.directory))) !== dirname(input.directory)
  )
    throw Error('Repository base acquisition failed');
  const capacity = await statfs(dirname(input.directory));
  if (capacity.bavail * capacity.bsize < 2 * 1024 ** 3 + 256 * 1024 ** 2)
    throw Error('Not enough free space for repository acquisition and task checkout');
  const budget = new AbortController();
  const signal = AbortSignal.any([input.signal, budget.signal]);
  let budgetError: Error | undefined;
  const inspectStorage = async () => {
    let bytes = 0,
      entries = 0;
    const walk = async (path: string): Promise<void> => {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (!info) return; // Fetch atomically renames temporary pack files.
      if (info.isSymbolicLink() || ++entries > 10000) throw new RepositoryAcquisitionLimitError();
      if (info.isDirectory()) {
        for (const name of await readdir(path)) await walk(join(path, name));
      } else if (
        !info.isFile() ||
        info.size > 16 * 1024 * 1024 ||
        (bytes += info.size) > 128 * 1024 * 1024
      )
        throw new RepositoryAcquisitionLimitError();
    };
    await walk(join(input.directory, '.git'));
  };
  const config = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'credential.helper=',
    '-c',
    'http.followRedirects=false',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    '-c',
    'protocol.ssh.allow=always',
  ];
  const execute = async (...args: string[]) => {
    signal.throwIfAborted();
    const result = await run([...config, ...args], signal);
    signal.throwIfAborted();
    if (Buffer.byteLength(result.stdout) > 65536) throw Error('Repository base acquisition failed');
    return result.stdout.trim();
  };
  try {
    let branch: string | undefined;
    let selected: string;
    if (base.kind === 'default') {
      const head = await execute('ls-remote', '--symref', '--', url, 'HEAD');
      const symbolic = /^ref: (refs\/heads\/[^\t\r\n]+)\tHEAD$/m.exec(head);
      if (!symbolic || !isGitBranchName(symbolic[1])) throw Error('Missing remote default branch');
      selected = symbolic[1];
      branch = selected.slice('refs/heads/'.length);
    } else selected = base.ref;
    // Exclusive creation is also the retry fence: the owner must reconcile its
    // retained operation rather than overwrite an existing acquisition.
    await mkdir(input.directory, { mode: 0o700 });
    await execute(
      'init',
      '--quiet',
      '--template=',
      '--initial-branch=mitzo-acquire',
      input.directory,
    );
    const gitDir = join(input.directory, '.git');
    let monitor: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (monitor) return;
      monitor = inspectStorage()
        .catch(() => {
          budgetError = new RepositoryAcquisitionLimitError();
          budget.abort(budgetError);
        })
        .finally(() => {
          monitor = undefined;
        });
    }, 50);
    try {
      await execute(
        '--git-dir',
        gitDir,
        'fetch',
        '--no-tags',
        '--depth=1',
        '--no-write-fetch-head',
        '--',
        url,
        `+${selected}:refs/mitzo/base`,
      );
    } finally {
      clearInterval(timer);
      if (monitor) await monitor;
    }
    await inspectStorage();
    const oid = await execute(
      '--git-dir',
      gitDir,
      'rev-parse',
      '--verify',
      '--end-of-options',
      'refs/mitzo/base^{commit}',
    );
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid)) throw Error('Missing remote commit');
    await execute('--git-dir', gitDir, 'symbolic-ref', 'HEAD', 'refs/heads/mitzo-acquire');
    await execute('--git-dir', gitDir, 'update-ref', 'refs/heads/mitzo-acquire', oid);
    return {
      repositoryId: input.repositoryId,
      oid,
      ...(branch ? { branch } : {}),
      origin: 'remote',
    };
  } catch (error) {
    if (error instanceof RepositoryHostProcessUncertainError) throw error;
    if (error instanceof RepositoryAcquisitionLimitError) throw error;
    input.signal.throwIfAborted();
    if (budgetError) throw budgetError;
    // Error.cause remains private/nonenumerable; the native boundary exposes
    // only this stable message, never a runner's credential-bearing stderr.
    throw Error('Repository base acquisition failed', { cause: error });
  }
}
