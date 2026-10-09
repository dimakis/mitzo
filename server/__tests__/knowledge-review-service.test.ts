import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcceptedKnowledgeSource } from '../knowledge-library-source.js';
import { KnowledgeDraftStore } from '../knowledge-draft-store.js';
import { KnowledgeReviewService } from '../knowledge-review-service.js';
import type {
  GithubHostPublisher,
  GithubPullRequest,
} from '../connections/capabilities/github-publish-pr.js';

let root: string, store: KnowledgeDraftStore, source: AcceptedKnowledgeSource;
let review: GithubPullRequest | null, remoteHead: string | null;
let publisher: GithubHostPublisher & { identity: ReturnType<typeof vi.fn<() => Promise<string>>> };
function git(...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-review-test-'));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  mkdirSync(join(root, 'architecture'));
  writeFileSync(join(root, 'architecture/one.md'), '# Old\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  source = new AcceptedKnowledgeSource(root, 'refs/remotes/origin/main', ['architecture']);
  store = new KnowledgeDraftStore(join(root, 'drafts.sqlite'));
  review = null;
  remoteHead = null;
  publisher = {
    identity: vi.fn(async () => 'operator'),
    policy: vi.fn(async () => ({ defaultBranch: 'main', sourceBranchProtected: false })),
    read: vi.fn(async () => review),
    readBranch: vi.fn(async () => remoteHead),
    reconstruct: vi.fn(async ({ sourceOid }) => ({
      directory: sourceOid,
      cleanupDirectory: 'temporary',
    })),
    push: vi.fn(async ({ directory }) => {
      remoteHead = directory;
    }),
    cleanup: vi.fn(async () => {}),
    findOpen: vi.fn(async () => review),
    create: vi.fn(
      async (input) =>
        (review = {
          ...input,
          id: '1',
          url: 'https://github.com/test/knowledge/pull/1',
          state: 'open',
          merged: false,
        }),
    ),
    update: vi.fn(async () => review!),
  };
});
afterEach(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true });
});
function service() {
  return new KnowledgeReviewService(source, store, publisher, {
    repository: 'test/knowledge',
    baseBranch: 'main',
    publisherLogin: 'operator',
  });
}
async function draft() {
  return store.create('Architecture', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# Improved\n' },
  ]);
}

it('creates a draft review, reuses it on further saves and creates no checkout in the source', async () => {
  const d = await draft();
  const s = service();
  const first = await s.submit(d.id, d.version);
  expect(first.state).toBe('in-review');
  expect(first.review?.head).toBe(remoteHead);
  expect(publisher.create).toHaveBeenCalledWith(
    expect.objectContaining({ draft: true, sourceBranch: `knowledge/${d.id}` }),
  );
  expect(git('show', `${remoteHead}:architecture/one.md`)).toBe('# Improved');
  expect(git('show', 'HEAD:architecture/one.md')).toBe('# Old');
  const next = store.save(d.id, first.version, [
    { path: 'architecture/one.md', base: '# Old\n', content: '# Even better\n' },
  ]);
  await s.submit(next.id, next.version);
  expect(publisher.create).toHaveBeenCalledTimes(1);
  expect(publisher.update).toHaveBeenCalledTimes(1);
  expect(git('show', `${remoteHead}:architecture/one.md`)).toBe('# Even better');
});
it('recovers a lost create acknowledgement without duplicating its review or head', async () => {
  const d = await draft();
  const create = vi.mocked(publisher.create).getMockImplementation()!;
  vi.mocked(publisher.create).mockImplementationOnce(async (input) => {
    await create(input);
    throw new Error('lost acknowledgement');
  });
  await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
  const head = remoteHead;
  expect(store.get(d.id).documents[0]?.content).toBe('# Improved\n');
  await service().submit(d.id, d.version);
  expect(publisher.create).toHaveBeenCalledTimes(1);
  expect(remoteHead).toBe(head);
});
it('blocks conflicting accepted edits and retains the draft, while unrelated accepted edits are preserved', async () => {
  const d = await draft();
  writeFileSync(join(root, 'architecture/other.md'), '# Unrelated\n');
  git('add', 'architecture/other.md');
  git('commit', '-m', 'unrelated');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await service().submit(d.id, d.version);
  expect(git('show', `${remoteHead}:architecture/other.md`)).toBe('# Unrelated');
  const next = store.save(d.id, d.version, [
    { path: 'architecture/one.md', base: '# Old\n', content: '# Another draft\n' },
  ]);
  writeFileSync(join(root, 'architecture/one.md'), '# Someone else\n');
  git('add', 'architecture/one.md');
  git('commit', '-m', 'conflicting accepted edit');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await expect(service().submit(next.id, next.version)).rejects.toThrow('changed since');
  expect(store.get(d.id).documents[0]?.content).toBe('# Another draft\n');
  expect(publisher.push).toHaveBeenCalledTimes(1);
});
it('fails closed for changed publisher identity, outside scopes, or finished reviews', async () => {
  const d = await draft();
  publisher.identity.mockResolvedValueOnce('another');
  await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
  expect(publisher.push).not.toHaveBeenCalled();
  await service().submit(d.id, d.version);
  review = { ...review!, state: 'closed', merged: true };
  await expect(service().submit(d.id, d.version)).rejects.toThrow('finished');
  expect(store.get(d.id).state).toBe('accepted');
});

it('fences concurrent saves through another store connection and cancels revoked authority before pushing', async () => {
  const d = await draft();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  publisher.identity.mockImplementationOnce(async () => {
    await pending;
    return 'operator';
  });
  const controller = new AbortController();
  const submission = service().submit(d.id, d.version, controller.signal);
  const other = new KnowledgeDraftStore(join(root, 'drafts.sqlite'));
  try {
    expect(() => other.save(d.id, d.version, d.documents)).toThrow('saving');
    controller.abort();
    release();
    await expect(submission).rejects.toThrow('Draft saved');
    expect(publisher.push).not.toHaveBeenCalled();
    expect(other.save(d.id, d.version, d.documents).version).toBe(2);
  } finally {
    other.close();
    release();
  }
});
