import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { githubRepositoryFromOrigin } from './connections/capabilities/github-publish-pr.js';
import { GithubSeedPublicationError } from './github-seeded-source.js';
const exec = promisify(execFile);
export interface GithubSeedBaseline {
  seedTreeOid: string;
  repository: string;
  upstreamOid: string;
  fingerprint: string;
}
/** Only operator-configured host manifests are authority. Sandbox Git config and
 * model arguments cannot supply a baseline or select a fallback repository. */
export async function loadGithubSeedBaselines(
  paths: readonly string[],
  signal: AbortSignal,
): Promise<GithubSeedBaseline[]> {
  if (paths.length > 32)
    throw new GithubSeedPublicationError(
      'SEEDED_BASELINE_INVALID',
      'Too many configured seed baselines',
    );
  const readGit = async (root: string, ...args: string[]) =>
    (
      await exec('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
        signal,
        maxBuffer: 8192,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      })
    ).stdout.trim();
  const result: GithubSeedBaseline[] = [];
  for (const path of paths) {
    if (!isAbsolute(path))
      throw new GithubSeedPublicationError(
        'SEEDED_BASELINE_INVALID',
        'Configured seed baseline must be an absolute host path',
      );
    const canonical = await realpath(path);
    const bytes = await readFile(canonical);
    if (bytes.length > 32 * 1024 * 1024)
      throw new GithubSeedPublicationError(
        'SEEDED_BASELINE_INVALID',
        'Configured seed baseline exceeds its limit',
      );
    const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
    if (
      typeof value.source !== 'string' ||
      !isAbsolute(value.source) ||
      typeof value.startingCommit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(value.startingCommit)
    )
      throw new GithubSeedPublicationError(
        'SEEDED_BASELINE_INVALID',
        'Configured seed source identity is invalid',
      );
    const source = await realpath(value.source),
      seed = await realpath(join(dirname(canonical), 'mgmt'));
    const repository = githubRepositoryFromOrigin(
      await readGit(source, 'config', '--local', '--get', 'remote.origin.url'),
    );
    await readGit(source, 'cat-file', '-e', value.startingCommit + '^{commit}');
    const seedTreeOid = await readGit(seed, 'rev-parse', 'HEAD^{tree}');
    if (!/^[a-f0-9]{40}$/.test(seedTreeOid))
      throw new GithubSeedPublicationError(
        'SEEDED_BASELINE_INVALID',
        'Configured seed tree is invalid',
      );
    result.push({
      seedTreeOid,
      repository,
      upstreamOid: value.startingCommit,
      fingerprint: createHash('sha256')
        .update(bytes)
        .update(seedTreeOid)
        .update(repository)
        .digest('hex'),
    });
  }
  return result;
}
export function selectGithubSeedBaseline(
  bindings: readonly GithubSeedBaseline[],
  tree: string,
): GithubSeedBaseline {
  const matches = bindings.filter((b) => b.seedTreeOid === tree);
  if (!matches.length)
    throw new GithubSeedPublicationError(
      'SEEDED_BASELINE_REQUIRED',
      'This isolated workspace needs its original host seed baseline registered for reviewed publication. No GitHub operation was recorded; preserve the local commit.',
    );
  const first = matches[0]!;
  if (
    matches.some(
      (b) =>
        b.repository !== first.repository ||
        b.upstreamOid !== first.upstreamOid ||
        b.fingerprint !== first.fingerprint,
    )
  )
    throw new GithubSeedPublicationError(
      'SEEDED_BASELINE_AMBIGUOUS',
      'Seed publication baseline is ambiguous',
    );
  return first;
}
