import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcceptedKnowledgeSource } from '../knowledge-library-source.js';
import { KnowledgeDraftStore, KNOWLEDGE_RECOVERY_BUNDLE_LIMIT } from '../knowledge-draft-store.js';
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
  sendForReview: ReturnType<
    typeof vi.fn<
      (
        input: KnowledgeReviewIdentity & { beforeReady?: () => void },
      ) => Promise<KnowledgeReviewInspection & { state: 'in-review'; draft: false }>
    >
  >;
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-review-test-')));
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
    sendForReview: vi.fn(async (input) => {
      input.beforeReady?.();
      if (!review || review.state !== 'open' || review.merged || remoteHead !== input.head)
        throw new Error('Review changed');
      review = { ...review, draft: false };
      return { state: 'in-review', head: input.head, draft: false, canAccept: false };
    }),
    inspect: vi.fn(async (input) => {
      if (remoteHead !== input.head) throw new Error('Merged head changed');
      return {
        state: review?.merged ? 'accepted' : 'in-review',
        draft: review?.draft,
        head: input.head,
        canAccept: false,
        mergeCommit: 'b'.repeat(40),
      };
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
    update: vi.fn(async (input) => (review = { ...review!, draft: input.draft })),
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
async function restoreDraftBackup() {
  const backup = join(root, 'restored-drafts.sqlite');
  await store.backupSnapshot(backup);
  store.close();
  store = new KnowledgeDraftStore(backup);
  const mirror = join(root, 'restored-source.git');
  execFileSync('git', [
    'clone',
    '--bare',
    '--no-local',
    '--single-branch',
    '--branch',
    'main',
    root,
    mirror,
  ]);
  execFileSync('git', ['-C', mirror, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
  source = new AcceptedKnowledgeSource(mirror, 'refs/remotes/origin/main', ['architecture']);
  return (args: string[]) =>
    execFileSync('git', ['-C', mirror, ...args], { encoding: 'utf8' }).trim();
}
async function draft() {
  return store.create('Architecture', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# Improved\n' },
  ]);
}

it.each(['before push', 'lost push acknowledgement'])(
  'recovers the exact prepared commit from a SQLite backup after %s into a fresh mirror',
  async (failure) => {
    const d = await draft();
    const push = vi.mocked(publisher.push).getMockImplementation()!;
    vi.mocked(publisher.push).mockImplementationOnce(async (input) => {
      if (failure === 'lost push acknowledgement') await push(input);
      throw new Error('interrupted push');
    });
    await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
    const prepared = store.get(d.id).publication!.head;
    const restoredGit = await restoreDraftBackup();
    expect(() => restoredGit(['cat-file', '-e', `${prepared}^{commit}`])).toThrow();
    const saved = await service().submit(d.id, d.version);
    expect(saved.review?.head).toBe(prepared);
    expect(remoteHead).toBe(prepared);
    expect(restoredGit(['show', `${prepared}:architecture/one.md`])).toBe('# Improved');
    expect(publisher.create).toHaveBeenCalledTimes(1);
    expect(publisher.push).toHaveBeenCalledTimes(failure === 'before push' ? 2 : 1);
  },
);

it('recovers published ancestry from backup before saving new edits, preserving the existing review', async () => {
  const d = await draft();
  const first = await service().submit(d.id, d.version);
  const previousHead = first.review!.head;
  const restoredGit = await restoreDraftBackup();
  const next = store.save(d.id, d.version, [
    { path: 'architecture/one.md', base: '# Old\n', content: '# After restore\n' },
  ]);
  const saved = await service().submit(next.id, next.version);
  expect(saved.review?.url).toBe(first.review?.url);
  expect(saved.review?.head).not.toBe(previousHead);
  expect(restoredGit(['rev-parse', `${saved.review!.head}^1`])).toBe(previousHead);
  expect(restoredGit(['show', `${saved.review!.head}:architecture/one.md`])).toBe(
    '# After restore',
  );
  expect(publisher.create).toHaveBeenCalledTimes(1);
});

it('rebuilds a legacy prepared commit only when no branch or review was published', async () => {
  const d = await draft();
  const missing = 'a'.repeat(40);
  store.prepared(d.id, d.version, missing);
  const saved = await service().submit(d.id, d.version);
  expect(saved.review?.head).not.toBe(missing);
  expect(git('show', `${saved.review!.head}:architecture/one.md`)).toBe('# Improved');
  expect(store.recoveryBundle(d.id, saved.review!.head)).toBeDefined();
});

it.each(['remote', 'review'])(
  'does not replace a missing legacy head with a confirmed %s',
  async (known) => {
    const d = await draft();
    const missing = 'a'.repeat(40);
    store.prepared(d.id, d.version, missing);
    if (known === 'remote') remoteHead = missing;
    else
      store.receipt(d.id, d.version, {
        head: missing,
        url: 'https://github.com/test/knowledge/pull/1',
      });
    await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
    expect(store.get(d.id).publication?.head).toBe(missing);
    expect(publisher.push).not.toHaveBeenCalled();
    expect(publisher.create).not.toHaveBeenCalled();
  },
);

it('refuses a corrupt recovery bundle without rebuilding or changing the external head', async () => {
  const d = await draft();
  const head = 'a'.repeat(40);
  store.prepared(d.id, d.version, head, undefined, Buffer.from('corrupt bundle'));
  await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
  expect(store.get(d.id).publication?.head).toBe(head);
  expect(publisher.push).not.toHaveBeenCalled();
});

it('refuses mismatched stored recovery state instead of treating it as a legacy backup', async () => {
  const d = await draft();
  store.prepared(d.id, d.version, 'a'.repeat(40), undefined, Buffer.from('recovery bytes'));
  const savedHead = 'b'.repeat(40);
  // Represent a restored draft whose publication and recovery row disagree.
  store.prepared(d.id, d.version, savedHead);
  await expect(service().submit(d.id, d.version)).rejects.toThrow('Draft saved');
  expect(store.get(d.id).publication?.head).toBe(savedHead);
  expect(publisher.push).not.toHaveBeenCalled();
  expect(publisher.create).not.toHaveBeenCalled();
});

it('atomically refuses an oversized recovery bundle without replacing the saved head or bundle', async () => {
  const d = await draft();
  const head = 'a'.repeat(40);
  const original = Buffer.from('saved recovery bytes');
  store.prepared(d.id, d.version, head, undefined, original);
  expect(() =>
    store.prepared(
      d.id,
      d.version,
      'b'.repeat(40),
      undefined,
      Buffer.alloc(KNOWLEDGE_RECOVERY_BUNDLE_LIMIT + 1),
    ),
  ).toThrow('limit');
  expect(store.get(d.id).publication?.head).toBe(head);
  expect(store.recoveryBundle(d.id, head)).toEqual(original);
  expect(JSON.stringify(store.get(d.id))).not.toContain('saved recovery bytes');
});

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

async function readyReviewWithNewEdits() {
  const initial = await draft();
  await service().submit(initial.id, initial.version);
  review = { ...review!, draft: false };
  return store.save(initial.id, initial.version, [
    {
      path: 'architecture/one.md',
      base: '# Old\n',
      content: '# New saved edits\n',
    },
  ]);
}

it('confirms a ready review is draft at its exact old head before pushing saved edits', async () => {
  const edited = await readyReviewWithNewEdits();
  const oldHead = remoteHead;
  const order: string[] = [];
  const update = vi.mocked(publisher.update).getMockImplementation()!;
  vi.mocked(publisher.update).mockImplementation(async (input) => {
    order.push('draft');
    expect(remoteHead).toBe(oldHead);
    return update(input);
  });
  const inspect = publisher.inspect!.getMockImplementation()!;
  publisher.inspect!.mockImplementation(async (input) => {
    order.push('inspect');
    expect(input.head).toBe(oldHead);
    expect(review?.draft).toBe(true);
    return inspect(input);
  });
  vi.mocked(publisher.push).mockImplementation(async ({ directory }) => {
    order.push('push');
    expect(review?.draft).toBe(true);
    expect(order).toEqual(['draft', 'inspect', 'push']);
    remoteHead = directory;
  });
  const saved = await service().submit(edited.id, edited.version);
  expect(saved.state).toBe('in-review');
  expect(saved.review?.head).not.toBe(oldHead);
  expect(publisher.create).toHaveBeenCalledTimes(1);
});

it.each([
  'conversion',
  'ready-state',
  'wrong-head',
  'wrong-scope',
  'closed-state',
  'missing-inspector',
])(
  'keeps edits and the external head unchanged when draft confirmation fails: %s',
  async (failure) => {
    const edited = await readyReviewWithNewEdits();
    const oldHead = remoteHead;
    vi.mocked(publisher.push).mockClear();
    if (failure === 'conversion')
      vi.mocked(publisher.update).mockRejectedValue(new Error('failed'));
    if (failure === 'ready-state')
      publisher.inspect!.mockResolvedValue({
        state: 'in-review',
        draft: false,
        head: oldHead!,
        canAccept: false,
      });
    if (failure === 'wrong-head')
      publisher.inspect!.mockResolvedValue({
        state: 'in-review',
        draft: true,
        head: 'a'.repeat(40),
        canAccept: false,
      });
    if (failure === 'wrong-scope')
      vi.mocked(publisher.update).mockResolvedValue({
        ...review!,
        draft: true,
        sourceBranch: 'knowledge/another',
      });
    if (failure === 'closed-state')
      vi.mocked(publisher.update).mockResolvedValue({
        ...review!,
        draft: true,
        state: 'closed',
      });
    if (failure === 'missing-inspector') publisher.inspect = undefined;
    await expect(service().submit(edited.id, edited.version)).rejects.toThrow('Draft saved');
    expect(publisher.push).not.toHaveBeenCalled();
    expect(remoteHead).toBe(oldHead);
    expect(store.get(edited.id).documents[0]?.content).toBe('# New saved edits\n');
    expect(store.get(edited.id).state).toBe('draft');
  },
);

it('recovers a lost draft conversion acknowledgement without pushing while ready or duplicating reviews', async () => {
  const edited = await readyReviewWithNewEdits();
  const oldHead = remoteHead;
  const update = vi.mocked(publisher.update).getMockImplementation()!;
  vi.mocked(publisher.update).mockImplementationOnce(async (input) => {
    await update(input);
    throw new Error('lost acknowledgement');
  });
  vi.mocked(publisher.push).mockClear();
  await expect(service().submit(edited.id, edited.version)).rejects.toThrow('Draft saved');
  expect(publisher.push).not.toHaveBeenCalled();
  expect(remoteHead).toBe(oldHead);
  expect(review?.draft).toBe(true);
  const preparedHead = store.get(edited.id).publication?.head;
  await service().submit(edited.id, edited.version);
  expect(remoteHead).toBe(preparedHead);
  expect(publisher.push).toHaveBeenCalledTimes(1);
  expect(publisher.create).toHaveBeenCalledTimes(1);
});

it('fences revoked authority before changing a ready review or pushing its new head', async () => {
  const edited = await readyReviewWithNewEdits();
  const controller = new AbortController();
  const reconstruct = vi.mocked(publisher.reconstruct).getMockImplementation()!;
  vi.mocked(publisher.reconstruct).mockImplementationOnce(async (input) => {
    const result = await reconstruct(input);
    controller.abort();
    return result;
  });
  vi.mocked(publisher.update).mockClear();
  vi.mocked(publisher.push).mockClear();
  await expect(service().submit(edited.id, edited.version, controller.signal)).rejects.toThrow(
    'Draft saved',
  );
  expect(publisher.update).not.toHaveBeenCalled();
  expect(publisher.push).not.toHaveBeenCalled();
  expect(review?.draft).toBe(false);
});

it.each(['revoked', 'expired'])(
  'fences %s ownership during draft conversion before pushing',
  async (failure) => {
    const edited = await readyReviewWithNewEdits();
    const oldHead = remoteHead;
    const controller = new AbortController();
    const update = vi.mocked(publisher.update).getMockImplementation()!;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(publisher.update).mockImplementationOnce(async (input) => {
      const result = await update(input);
      if (failure === 'revoked') controller.abort();
      else clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 181_000);
      return result;
    });
    vi.mocked(publisher.push).mockClear();
    try {
      await expect(
        service().submit(edited.id, edited.version, controller.signal),
      ).rejects.toThrow();
      expect(publisher.push).not.toHaveBeenCalled();
      expect(publisher.inspect).not.toHaveBeenCalled();
      expect(remoteHead).toBe(oldHead);
      expect(store.get(edited.id).documents[0]?.content).toBe('# New saved edits\n');
    } finally {
      clock?.mockRestore();
    }
  },
);

it('projects a move without losing original content and prepares recovery before push', async () => {
  const draft = store.create('Move', await source.revision(), [
    {
      path: 'architecture/nested/renamed.md',
      sourcePath: 'architecture/one.md',
      base: '# Old\n',
      content: '# Old\n',
    },
  ]);
  const saved = await service().submit(draft.id, 1);
  expect(git('show', saved.review!.head + ':architecture/nested/renamed.md')).toBe('# Old');
  expect(git('ls-tree', '-r', '--name-only', saved.review!.head)).not.toContain(
    'architecture/one.md',
  );
  expect(store.recoveryBundle(draft.id, saved.review!.head)).toBeDefined();
});
it('projects folder-only drafts as invisible zero-byte markers', async () => {
  const draft = store.create('Folder', await source.revision(), [], undefined, [
    'architecture/new',
  ]);
  const saved = await service().submit(draft.id, 1);
  expect(git('show', saved.review!.head + ':architecture/new/.gitkeep')).toBe('');
});
it('refuses occupied move destinations without pushing', async () => {
  writeFileSync(join(root, 'architecture/two.md'), '# Destination\n');
  git('add', 'architecture/two.md');
  git('commit', '-m', 'destination');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const draft = store.create('Move', await source.revision(), [
    {
      path: 'architecture/two.md',
      sourcePath: 'architecture/one.md',
      base: '# Old\n',
      content: '# Old\n',
    },
  ]);
  await expect(service().submit(draft.id, 1)).rejects.toThrow('destination');
  expect(publisher.push).not.toHaveBeenCalled();
});

it.each(['source', 'destination', 'folder'] as const)(
  'refuses accepted %s changes after a move draft starts',
  async (kind) => {
    const draft = store.create(
      'Move',
      await source.revision(),
      [
        {
          path: 'architecture/new/one.md',
          sourcePath: 'architecture/one.md',
          base: '# Old\n',
          content: '# Old\n',
        },
      ],
      undefined,
      ['architecture/new'],
    );
    if (kind === 'source') writeFileSync(join(root, 'architecture/one.md'), '# Concurrent\n');
    else {
      mkdirSync(join(root, 'architecture/new'));
      writeFileSync(
        join(
          root,
          kind === 'destination' ? 'architecture/new/one.md' : 'architecture/new/other.txt',
        ),
        '# Concurrent\n',
      );
    }
    git('add', '.');
    git('commit', '-m', 'concurrent accepted change');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await expect(service().submit(draft.id, 1)).rejects.toThrow(
      kind === 'source' ? 'changed since' : 'destination',
    );
    expect(publisher.push).not.toHaveBeenCalled();
    expect(store.get(draft.id).documents[0]?.sourcePath).toBe('architecture/one.md');
  },
);
it('projects successive moves and move-back from the first accepted origin', async () => {
  const draft = store.create('Move', await source.revision(), [
    {
      path: 'architecture/second.md',
      sourcePath: 'architecture/one.md',
      base: '# Old\n',
      content: '# Old\n',
    },
  ]);
  await service().submit(draft.id, 1);
  store.save(draft.id, 1, [
    {
      path: 'architecture/third.md',
      sourcePath: 'architecture/one.md',
      base: '# Old\n',
      content: '# Old\n',
    },
  ]);
  const moved = await service().submit(draft.id, 2);
  expect(git('ls-tree', '-r', '--name-only', moved.review!.head)).toBe('architecture/third.md');
  store.save(draft.id, 2, [{ path: 'architecture/one.md', base: '# Old\n', content: '# Old\n' }]);
  const returned = await service().submit(draft.id, 3);
  expect(git('ls-tree', '-r', '--name-only', returned.review!.head)).toBe('architecture/one.md');
  expect(returned.documents[0]?.sourcePath).toBeUndefined();
});

it('coalesces locally saved versions and structural changes into one explicit review batch', async () => {
  writeFileSync(join(root, 'architecture/two.md'), '# Other old\n');
  git('add', 'architecture/two.md');
  git('commit', '-m', 'another accepted file');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# First\n' },
  ]);
  store.save(draft.id, 1, [
    { path: 'architecture/one.md', base: '# Old\n', content: '# Second\n' },
  ]);
  store.save(
    draft.id,
    2,
    [
      {
        path: 'architecture/new/one.md',
        sourcePath: 'architecture/one.md',
        base: '# Old\n',
        content: '# Latest\n',
      },
      { path: 'architecture/two.md', base: '# Other old\n', content: '# Other latest\n' },
    ],
    undefined,
    ['architecture/empty'],
  );
  expect(publisher.push).not.toHaveBeenCalled();
  expect(publisher.create).not.toHaveBeenCalled();
  const sent = await service().sendForReview(draft.id, 3);
  expect(sent.review).toMatchObject({ version: 3, ready: true });
  expect(git('show', sent.review!.head + ':architecture/new/one.md')).toBe('# Latest');
  expect(git('show', sent.review!.head + ':architecture/two.md')).toBe('# Other latest');
  expect(git('show', sent.review!.head + ':architecture/empty/.gitkeep')).toBe('');
  expect(git('ls-tree', '-r', '--name-only', sent.review!.head)).not.toContain(
    'architecture/one.md',
  );
  expect(publisher.push).toHaveBeenCalledOnce();
  expect(publisher.create).toHaveBeenCalledOnce();
  await service().sendForReview(draft.id, 3);
  expect(publisher.push).toHaveBeenCalledOnce();
  expect(publisher.create).toHaveBeenCalledOnce();
  expect(publisher.update).not.toHaveBeenCalled();
});
it('keeps one lease through publication and the readiness mutation', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# New\n' },
  ]);
  publisher.sendForReview.mockImplementation(async (input) => {
    expect(() => store.save(draft.id, 1, draft.documents)).toThrow('saving its review');
    expect(input.beforeReady).toBeTypeOf('function');
    input.beforeReady!();
    review = { ...review!, draft: false };
    return { state: 'in-review', head: input.head, draft: false, canAccept: false };
  });
  expect((await service().sendForReview(draft.id, 1)).review?.ready).toBe(true);
});
it('retries ambiguous ready acknowledgement without repushing or redrafting the confirmed head', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# New\n' },
  ]);
  const original = publisher.sendForReview.getMockImplementation()!;
  publisher.sendForReview.mockImplementationOnce(async (input) => {
    await original(input);
    throw new Error('Ready response lost');
  });
  await expect(service().sendForReview(draft.id, 1)).rejects.toThrow('Retry Send');
  const uncertain = store.get(draft.id);
  const head = uncertain.review!.head;
  expect(uncertain.review?.ready).toBe(false);
  expect(store.recoveryBundle(draft.id, head)).toBeDefined();
  const retried = await service().sendForReview(draft.id, 1);
  expect(retried.review).toMatchObject({ head, version: 1, ready: true });
  expect(publisher.push).toHaveBeenCalledOnce();
  expect(publisher.create).toHaveBeenCalledOnce();
  expect(publisher.update).not.toHaveBeenCalled();
});
it('preserves prepared recovery after an ambiguous push while newer edits stage locally', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# First\n' },
  ]);
  publisher.push = vi.fn(async ({ directory }) => {
    remoteHead = directory;
    throw new Error('Push acknowledgement lost');
  });
  await expect(service().sendForReview(draft.id, 1)).rejects.toThrow();
  const prepared = store.get(draft.id).publication!;
  const recovery = store.recoveryBundle(draft.id, prepared.head)!;
  const staged = store.save(draft.id, 1, [
    { path: 'architecture/one.md', base: '# Old\n', content: '# Latest\n' },
  ]);
  expect(staged.publication).toEqual(prepared);
  expect(store.recoveryBundle(draft.id, prepared.head)).toEqual(recovery);
  expect(publisher.push).toHaveBeenCalledOnce();
  expect(publisher.create).not.toHaveBeenCalled();
  publisher.push = vi.fn(async ({ directory }) => {
    remoteHead = directory;
  });
  const sent = await service().sendForReview(draft.id, 2);
  expect(git('show', sent.review!.head + ':architecture/one.md')).toBe('# Latest');
  expect(git('merge-base', '--is-ancestor', prepared.head, sent.review!.head)).toBe('');
  expect(publisher.push).toHaveBeenCalledOnce();
  expect(publisher.create).toHaveBeenCalledOnce();
});

it('stages later versions without touching the existing ready review and sends only the latest batch', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# First\n' },
  ]);
  const first = await service().sendForReview(draft.id, 1);
  const head = first.review!.head;
  store.save(draft.id, 1, [
    { path: 'architecture/one.md', base: '# Old\n', content: '# Second\n' },
  ]);
  store.save(draft.id, 2, [
    { path: 'architecture/one.md', base: '# Old\n', content: '# Latest\n' },
  ]);
  expect(remoteHead).toBe(head);
  expect(review?.draft).toBe(false);
  expect(publisher.push).toHaveBeenCalledOnce();
  expect(publisher.update).not.toHaveBeenCalled();
  const sent = await service().sendForReview(draft.id, 3);
  expect(sent.review).toMatchObject({ url: first.review!.url, version: 3, ready: true });
  expect(git('show', sent.review!.head + ':architecture/one.md')).toBe('# Latest');
  expect(publisher.create).toHaveBeenCalledOnce();
  expect(publisher.push).toHaveBeenCalledTimes(2);
  expect(publisher.update).toHaveBeenCalledOnce();
});
it('recovers an ambiguous push at the same saved version without a second push', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# New\n' },
  ]);
  vi.mocked(publisher.push).mockImplementationOnce(async ({ directory }) => {
    remoteHead = directory;
    throw new Error('Push response lost');
  });
  await expect(service().sendForReview(draft.id, 1)).rejects.toThrow();
  const head = store.get(draft.id).publication!.head;
  const retried = await service().sendForReview(draft.id, 1);
  expect(retried.review).toMatchObject({ head, version: 1, ready: true });
  expect(publisher.push).toHaveBeenCalledOnce();
  expect(publisher.create).toHaveBeenCalledOnce();
});
it('recovers an ambiguous PR creation without another metadata update or duplicate review', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# New\n' },
  ]);
  const create = vi.mocked(publisher.create).getMockImplementation()!;
  vi.mocked(publisher.create).mockImplementationOnce(async (input) => {
    await create(input);
    throw new Error('PR response lost');
  });
  await expect(service().sendForReview(draft.id, 1)).rejects.toThrow();
  const head = store.get(draft.id).publication!.head;
  expect((await service().sendForReview(draft.id, 1)).review).toMatchObject({ head, ready: true });
  expect(publisher.push).toHaveBeenCalledOnce();
  expect(publisher.create).toHaveBeenCalledOnce();
  expect(publisher.update).not.toHaveBeenCalled();
});

it('blocks readiness after a lease expires without overwriting newer staged content', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# First\n' },
  ]);
  const now = Date.now();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  let readyMutated = false;
  publisher.sendForReview.mockImplementation(async (input) => {
    clock = vi.spyOn(Date, 'now').mockReturnValue(now + 181000);
    store.save(draft.id, 1, [
      { path: 'architecture/one.md', base: '# Old\n', content: '# Newer staged\n' },
    ]);
    input.beforeReady!();
    readyMutated = true;
    return { state: 'in-review', head: input.head, draft: false, canAccept: false };
  });
  try {
    await expect(service().sendForReview(draft.id, 1)).rejects.toThrow('lease expired');
    expect(readyMutated).toBe(false);
    expect(store.get(draft.id)).toMatchObject({
      state: 'draft',
      version: 2,
      documents: [{ content: '# Newer staged\n' }],
      review: { version: 1, ready: false },
    });
  } finally {
    clock?.mockRestore();
  }
});
it('checks revoked authorization before readiness and keeps the exact published batch recoverable', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Old\n', content: '# First\n' },
  ]);
  const authorization = new AbortController();
  let readyMutated = false;
  publisher.sendForReview.mockImplementation(async (input) => {
    authorization.abort();
    input.beforeReady!();
    readyMutated = true;
    return { state: 'in-review', head: input.head, draft: false, canAccept: false };
  });
  await expect(service().sendForReview(draft.id, 1, authorization.signal)).rejects.toThrow();
  const retained = store.get(draft.id);
  expect(readyMutated).toBe(false);
  expect(retained.review).toMatchObject({ version: 1, ready: false });
  expect(store.recoveryBundle(draft.id, retained.publication!.head)).toBeDefined();
});
