import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  writeFile,
  readFile,
  rename,
  access,
  cp,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import type { AccountBinding } from '@mitzo/protocol';
const roots: string[] = [];
const binding = {
  accountId: 'account',
  provider: 'openai',
  model: 'test',
  profileRevision: 'rev',
} as AccountBinding;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-repository-workspaces-')));
  roots.push(root);
  const authorize = vi.fn(async () => ({ revision: 1 }));
  const git = (directory: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  const source = join(root, 'source');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  git(source, 'config', 'user.name', 'Offline fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'file.txt'), 'source');
  git(source, 'add', 'file.txt');
  git(source, 'commit', '-qm', 'base');
  const oid = git(source, 'rev-parse', 'HEAD');
  const inspect = vi.fn(async () => ({
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: oid,
  }));
  const prepare = vi.fn(async (_preview, directory: string, featureBranch: string) => {
    await cp(source, directory, { recursive: true });
    git(directory, 'checkout', '-qb', featureBranch);
    return { ...(await inspect()), directory, featureBranch };
  });
  const verify = vi.fn(async () => {});
  const service = new RepositoryWorkspaces(join(root, 'private'), {
    authorize,
    inspect,
    prepare,
    verify,
  });
  const taskRoot = join(root, 'tasks');
  await mkdir(taskRoot);
  return { root, taskRoot, service, authorize, inspect, prepare, verify, git };
}
it('persists a pinned preparation across restart and claims it for only one conversation', async () => {
  const f = await fixture();
  const preview = await f.service.preview(
    binding,
    'connection',
    'Example/Repo',
    new AbortController().signal,
  );
  const ready = await f.service.prepare(preview.id, binding, new AbortController().signal);
  expect(ready).toMatchObject({
    state: 'ready',
    repository: 'example/repo',
    baseOid: expect.stringMatching(/^[a-f0-9]{40}$/),
  });
  f.service.close();
  const restored = new RepositoryWorkspaces(join(f.root, 'private'), {
    authorize: f.authorize,
    inspect: f.inspect,
    prepare: f.prepare,
    verify: f.verify,
  });
  const claimed = await restored.claim(ready.id, binding, 'conversation', f.taskRoot, false);
  expect(await readFile(join(claimed.directory!, 'file.txt'), 'utf8')).toBe('source');
  await expect(
    restored.claim(ready.id, binding, 'other-conversation', f.taskRoot, false),
  ).rejects.toThrow();
  expect(
    (await restored.claim(ready.id, binding, 'conversation', f.taskRoot, false)).directory,
  ).toBe(claimed.directory);
  restored.close();
});
it('refuses revoked or changed connection revisions before cloning or granting a workspace', async () => {
  const f = await fixture();
  const preview = await f.service.preview(
    binding,
    'connection',
    'example/repo',
    new AbortController().signal,
  );
  f.authorize.mockResolvedValue({ revision: 2 });
  await expect(
    f.service.prepare(preview.id, binding, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
  f.service.close();
});
it('does not let another account or changed account binding consume a preparation', async () => {
  const f = await fixture();
  const preview = await f.service.preview(
    binding,
    'connection',
    'example/repo',
    new AbortController().signal,
  );
  await expect(
    f.service.prepare(preview.id, { ...binding, accountId: 'other' }, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
  f.service.close();
});
it('serializes duplicate preparation and rechecks authorization after asynchronous clone', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const preview = await f.service.preview(binding, 'connection', 'example/repo', signal);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const implementation = f.prepare.getMockImplementation()!;
  f.prepare.mockImplementation(async (...args) => {
    await gate;
    return implementation(...args);
  });
  const first = f.service.prepare(preview.id, binding, signal);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  await expect(f.service.prepare(preview.id, binding, signal)).rejects.toThrow();
  f.authorize.mockResolvedValue({ revision: 2 });
  release();
  await expect(first).rejects.toThrow();
  await expect(
    f.service.claim(preview.id, binding, 'conversation', f.taskRoot, false),
  ).rejects.toThrow();
  f.service.close();
});

it('discards only an unused preparation and preserves claimed task work', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const first = await f.service.preview(binding, 'connection', 'example/repo', signal);
  await f.service.prepare(first.id, binding, signal);
  expect(f.service.status(first.id, binding)).toMatchObject({ state: 'ready' });
  await expect(f.service.discard(first.id, { ...binding, accountId: 'other' })).rejects.toThrow();
  await f.service.discard(first.id, binding);
  await expect(
    f.service.claim(first.id, binding, 'conversation', f.taskRoot, false),
  ).rejects.toThrow();
  const second = await f.service.preview(binding, 'connection', 'example/repo', signal);
  await f.service.prepare(second.id, binding, signal);
  const claimed = await f.service.claim(second.id, binding, 'conversation', f.taskRoot, false);
  await writeFile(join(claimed.directory!, 'file.txt'), 'retained task edits');
  await expect(f.service.discard(second.id, binding)).rejects.toThrow();
  expect(await readFile(join(claimed.directory!, 'file.txt'), 'utf8')).toBe('retained task edits');
  f.service.close();
});

it('rechecks the exact frozen sandbox seed before upload and rejects changed source or account access', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const preview = await f.service.preview(binding, 'connection', 'example/repo', signal);
  await f.service.prepare(preview.id, binding, signal);
  const claimed = await f.service.claim(preview.id, binding, 'conversation', f.taskRoot, true);
  expect(await f.service.startupSeed(preview.id, binding, 'conversation', signal)).toBe(
    claimed.seed,
  );
  await writeFile(join(claimed.seed, 'file.txt'), 'tampered source');
  await expect(
    f.service.startupSeed(preview.id, binding, 'conversation', signal),
  ).rejects.toThrow();
  await expect(
    f.service.startupSeed(preview.id, binding, 'other-conversation', signal),
  ).rejects.toThrow();
  f.service.close();
});

it('releases only settled controller seed copies while retaining task metadata and edits', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const preview = await f.service.preview(binding, 'connection', 'example/repo', signal);
  await f.service.prepare(preview.id, binding, signal);
  const claimed = await f.service.claim(preview.id, binding, 'conversation', f.taskRoot, false);
  await writeFile(join(claimed.directory!, 'file.txt'), 'task edits');
  await expect(f.service.releaseSource(preview.id, binding, 'other')).rejects.toThrow();
  await f.service.releaseSource(preview.id, binding, 'conversation');
  expect(await readFile(join(claimed.directory!, 'file.txt'), 'utf8')).toBe('task edits');
  expect(f.service.getForConversation('conversation')).toMatchObject({
    directory: claimed.directory,
    sourceReleased: true,
  });
  await expect(f.service.discard(preview.id, binding)).rejects.toThrow();
  f.service.close();
});

it('rejects a connection change during verification before reserving a claim', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const preview = await f.service.preview(binding, 'connection', 'example/repo', signal);
  await f.service.prepare(preview.id, binding, signal);
  f.verify.mockImplementation(async () => {
    f.authorize.mockResolvedValue({ revision: 2 });
  });
  await expect(
    f.service.claim(preview.id, binding, 'conversation', f.taskRoot, true),
  ).rejects.toThrow('GitHub connection changed');
  expect(f.service.status(preview.id, binding).state).toBe('ready');
  expect(f.service.getForConversation('conversation')).toBeUndefined();
  f.service.close();
});

it('rechecks access after the host copy and preserves an interrupted claim', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const preview = await f.service.preview(binding, 'connection', 'example/repo', signal);
  await f.service.prepare(preview.id, binding, signal);
  const copied = join(f.taskRoot, `repo-${preview.id}`, 'mgmt', 'file.txt');
  f.authorize.mockImplementation(async () => {
    const present = await readFile(copied).then(
      () => true,
      () => false,
    );
    return { revision: present ? 2 : 1 };
  });
  await expect(
    f.service.claim(preview.id, binding, 'conversation', f.taskRoot, false),
  ).rejects.toThrow('GitHub connection changed');
  expect(f.service.status(preview.id, binding).state).toBe('claiming');
  expect(() => f.service.getForConversation('conversation')).toThrow('preserve its original claim');
  expect(await readFile(copied, 'utf8')).toBe('source');
  f.service.close();
});

it('validates retained task ownership across restart while preserving edits and commits', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const preview = await f.service.preview(binding, 'connection', 'example/repo', signal);
  await f.service.prepare(preview.id, binding, signal);
  const claimed = await f.service.claim(preview.id, binding, 'conversation', f.taskRoot, false);
  await writeFile(join(claimed.directory!, 'file.txt'), 'task edits');
  f.git(claimed.directory!, 'add', 'file.txt');
  f.git(claimed.directory!, 'commit', '-qm', 'task edit');
  f.git(claimed.directory!, 'pack-refs', '--all');
  await f.service.releaseSource(preview.id, binding, 'conversation');
  f.service.close();
  const restored = new RepositoryWorkspaces(join(f.root, 'private'), { authorize: f.authorize });
  expect(await restored.validateHostTask('conversation', claimed.directory!)).toMatchObject({
    directory: claimed.directory,
  });
  await expect(restored.validateHostTask('conversation', f.root)).rejects.toThrow();
  await expect(restored.validateHostTask('unknown', claimed.directory!)).rejects.toThrow();
  expect(await readFile(join(claimed.directory!, 'file.txt'), 'utf8')).toBe('task edits');
  restored.close();
});

it.each(['missing', 'replaced', 'metadata-replaced', 'wrong-branch', 'missing-history'] as const)(
  'refuses a %s retained host checkout without recreating or overwriting it',
  async (condition) => {
    const f = await fixture();
    const signal = new AbortController().signal;
    const preview = await f.service.preview(binding, 'connection', 'example/repo', signal);
    await f.service.prepare(preview.id, binding, signal);
    const claimed = await f.service.claim(preview.id, binding, 'conversation', f.taskRoot, false);
    const cwd = claimed.directory!;
    await writeFile(join(cwd, 'file.txt'), 'preserved edits');
    if (condition === 'missing' || condition === 'replaced') {
      await rename(cwd, cwd + '-retained');
      if (condition === 'replaced') await mkdir(cwd);
    } else if (condition === 'metadata-replaced') {
      await rename(join(cwd, '.git'), join(cwd, '.git-retained'));
      await mkdir(join(cwd, '.git'));
    } else if (condition === 'missing-history')
      await rm(join(cwd, '.git', 'objects'), { recursive: true });
    else await writeFile(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await expect(f.service.validateHostTask('conversation', cwd)).rejects.toThrow();
    if (condition === 'missing') await expect(access(cwd)).rejects.toThrow();
    expect(
      await readFile(
        join(
          condition === 'missing' || condition === 'replaced' ? cwd + '-retained' : cwd,
          'file.txt',
        ),
        'utf8',
      ),
    ).toBe('preserved edits');
    expect(f.service.getForConversation('conversation')?.directory).toBe(cwd);
    f.service.close();
  },
);

it('rechecks access when retrying a settled host claim after asynchronous ownership validation', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const preview = await f.service.preview(binding, 'connection', 'example/repo', signal);
  await f.service.prepare(preview.id, binding, signal);
  const claimed = await f.service.claim(preview.id, binding, 'conversation', f.taskRoot, false);
  const validate = f.service.validateHostTask.bind(f.service);
  vi.spyOn(f.service, 'validateHostTask').mockImplementation(async (...args) => {
    const task = await validate(...args);
    f.authorize.mockResolvedValue({ revision: 2 });
    return task;
  });
  await expect(
    f.service.claim(preview.id, binding, 'conversation', f.taskRoot, false),
  ).rejects.toThrow('GitHub connection changed');
  expect(f.service.getForConversation('conversation')?.directory).toBe(claimed.directory);
  expect(await readFile(join(claimed.directory!, 'file.txt'), 'utf8')).toBe('source');
  f.service.close();
});
