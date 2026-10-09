import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
const MAX_REPOSITORY_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const branch = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
      !value.includes('..') &&
      !value.includes('//') &&
      value
        .split('/')
        .every((part) => !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')),
  );
export const GithubRepositoryPreviewSchema = z.strictObject({
  repository: z.string(),
  baseBranch: branch,
  baseOid: oid,
});
export type GithubRepositoryPreview = z.infer<typeof GithubRepositoryPreviewSchema>;
export type GithubRepositoryCommand = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;

/** Fixed controller environment: no repository/global hooks, filters, templates or URL rewrites. */
export const runGithubRepositoryCommand: GithubRepositoryCommand = async (
  command,
  args,
  signal,
) => {
  try {
    return await exec(command, [...args], {
      signal,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        GH_HOST: 'github.com',
        ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
        ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/dev/null',
        GIT_CONFIG_KEY_1: 'core.fsmonitor',
        GIT_CONFIG_VALUE_1: 'false',
        GIT_CONFIG_KEY_2: 'credential.helper',
        GIT_CONFIG_VALUE_2: '!gh auth git-credential',
        GIT_CONFIG_KEY_3: 'http.followRedirects',
        GIT_CONFIG_VALUE_3: 'false',
      },
    });
  } catch {
    // Credential helpers and HTTP failures may contain secrets. Never expose their output.
    throw new Error('GitHub repository acquisition failed; check the selected connection');
  }
};

export function canonicalRepositorySelection(value: string): string {
  let name = value;
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Select a GitHub owner/repository or canonical HTTPS URL');
    name = url.pathname.slice(1);
  }
  name = name.replace(/\.git$/, '').toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(
      name,
    ) ||
    name.includes('..')
  )
    throw new Error('Select a GitHub owner/repository or canonical HTTPS URL');
  return name;
}

export async function inspectGithubRepositorySource(
  selected: string,
  signal: AbortSignal,
  run = runGithubRepositoryCommand,
): Promise<GithubRepositoryPreview> {
  const repository = canonicalRepositorySelection(selected);
  const response = await run(
    'gh',
    ['api', '--hostname', 'github.com', '--method', 'GET', `repos/${repository}`],
    signal,
  );
  const metadata = z
    .object({
      full_name: z.string(),
      default_branch: branch,
      size: z.number().nonnegative(),
      archived: z.boolean(),
    })
    .parse(JSON.parse(response.stdout));
  if (canonicalRepositorySelection(metadata.full_name) !== repository)
    throw new Error('GitHub repository identity changed');
  if (metadata.size * 1024 > MAX_REPOSITORY_BYTES)
    throw new Error('Repository exceeds the initial 64 MiB source limit');
  const selectedBranch = await run(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      `repos/${repository}/branches/${encodeURIComponent(metadata.default_branch)}`,
    ],
    signal,
  );
  const remote = z
    .object({ name: branch, commit: z.object({ sha: oid }) })
    .parse(JSON.parse(selectedBranch.stdout));
  if (remote.name !== metadata.default_branch) throw new Error('GitHub starting branch changed');
  return { repository, baseBranch: remote.name, baseOid: remote.commit.sha };
}

async function boundedDirectory(directory: string): Promise<number> {
  let count = 0,
    bytes = 0;
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > 100000 || entry.isSymbolicLink())
        throw new Error('Repository storage is unsupported');
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) bytes += (await stat(child)).size;
      else throw new Error('Repository storage is unsupported');
      if (bytes > MAX_REPOSITORY_BYTES)
        throw new Error('Repository exceeds the initial 64 MiB source limit');
    }
  }
  await walk(directory);
  return bytes;
}

/** Destination is controller-selected and exclusively reserved; no existing checkout is altered. */
export async function prepareGithubRepositorySource(
  input: GithubRepositoryPreview,
  directory: string,
  featureBranch: string,
  signal: AbortSignal,
  run = runGithubRepositoryCommand,
) {
  const preview = GithubRepositoryPreviewSchema.parse(input);
  if (canonicalRepositorySelection(preview.repository) !== preview.repository)
    throw new Error('Repository identity is invalid');
  branch.parse(featureBranch);
  if (featureBranch === preview.baseBranch) throw new Error('Select a feature branch');
  if (
    resolve(directory) !== directory ||
    (await realpath(dirname(directory))) !== dirname(directory)
  )
    throw new Error('Repository destination must have a canonical parent');
  await mkdir(directory, { mode: 0o700 }); // No recursive creation or existing-destination fallback.
  const gitdir = join(directory, '.git');
  const git = async (...args: string[]) =>
    (
      await run(
        'git',
        [
          '--git-dir=' + gitdir,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        signal,
      )
    ).stdout.trim();
  try {
    await run(
      'git',
      [
        'clone',
        '--bare',
        '--no-hardlinks',
        '--single-branch',
        '--template=',
        '--branch',
        preview.baseBranch,
        `https://github.com/${preview.repository}.git`,
        gitdir,
      ],
      signal,
    );
    await boundedDirectory(gitdir);
    if ((await git('rev-parse', 'HEAD')) !== preview.baseOid)
      throw new Error('Starting commit changed; preview the repository again');
    const tree = (await git('ls-tree', '-r', '-l', '-z', '--full-tree', preview.baseOid))
      .split('\0')
      .filter(Boolean);
    if (tree.length > MAX_FILES)
      throw new Error('Repository exceeds the initial 10,000-file limit');
    let bytes = 0;
    const names = new Map<string, { spelling: string; kind: 'file' | 'directory' }>();
    for (const entry of tree) {
      const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/s.exec(entry);
      if (!match)
        throw new Error('Symlinks and submodules are unsupported in this initial source importer');
      const name = match[4]!;
      const parts = name.split('/');
      if (
        [...name].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\',
        ) ||
        parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
      )
        throw new Error('Repository paths are unsupported');
      let spelling = '',
        normalized = '';
      for (let index = 0; index < parts.length; index++) {
        const separator = index ? '/' : '';
        spelling += separator + parts[index];
        normalized += separator + parts[index].normalize('NFC').toLowerCase();
        const kind = index === parts.length - 1 ? 'file' : 'directory';
        const existing = names.get(normalized);
        if (
          existing &&
          (existing.spelling !== spelling || existing.kind !== kind || kind === 'file')
        )
          throw new Error('Repository paths are unsupported');
        names.set(normalized, { spelling, kind });
      }
      bytes += Number(match[3]!);
      if (!Number.isSafeInteger(bytes) || bytes > MAX_REPOSITORY_BYTES)
        throw new Error('Repository exceeds the initial 64 MiB expanded source limit');
    }
    await git('config', 'core.bare', 'false');
    await git('config', 'user.name', 'Mitzo Sandbox');
    await git('config', 'user.email', 'sandbox@mitzo.invalid');
    await git('config', 'remote.origin.url', `https://github.com/${preview.repository}.git`);
    await git('update-ref', `refs/remotes/origin/${preview.baseBranch}`, preview.baseOid);
    await git(
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      `refs/remotes/origin/${preview.baseBranch}`,
    );
    await git('update-ref', `refs/heads/${featureBranch}`, preview.baseOid);
    await git('symbolic-ref', 'HEAD', `refs/heads/${featureBranch}`);
    // The clone has only Git-generated config and no configured filters. No upstream config is copied.
    await git('--work-tree=' + directory, 'read-tree', preview.baseOid);
    await git('--work-tree=' + directory, 'checkout-index', '--all');
    signal.throwIfAborted();
    return { ...preview, directory, featureBranch };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
