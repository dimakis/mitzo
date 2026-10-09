import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcceptedKnowledgeSource } from '../knowledge-library-source.js';
import { KnowledgeDraftStore } from '../knowledge-draft-store.js';
import { KnowledgeReviewService } from '../knowledge-review-service.js';
import type {
  KnowledgeReviewIdentity,
  KnowledgeReviewInspection,
} from '../knowledge-github-publisher.js';
import type {
  GithubHostPublisher,
  GithubPullRequest,
} from '../connections/capabilities/github-publish-pr.js';

let root: string, store: KnowledgeDraftStore, source: AcceptedKnowledgeSource;
let review: GithubPullRequest | null, remoteHead: string | null;
let publisher: GithubHostPublisher & {
  identity: ReturnType<typeof vi.fn<() => Promise<string>>>;
  inspect?: ReturnType<
    typeof vi.fn<(input: KnowledgeReviewIdentity) => Promise<KnowledgeReviewInspection>>
  >;
};
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
    inspect: vi.fn(async (input) => {
      if (remoteHead !== input.head) throw new Error('Merged head changed');
      return { state: 'accepted', head: input.head, canAccept: false, mergeCommit: 'b'.repeat(40) };
    }),
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
  expect(publisher.inspect).toHaveBeenCalledWith(
    expect.objectContaining({
      draftId: d.id,
      head: store.get(d.id).review?.head,
      url: 'https://github.com/test/knowledge/pull/1',
      repository: 'test/knowledge',
      baseBranch: 'main',
    }),
  );
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

it('retains a saved draft when an externally merged review has a different head', async () => {
  const d = await draft();
  await service().submit(d.id, d.version);
  review = { ...review!, state: 'closed', merged: true };
  publisher.inspect!.mockResolvedValue({
    state: 'accepted',
    head: 'a'.repeat(40),
    canAccept: false,
  });
  await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
  expect(store.get(d.id).state).toBe('draft');
  expect(store.get(d.id).documents[0]?.content).toBe('# Improved\n');
});

it('does not accept a closed review recovered after a lost acknowledgement without a saved receipt', async () => {
  const d = await draft();
  const create = vi.mocked(publisher.create).getMockImplementation()!;
  vi.mocked(publisher.create).mockImplementationOnce(async (input) => {
    await create(input);
    throw new Error('lost acknowledgement');
  });
  await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
  expect(store.get(d.id).review).toBeUndefined();
  review = { ...review!, state: 'closed', merged: true };
  await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
  expect(store.get(d.id).state).toBe('draft');
  expect(publisher.inspect).not.toHaveBeenCalled();
});

it('requires an exact-head inspector before marking a review accepted', async () => {
  const d = await draft();
  await service().submit(d.id, d.version);
  review = { ...review!, state: 'closed', merged: true };
  publisher.inspect = undefined;
  await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
  expect(store.get(d.id).state).toBe('draft');
});

it('keeps newer unpublished content editable when its previous review was merged', async () => {
  const d = await draft();
  const reviewed = await service().submit(d.id, d.version);
  const edited = store.save(d.id, reviewed.version, [
    {
      path: 'architecture/one.md',
      base: '# Old\n',
      content: '# Unpublished changes\n',
    },
  ]);
  review = { ...review!, state: 'closed', merged: true };
  await expect(service().submit(d.id, edited.version)).rejects.toThrow('remaining edits');
  expect(store.get(d.id).state).toBe('draft');
  expect(store.get(d.id).documents[0]?.content).toBe('# Unpublished changes\n');
  expect(publisher.inspect).not.toHaveBeenCalled();
});
