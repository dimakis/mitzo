import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GithubHostCommandRunner } from './connections/capabilities/github-publish-pr-transport.js';
export class GithubSeedPublicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface SeededChangeInput {
  repository: string;
  baseBranch: string;
  sourceBranch: string;
  originalSourceOid: string;
  seedTreeOid: string;
  patch: Buffer;
  baseOid?: string;
  seedUpstreamOid?: string;
  signal: AbortSignal;
}
const oid = /^[a-f0-9]{40}$/;
const branch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
/** Construct one new commit without checking out or executing repository content.
 * Only the sealed task delta is applied: filtered seed files never replace upstream. */
export async function projectSeededChange(run: GithubHostCommandRunner, input: SeededChangeInput) {
  if (
    !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(input.repository) ||
    ![input.baseBranch, input.sourceBranch].every(
      (v) => branch.test(v) && !v.includes('..') && !v.endsWith('.lock'),
    ) ||
    input.sourceBranch === input.baseBranch ||
    !oid.test(input.originalSourceOid) ||
    !oid.test(input.seedTreeOid) ||
    (input.baseOid !== undefined && !oid.test(input.baseOid)) ||
    (input.seedUpstreamOid !== undefined && !oid.test(input.seedUpstreamOid)) ||
    !input.patch.length ||
    input.patch.length > 4 * 1024 * 1024
  )
    throw new GithubSeedPublicationError(
      'SEEDED_SOURCE_INVALID',
      'Seeded publication input is invalid',
    );
  const parent = await mkdtemp(join(tmpdir(), 'mitzo-seeded-publication-'));
  await chmod(parent, 0o700);
  const repository = join(parent, 'repository.git');
  const git = async (...args: string[]) =>
    (
      await run(
        'git',
        [
          '--git-dir=' + repository,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        input.signal,
      )
    ).stdout.trim();
  try {
    await run(
      'git',
      ['clone', '--bare', '--template=', `https://github.com/${input.repository}.git`, repository],
      input.signal,
    );
    const currentBase = await git('rev-parse', `refs/heads/${input.baseBranch}^{commit}`);
    const baseOid = input.baseOid ?? currentBase;
    if (!oid.test(baseOid))
      throw new GithubSeedPublicationError('SEEDED_BASE_INVALID', 'Publication base is invalid');
    await git('merge-base', '--is-ancestor', baseOid, currentBase);
    if (input.seedUpstreamOid)
      await git('merge-base', '--is-ancestor', input.seedUpstreamOid, baseOid);
    await git('read-tree', baseOid);
    const patchPath = join(parent, 'change.patch');
    await writeFile(patchPath, input.patch, { mode: 0o600 });
    try {
      await git('apply', '--cached', '--binary', '--whitespace=nowarn', patchPath);
    } catch {
      throw new GithubSeedPublicationError(
        'SEEDED_PATCH_CONFLICT',
        'Committed seeded changes conflict with upstream. Preserve the task commit and review the conflict before publishing.',
      );
    }
    const modes = await git('diff', '--cached', '--raw', baseOid);
    if (modes.split('\n').some((line) => line && !/^:\d{6} (100644|100755|000000) /.test(line)))
      throw new GithubSeedPublicationError(
        'SEEDED_PATH_UNSUPPORTED',
        'Seeded publication cannot introduce symlinks or submodules',
      );
    const patchSha256 = createHash('sha256').update(input.patch).digest('hex');
    const tree = await git('write-tree');
    const raw = `tree ${tree}\nparent ${baseOid}\nauthor Mitzo Publisher <publisher@mitzo.invalid> 0 +0000\ncommitter Mitzo Publisher <publisher@mitzo.invalid> 0 +0000\n\nPublish seeded task ${input.originalSourceOid}\n\nSeed tree: ${input.seedTreeOid}\nPatch SHA-256: ${patchSha256}\n`;
    const commit = join(parent, 'commit');
    await writeFile(commit, raw, { mode: 0o600 });
    const sourceOid = await git('hash-object', '-t', 'commit', '-w', commit);
    await git('update-ref', `refs/heads/${input.sourceBranch}`, sourceOid);
    const bundlePath = join(parent, 'change.bundle');
    await git('bundle', 'create', bundlePath, `refs/heads/${input.sourceBranch}`, `^${baseOid}`);
    const bundle = await readFile(bundlePath);
    if (!bundle.length || bundle.length > 16 * 1024 * 1024)
      throw new GithubSeedPublicationError(
        'SEEDED_EXPORT_TOO_LARGE',
        'Seeded publication export exceeds its limit',
      );
    return { sourceOid, baseOid, patchSha256, bundle };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
