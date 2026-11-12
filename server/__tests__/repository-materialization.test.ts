import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  prepareRepositoryMaterialization,
  repositoryMaterializationScript,
} from '../repository-materialization.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// One tiny real Git lifetime proves transfer semantics; no sandbox, provider or network.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-materialization-')));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Offline fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, '.gitignore'), 'private.txt\n');
  await writeFile(join(source, 'tracked.txt'), 'committed\n');
  git(source, 'add', '.');
  git(source, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git(source, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(source, 'switch', '-qc', 'mitzo/task');
  await writeFile(join(source, 'private.txt'), 'must not transfer');
  const plan = await prepareRepositoryMaterialization({
    source,
    workspaceId: '00000000-0000-4000-8000-000000000001',
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: git(source, 'rev-parse', 'HEAD'),
    featureBranch: 'mitzo/task',
    signal: new AbortController().signal,
  });
  const target = join(root, 'task');
  const run = (allowInitialReplacement = false) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          repositoryMaterializationScript,
          plan.seed,
          target,
          JSON.stringify(plan.manifest),
          String(allowInitialReplacement),
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  return { root, source, target, git, plan, run };
}

it('imports exact Git identity, excludes ignored data and preserves mutable work on replay', async () => {
  const f = await fixture();
  try {
    const receipt = f.run();
    expect(receipt).toMatchObject({
      workspaceId: f.plan.manifest.workspaceId,
      head: f.plan.manifest.baseOid,
    });
    expect(f.git(f.target, 'symbolic-ref', 'HEAD')).toBe('refs/heads/mitzo/task');
    expect(f.git(f.target, 'rev-parse', '--show-toplevel')).toBe(f.target);
    await expect(readFile(join(f.target, 'private.txt'))).rejects.toThrow();
    await writeFile(join(f.target, 'tracked.txt'), 'retained edit');
    expect(f.run()).toEqual(receipt);
    expect(await readFile(join(f.target, 'tracked.txt'), 'utf8')).toBe('retained edit');
    f.git(f.target, 'add', 'tracked.txt');
    f.git(f.target, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'retained work');
    expect(f.run().head).toBe(f.git(f.target, 'rev-parse', 'HEAD'));
    expect(f.run().head).not.toBe(receipt.head);
    // Reuse this retained task to qualify every metadata variant before resume.
    f.git(f.target, 'pack-refs', '--all');
    const packed = join(f.target, '.git', 'packed-refs');
    const packedBytes = await readFile(packed);
    const external = join(f.root, 'external-refs');
    await writeFile(external, packedBytes);
    await rm(packed);
    await symlink(external, packed);
    expect(() => f.run()).toThrow();
    await rm(packed);
    await writeFile(packed, packedBytes);
    const config = join(f.target, '.git', 'config');
    const configBytes = await readFile(config);
    const externalConfig = join(f.root, 'external-config');
    await writeFile(externalConfig, '[core]\n bare = false\n');
    for (const section of ['include', 'includeIf "gitdir:**"']) {
      await writeFile(
        config,
        Buffer.concat([
          configBytes,
          Buffer.from('\n[' + section + ']\n path = ' + externalConfig + '\n'),
        ]),
      );
      expect(() => f.run()).toThrow();
    }
    await writeFile(config, configBytes);
    const worktreeConfig = join(f.target, '.git', 'config.worktree');
    await symlink(externalConfig, worktreeConfig);
    expect(() => f.run()).toThrow();
    await rm(worktreeConfig);
    await writeFile(worktreeConfig, '[include]\n path = ' + externalConfig + '\n');
    expect(() => f.run()).toThrow();
    await rm(worktreeConfig);
    const info = join(f.target, '.git', 'info');
    const externalInfo = join(f.root, 'external-info');
    await mkdir(externalInfo);
    await writeFile(join(externalInfo, 'grafts'), f.plan.manifest.baseOid + '\n');
    await rm(info, { recursive: true, force: true });
    await symlink(externalInfo, info);
    expect(() => f.run()).toThrow();
    await rm(info);
    await mkdir(info);
    await symlink(join(externalInfo, 'grafts'), join(info, 'grafts'));
    expect(() => f.run()).toThrow();
    await rm(join(info, 'grafts'));
    await writeFile(join(info, 'grafts'), f.plan.manifest.baseOid + '\n');
    expect(() => f.run()).toThrow();
    await rm(join(info, 'grafts'));
    expect(f.run().head).toBe(f.git(f.target, 'rev-parse', 'HEAD'));
    f.git(f.target, 'switch', '-qc', 'wrong');
    expect(() => f.run()).toThrow();
    expect(f.git(f.target, 'symbolic-ref', 'HEAD')).toBe('refs/heads/wrong');
  } finally {
    await f.plan.cleanup();
  }
});

it('preserves an initial image checkout and refuses unqualified replacement or corrupted transfer', async () => {
  const f = await fixture();
  try {
    await mkdir(f.target);
    await writeFile(join(f.target, 'retained.txt'), 'image or uncertain task');
    expect(() => f.run()).toThrow();
    expect(await readFile(join(f.target, 'retained.txt'), 'utf8')).toBe('image or uncertain task');
    const bundle = await readFile(join(f.plan.seed, 'repository.bundle'));
    await writeFile(join(f.plan.seed, 'repository.bundle'), 'corrupt');
    expect(() => f.run(true)).toThrow();
    expect(await readFile(join(f.target, 'retained.txt'), 'utf8')).toBe('image or uncertain task');
    await writeFile(join(f.plan.seed, 'repository.bundle'), bundle);
    expect(f.run(true)).toMatchObject({ head: f.plan.manifest.baseOid });
    expect(
      await readFile(
        join(f.target + '.before-' + f.plan.manifest.workspaceId, 'retained.txt'),
        'utf8',
      ),
    ).toBe('image or uncertain task');
  } finally {
    await f.plan.cleanup();
  }
});
