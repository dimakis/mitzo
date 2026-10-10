import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { knowledgeLibraryFromEnvironment } from '../knowledge-library-runtime.js';
import { isPrivateCodexPath } from '../codex-private-path.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(patch: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knowledge-runtime-')));
  roots.push(root);
  const configPath = join(root, 'host.json');
  const configuration = {
    repository: 'owner/knowledge',
    documentPaths: ['essentials', 'README.md'],
    stateDirectory: join(root, 'state'),
    ...patch,
  };
  await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
  const run = vi.fn(async (program: string, args: readonly string[], signal: AbortSignal) => {
    if (program === 'gh') throw new Error('Offline fixtures prohibit GitHub requests');
    if (args.includes('fetch')) {
      const directory = args[args.indexOf('-C') + 1]!;
      const git = (...argv: string[]) => {
        const child = exec('git', ['-C', directory, ...argv], { signal });
        child.child.stdin?.end();
        return child;
      };
      const tree = (await git('mktree')).stdout.trim();
      const commit = (
        await git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit-tree',
          tree,
          '-m',
          'Offline accepted fixture',
        )
      ).stdout.trim();
      await git('update-ref', 'refs/remotes/origin/main', commit);
      return { stdout: '', stderr: '' };
    }
    return exec(program, [...args], { signal });
  });
  return {
    root,
    configPath,
    configuration,
    run,
    env: { MITZO_KNOWLEDGE_LIBRARY_CONFIG: configPath },
  };
}
it('is opt-in and rejects host configuration ambiguity before commands', async () => {
  expect(await knowledgeLibraryFromEnvironment({})).toBeUndefined();
  for (const patch of [
    { repository: 'OWNER/knowledge' },
    { repository: 'https://github.com/owner/knowledge' },
    { documentPaths: ['scripts'] },
    { documentPaths: ['../secret'] },
    { stateDirectory: 'relative' },
    { unexpected: 'field' },
    { acceptanceEnabled: true },
  ]) {
    const f = await fixture(patch);
    await expect(knowledgeLibraryFromEnvironment(f.env, { runHost: f.run })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  }
});
it('uses a protected private bare mirror and fetches only trusted HTTPS accepted branch', async () => {
  const f = await fixture();
  const runtime = (await knowledgeLibraryFromEnvironment(f.env, { runHost: f.run }))!;
  try {
    expect(runtime.sourceIdentity).toBe('github:owner/knowledge@main');
    expect(runtime.contextPacks.list()).toEqual({ packs: [], drafts: [] });
    expect(runtime.reviewEnabled).toBe(false);
    expect(runtime.acceptanceEnabled).toBe(false);
    expect(runtime.reviewService).toBeUndefined();
    expect(runtime.publisher).toBeUndefined();
    expect(runtime.syncedAt).toMatch(/^\d{4}-/);
    expect(runtime.source.acceptedRef).toBe('refs/remotes/origin/main');
    expect(isPrivateCodexPath(f.configPath)).toBe(true);
    expect(isPrivateCodexPath(f.configuration.stateDirectory)).toBe(true);
    expect(await runtime.source.catalog()).toMatchObject({ documents: [] });
    const fetch = f.run.mock.calls.find((c) => c[1].includes('fetch'))![1];
    expect(fetch).toContain('+refs/heads/main:refs/remotes/origin/main');
    expect(f.run.mock.calls.flatMap((c) => c[1])).not.toContain('checkout');
    const snapshot = await readFile(
      join(f.configuration.stateDirectory, 'synchronization.json'),
      'utf8',
    );
    expect(JSON.parse(snapshot)).toMatchObject({
      repository: 'owner/knowledge',
      acceptedBranch: 'main',
      syncedAt: runtime.syncedAt,
    });
  } finally {
    runtime.close();
  }
});
it('existing valid mirrors browse without fetching and retain previous sync time', async () => {
  const f = await fixture();
  const first = (await knowledgeLibraryFromEnvironment(f.env, { runHost: f.run }))!;
  const synced = first.syncedAt;
  first.close();
  f.run.mockClear();
  const reopened = (await knowledgeLibraryFromEnvironment(f.env, { runHost: f.run }))!;
  try {
    expect(reopened.syncedAt).toBe(synced);
    expect(f.run.mock.calls.some((c) => c[1].includes('fetch'))).toBe(false);
    await reopened.refresh();
    expect(f.run.mock.calls.some((c) => c[1].includes('fetch'))).toBe(true);
  } finally {
    reopened.close();
  }
});
it('explicit publisher enrollment enables reviews while acceptance stays off by default', async () => {
  const f = await fixture({ publisherLogin: 'publisher' });
  const runtime = (await knowledgeLibraryFromEnvironment(f.env, { runHost: f.run }))!;
  try {
    expect(runtime.reviewEnabled).toBe(true);
    expect(runtime.reviewService).toBeDefined();
    expect(runtime.publisher).toBeDefined();
    expect(runtime.acceptanceEnabled).toBe(false);
  } finally {
    runtime.close();
  }
});
it('rejects public/symlink config and state inside a checkout or workspace', async () => {
  const publicFile = await fixture();
  await chmod(publicFile.configPath, 0o644);
  await expect(
    knowledgeLibraryFromEnvironment(publicFile.env, { runHost: publicFile.run }),
  ).rejects.toThrow();
  const linked = await fixture();
  const link = join(linked.root, 'linked.json');
  await symlink(linked.configPath, link);
  await expect(
    knowledgeLibraryFromEnvironment(
      { MITZO_KNOWLEDGE_LIBRARY_CONFIG: link },
      { runHost: linked.run },
    ),
  ).rejects.toThrow();
  const workspace = await fixture();
  await expect(
    knowledgeLibraryFromEnvironment(workspace.env, {
      runHost: workspace.run,
      workspaceRoots: [workspace.configuration.stateDirectory],
    }),
  ).rejects.toThrow();
  const checkout = await fixture();
  await exec('git', ['init', checkout.root]);
  await expect(
    knowledgeLibraryFromEnvironment(checkout.env, { runHost: checkout.run }),
  ).rejects.toThrow();
});
it('rejects redirected origin and local config execution hooks before refresh', async () => {
  const f = await fixture();
  const initial = (await knowledgeLibraryFromEnvironment(f.env, { runHost: f.run }))!;
  initial.close();
  await exec('git', [
    '-C',
    join(f.configuration.stateDirectory, 'source.git'),
    'remote',
    'set-url',
    'origin',
    'https://github.com/attacker/knowledge.git',
  ]);
  f.run.mockClear();
  await expect(knowledgeLibraryFromEnvironment(f.env, { runHost: f.run })).rejects.toThrow();
  expect(f.run.mock.calls.some((c) => c[1].includes('fetch'))).toBe(false);
});
it('protects configured state before Library initialization and fails closed for unreadable enrollment', async () => {
  const f = await fixture();
  vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', f.configPath);
  try {
    const { createCodexPathProtection } = await import('../codex-private-path.js');
    const snapshot = createCodexPathProtection(() => []);
    expect(snapshot()(join(f.configuration.stateDirectory, 'drafts.sqlite'))).toBe(true);
    expect(snapshot()(f.configPath)).toBe(true);
    await writeFile(f.configPath, 'malformed', { mode: 0o600 });
    expect(snapshot()('/ordinary/file')).toBe(true);
    vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', '');
    expect(snapshot()(join(f.configuration.stateDirectory, 'drafts.sqlite'))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
