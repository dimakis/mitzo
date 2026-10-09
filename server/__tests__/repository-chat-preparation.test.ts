import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { RepositoryWorkspaces } from '../repository-workspaces.js';

const roots: string[] = [];
const services = new Set<RepositoryWorkspaces>();
const binding = {
  accountId: 'account',
  provider: 'openai',
  model: 'fixture',
  profileRevision: 'v1',
} as AccountBinding;
afterEach(async () => {
  for (const service of services) service.close();
  services.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-chat-preparation-')));
  roots.push(root);
  const inspect = vi.fn(async (repository: string) => ({
    repository,
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
  }));
  const prepare = vi.fn(async (preview, directory: string, branch: string) => {
    await mkdir(join(directory, '.git'), { recursive: true });
    await writeFile(join(directory, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    await writeFile(join(directory, 'file.txt'), 'fixture source');
    return { ...preview, directory, featureBranch: branch };
  });
  const deps = {
    authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
    inspect,
    prepare,
  };
  const open = () => {
    const service = new RepositoryWorkspaces(join(root, 'private'), deps);
    services.add(service);
    return service;
  };
  return { root, inspect, prepare, open, service: open() };
}
it('persists a ready task draft and exposes only public preparation data across restart', async () => {
  const f = await fixture();
  const prepared = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'Example/Repo',
    'Fix the parser',
    new AbortController().signal,
  );
  expect(prepared).toMatchObject({
    sourceConversationId: 'origin',
    repository: 'example/repo',
    state: 'ready',
    accountId: 'account',
    model: 'fixture',
    prompt: 'Fix the parser',
    setupUrl: `/chat?repositoryPreparation=${prepared.id}`,
  });
  for (const field of ['directory', 'seed', 'binding', 'connectionId', 'taskIdentity'])
    expect(prepared).not.toHaveProperty(field);
  f.service.close();
  services.delete(f.service);
  const restored = f.open();
  expect(restored.chatPreparation(prepared.id, binding, 'origin')).toEqual(prepared);
  expect(restored.chatPreparation(undefined, binding, 'origin')).toEqual(prepared);
  expect(
    await restored.prepareChat(
      binding,
      'origin',
      'connection',
      'example/repo',
      'Fix the parser',
      new AbortController().signal,
    ),
  ).toEqual(prepared);
  expect(f.prepare).toHaveBeenCalledOnce();
});
it('coalesces simultaneous requests without acquiring or preparing another source', async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.service.prepareChat(
        binding,
        'origin',
        'connection',
        'example/repo',
        'Fix parser',
        new AbortController().signal,
      ),
    ),
  );
  expect(new Set(results.map((result) => result.id)).size).toBe(1);
  expect(f.inspect).toHaveBeenCalledOnce();
  expect(f.prepare).toHaveBeenCalledOnce();
});
it('refuses a different task while the original ready preparation remains unused', async () => {
  const f = await fixture();
  const prepared = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/repo',
    'Fix parser',
    new AbortController().signal,
  );
  await expect(
    f.service.prepareChat(
      binding,
      'origin',
      'connection',
      'example/other',
      'Fix other',
      new AbortController().signal,
    ),
  ).rejects.toThrow('previous preparation');
  expect(f.prepare).toHaveBeenCalledOnce();
  await f.service.discard(prepared.id, binding);
  const next = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/other',
    'Fix other',
    new AbortController().signal,
  );
  expect(next.id).not.toBe(prepared.id);
  expect(f.prepare).toHaveBeenCalledTimes(2);
});
it('fences status recovery to the originating chat and exact account binding', async () => {
  const f = await fixture();
  const prepared = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/repo',
    'Fix parser',
    new AbortController().signal,
  );
  expect(() => f.service.chatPreparation(prepared.id, binding, 'other')).toThrow();
  expect(() =>
    f.service.chatPreparation(prepared.id, { ...binding, accountId: 'other' }, 'origin'),
  ).toThrow();
  expect(() => f.service.chatPreparation(undefined, binding, 'other')).toThrow();
  // The authenticated operator endpoint may inspect the named draft without a live source chat.
  expect(f.service.chatPreparation(prepared.id, binding)).toEqual(prepared);
});
it('keeps failed preparation identity recoverable and never retries acquisition automatically', async () => {
  const f = await fixture();
  f.prepare.mockRejectedValueOnce(new Error('fixture interruption'));
  const failed = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/repo',
    'Fix parser',
    new AbortController().signal,
  );
  expect(failed.state).toBe('failed');
  expect(f.service.chatPreparation(undefined, binding, 'origin')).toEqual(failed);
  expect(
    await f.service.prepareChat(
      binding,
      'origin',
      'connection',
      'example/repo',
      'Fix parser',
      new AbortController().signal,
    ),
  ).toEqual(failed);
  expect(f.prepare).toHaveBeenCalledOnce();
});
it('retains the claimed target link and permits a different subsequent task without rebinding either chat', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const first = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/repo',
    'Fix parser',
    signal,
  );
  await f.service.claim(first.id, binding, 'target', join(f.root, 'unused'), true);
  const claimed = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/repo',
    'Fix parser',
    signal,
  );
  expect(claimed).toMatchObject({ state: 'claimed', conversationId: 'target' });
  await expect(f.service.discard(first.id, binding)).rejects.toThrow();
  const next = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/other',
    'New task',
    signal,
  );
  expect(next.id).not.toBe(first.id);
  expect(f.service.getForConversation('target')?.repository).toBe('example/repo');
});

it('recovers the latest discarded draft instead of falling back to an older claimed task', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const first = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/repo',
    'Old task',
    signal,
  );
  await f.service.claim(first.id, binding, 'target', join(f.root, 'unused'), true);
  const latest = await f.service.prepareChat(
    binding,
    'origin',
    'connection',
    'example/other',
    'New task',
    signal,
  );
  await f.service.discard(latest.id, binding);
  expect(f.service.chatPreparation(undefined, binding, 'origin')).toMatchObject({
    id: latest.id,
    state: 'discarded',
    prompt: 'New task',
  });
});
