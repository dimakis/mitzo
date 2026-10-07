import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { githubRepositoryFromOrigin } from './connections/capabilities/github-publish-pr.js';
import { GithubSeedPublicationError } from './github-seeded-source.js';
const exec = promisify(execFile);
export const MAX_GITHUB_SEED_BASELINES = 33;
export function configuredGithubSeedBaselinePaths(
  seed?: string,
  retainedJson = process.env.MITZO_GITHUB_SEED_BASELINES,
): string[] {
  let retained: string[];
  try {
    retained = retainedJson
      ? z
          .array(z.string().min(1).refine(isAbsolute))
          .max(MAX_GITHUB_SEED_BASELINES - 1)
          .parse(JSON.parse(retainedJson))
      : [];
  } catch {
    throw new GithubSeedPublicationError(
      'SEEDED_BASELINE_INVALID',
      'Seed baseline configuration must be a bounded JSON array of absolute host paths',
    );
  }
  const automatic = seed ? join(seed, '..', 'baseline.json') : undefined;
  return [...new Set([...retained, ...(automatic && existsSync(automatic) ? [automatic] : [])])];
}
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
  selectedTree?: string,
): Promise<GithubSeedBaseline[]> {
  if (paths.length > MAX_GITHUB_SEED_BASELINES)
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
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_NO_LAZY_FETCH: '1',
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
    const seed = await realpath(join(dirname(canonical), 'mgmt'));
    const seedRoots = (await readGit(seed, 'rev-list', '--max-parents=0', 'HEAD')).split('\n');
    if (seedRoots.length !== 1 || !/^[a-f0-9]{40}$/.test(seedRoots[0]!))
      throw new GithubSeedPublicationError(
        'SEEDED_BASELINE_INVALID',
        'Configured seed history is ambiguous',
      );
    const seedTreeOid = await readGit(seed, 'rev-parse', seedRoots[0] + '^{tree}');
    if (!/^[a-f0-9]{40}$/.test(seedTreeOid))
      throw new GithubSeedPublicationError(
        'SEEDED_BASELINE_INVALID',
        'Configured seed tree is invalid',
      );
    if (selectedTree && seedTreeOid !== selectedTree) continue;
    if (
      !value ||
      typeof value.source !== 'string' ||
      !isAbsolute(value.source) ||
      typeof value.startingCommit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(value.startingCommit)
    )
      throw new GithubSeedPublicationError(
        'SEEDED_BASELINE_INVALID',
        'Configured seed source identity is invalid',
      );
    const source = await realpath(value.source);
    const repository = githubRepositoryFromOrigin(
      await readGit(source, 'config', '--local', '--get', 'remote.origin.url'),
    );
    await readGit(source, 'cat-file', '-e', value.startingCommit + '^{commit}');
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
      'This isolated workspace needs its original host seed baseline registered for reviewed publication. Preserve the local commit.',
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
