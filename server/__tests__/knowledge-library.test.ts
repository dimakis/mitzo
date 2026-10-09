import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcceptedKnowledgeSource } from '../knowledge-library-source.js';
import { KnowledgeDraftStore } from '../knowledge-draft-store.js';
import Database from 'better-sqlite3';

let root: string;
let source: AcceptedKnowledgeSource;
let store: KnowledgeDraftStore;
function git(...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-library-test-'));
  git('init', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  for (const path of ['architecture', 'direct_reports', 'scripts', 'architecture/__pycache__'])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'architecture/overview.md'), '# Accepted architecture\n');
  writeFileSync(join(root, 'direct_reports/person.md'), '# Private profile\n');
  writeFileSync(join(root, 'IMPLEMENTATION_SUMMARY.md'), '# Scratch\n');
  writeFileSync(join(root, 'architecture/__pycache__/junk.md'), '# Junk\n');
  writeFileSync(join(root, 'scripts/runtime.md'), '# Runtime\n');
  symlinkSync('../direct_reports/person.md', join(root, 'architecture/link.md'));
  git('add', '.');
  git('commit', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  source = new AcceptedKnowledgeSource(root, 'refs/remotes/origin/main', ['architecture']);
  store = new KnowledgeDraftStore(join(root, 'drafts.sqlite'));
});
afterEach(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('accepted knowledge', () => {
  it('preserves valid UTF-8 replacement characters and byte order marks', async () => {
    const content = '\uFEFF# Literal replacement \uFFFD\n';
    writeFileSync(join(root, 'architecture/overview.md'), content);
    git('add', 'architecture/overview.md');
    git('commit', '-m', 'accepted Unicode text');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const revision = await source.revision();
    expect((await source.read('architecture/overview.md', revision)).content).toBe(content);
  });
  it.each([
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xe2, 0x82]),
    Buffer.from('NUL\0text'),
  ])('rejects malformed UTF-8 or NUL blobs without lossy decoding: %j', async (bytes) => {
    writeFileSync(join(root, 'architecture/overview.md'), bytes);
    git('add', 'architecture/overview.md');
    git('commit', '-m', 'invalid text fixture');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await expect(source.read('architecture/overview.md', await source.revision())).rejects.toThrow(
      'not UTF-8 text',
    );
  });
  it('keeps individual Markdown file scopes exact even when a tree contains similarly named directories', async () => {
    mkdirSync(join(root, 'README.md'));
    writeFileSync(join(root, 'README.md/private.md'), '# Outside the selected file\n');
    git('add', 'README.md');
    git('commit', '-m', 'similarly named directory');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const scoped = new AcceptedKnowledgeSource(root, 'refs/remotes/origin/main', [
      'README.md',
      'architecture/overview.md',
    ]);
    expect(scoped.allowed('architecture/overview.md')).toBe(true);
    expect(scoped.allowed('README.md/private.md')).toBe(false);
    expect((await scoped.catalog()).documents.map((document) => document.path)).toEqual([
      'architecture/overview.md',
    ]);
    await expect(scoped.read('README.md/private.md', await scoped.revision())).rejects.toThrow(
      'Document is outside the library',
    );
    expect(source.allowed('architecture/another.md')).toBe(true);
  });
  it('cancels Git reads when the operation authority expires', async () => {
    await expect(
      source.read('architecture/overview.md', git('rev-parse', 'HEAD'), AbortSignal.abort()),
    ).rejects.toThrow();
  });
  it('reads accepted objects, ignoring dirty task files and later branch commits', async () => {
    const revision = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'architecture/overview.md'), '# Unaccepted\n');
    git('add', 'architecture/overview.md');
    git('commit', '-m', 'local task');
    writeFileSync(join(root, 'architecture/overview.md'), '# Dirty\n');
    expect(await source.catalog()).toEqual({
      revision,
      directories: ['architecture'],
      documentPaths: ['architecture'],
      documents: [
        expect.objectContaining({ path: 'architecture/overview.md', area: 'architecture' }),
      ],
    });
    expect(await source.read('architecture/overview.md', revision)).toMatchObject({
      content: '# Accepted architecture\n',
      revision,
    });
    expect(git('status', '--porcelain')).toContain('architecture/overview.md');
  });
  it('excludes runtime artifacts, unconfigured private areas, symlinks and traversal', async () => {
    const { revision } = await source.catalog();
    for (const path of [
      'direct_reports/person.md',
      '../architecture/overview.md',
      'architecture/link.md',
      'IMPLEMENTATION_SUMMARY.md',
      'architecture/__pycache__/junk.md',
    ])
      await expect(source.read(path, revision)).rejects.toThrow('Document is outside the library');
    await expect(source.read('architecture/overview.md', 'HEAD')).rejects.toThrow('revision');
  });
  it('keeps an opened revision stable when accepted main advances', async () => {
    const before = await source.catalog();
    writeFileSync(join(root, 'architecture/overview.md'), '# New accepted\n');
    git('add', 'architecture/overview.md');
    git('commit', '-m', 'accepted');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect((await source.catalog()).revision).not.toBe(before.revision);
    expect((await source.read('architecture/overview.md', before.revision)).content).toContain(
      'Accepted architecture',
    );
  });
});

describe('operator drafts', () => {
  it.each(['draft', 'accepted'] as const)(
    'preserves a legacy %s draft when a new request collides with its identity',
    (state) => {
      const revision = git('rev-parse', 'HEAD');
      const docs = [
        {
          path: 'architecture/overview.md',
          base: '# Accepted architecture\n',
          content: '# Original\n',
        },
      ];
      const draft = store.create('Original', revision, docs);
      store.save(draft.id, draft.version, [{ ...docs[0]!, content: '# Later saved content\n' }]);
      store.status(draft.id, state);
      const original = store.get(draft.id);
      store.close();
      // Older database rows predate the durable request fingerprint table.
      const legacy = new Database(join(root, 'drafts.sqlite'));
      legacy.prepare('DELETE FROM knowledge_draft_requests WHERE id=?').run(draft.id);
      legacy.close();
      store = new KnowledgeDraftStore(join(root, 'drafts.sqlite'));
      expect(() =>
        store.create(
          'New request',
          revision,
          [{ ...docs[0]!, content: '# Replacement\n' }],
          draft.id,
        ),
      ).toThrow('identity');
      expect(store.get(draft.id)).toEqual(original);
      expect(store.listSummaries()).toHaveLength(1);
      expect(store.listSummaries()[0]?.state).toBe(state);
    },
  );
  it('keeps catalog summaries small and excludes content, while an expired worker cannot overwrite a newer status', () => {
    const draft = store.create('Change', git('rev-parse', 'HEAD'), [
      {
        path: 'architecture/overview.md',
        base: '# Accepted architecture\n',
        content: '# My private draft\n',
      },
    ]);
    expect(store.listSummaries()).toEqual([
      expect.objectContaining({ id: draft.id, documents: [{ path: 'architecture/overview.md' }] }),
    ]);
    expect(JSON.stringify(store.listSummaries())).not.toContain('My private draft');
    const lease = store.acquire(draft.id);
    store.release(draft.id, lease);
    store.status(draft.id, 'accepted');
    expect(() => store.status(draft.id, 'draft', 'Stale failure', lease, draft.version)).toThrow(
      'lease',
    );
    expect(store.get(draft.id).state).toBe('accepted');
  });
  it('rejects content that cannot be opened as an accepted UTF-8 document', () => {
    const documents = [
      {
        path: 'architecture/overview.md',
        base: '# Accepted architecture\n',
        content: '# Invalid\0text',
      },
    ];
    expect(() => store.create('Change', git('rev-parse', 'HEAD'), documents)).toThrow('invalid');
    expect(store.list()).toHaveLength(0);
  });
  it('recovers an initial save with the same request identity without duplicating the change', () => {
    const requestId = '3dc71613-15ab-4f9c-a5ce-25141566f5b9';
    const docs = [
      { path: 'architecture/overview.md', base: '# Accepted architecture\n', content: '# Draft\n' },
    ];
    const first = store.create('Change', git('rev-parse', 'HEAD'), docs, requestId);
    expect(store.create('Change', git('rev-parse', 'HEAD'), docs, requestId)).toEqual(first);
    expect(store.list()).toHaveLength(1);
    expect(() =>
      store.create(
        'Change',
        git('rev-parse', 'HEAD'),
        [{ ...docs[0]!, content: '# Different' }],
        requestId,
      ),
    ).toThrow('request');
  });
  it('persists one versioned change set across restart, independent of chats', () => {
    const draft = store.create('Architecture update', git('rev-parse', 'HEAD'), [
      { path: 'architecture/overview.md', base: '# Accepted architecture\n', content: '# Edit\n' },
    ]);
    const updated = store.save(draft.id, draft.version, [
      {
        path: 'architecture/overview.md',
        base: '# Accepted architecture\n',
        content: '# Better edit\n',
      },
    ]);
    expect(() => store.save(draft.id, draft.version, updated.documents)).toThrow('Draft changed');
    store.close();
    store = new KnowledgeDraftStore(join(root, 'drafts.sqlite'));
    expect(store.get(draft.id)).toEqual(updated);
    expect(store.list()).toHaveLength(1);
    expect(updated.state).toBe('draft');
  });
  it('records review receipts without replacing saved content or declaring publication', () => {
    const d = store.create('Update', git('rev-parse', 'HEAD'), [
      { path: 'architecture/overview.md', base: 'old', content: 'new' },
    ]);
    store.receipt(d.id, d.version, {
      url: 'https://github.com/test/knowledge/pull/1',
      head: 'a'.repeat(40),
    });
    const review = store.get(d.id);
    expect(review.state).toBe('in-review');
    expect(review.documents[0]?.content).toBe('new');
    const changed = store.save(d.id, review.version, [
      { path: 'architecture/overview.md', base: 'old', content: 'newer' },
    ]);
    expect(changed.state).toBe('draft');
    expect(changed.review?.url).toBe(review.review?.url);
    expect(changed.review?.version).toBe(review.version);
  });
});

describe('knowledge structure changes', () => {
  it('lists curated ancestors and only zero-byte regular empty folder markers', async () => {
    for (const folder of [
      'architecture/empty',
      'architecture/bad',
      'architecture/linked',
      'scripts/empty',
    ])
      mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'architecture/empty/.gitkeep'), '');
    writeFileSync(join(root, 'architecture/bad/.gitkeep'), 'not a marker');
    symlinkSync('../overview.md', join(root, 'architecture/linked/.gitkeep'));
    writeFileSync(join(root, 'scripts/empty/.gitkeep'), '');
    git('add', '.');
    git('commit', '-m', 'folders');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect((await source.catalog()).directories).toEqual(['architecture', 'architecture/empty']);
  });
  it('persists folder-only drafts and fingerprints directories', () => {
    const requestId = '12345678-1234-4123-8123-123456789abc';
    const revision = git('rev-parse', 'HEAD');
    const draft = store.create('Folder', revision, [], requestId, ['architecture/new']);
    expect(draft.directories).toEqual(['architecture/new']);
    expect(store.listSummaries()[0]?.directories).toEqual(draft.directories);
    expect(() => store.create('Folder', revision, [], requestId, ['architecture/other'])).toThrow(
      'different content',
    );
  });
  it('rejects duplicate move origins and file-directory collisions', () => {
    const revision = git('rev-parse', 'HEAD');
    const doc = {
      path: 'architecture/new.md',
      sourcePath: 'architecture/overview.md',
      base: 'old',
      content: 'new',
    };
    expect(() =>
      store.create('Moves', revision, [doc, { ...doc, path: 'architecture/other.md' }]),
    ).toThrow();
    expect(() =>
      store.create('Collision', revision, [doc], undefined, ['architecture/new.md/nested']),
    ).toThrow();
  });
});

it('keeps enrolled private boundaries and individually selected root guidance immovable', () => {
  const scoped = new AcceptedKnowledgeSource(root, 'refs/remotes/origin/main', [
    'okrs',
    'README.md',
    'architecture',
  ]);
  expect(
    scoped.allowedMove(
      'okrs/shared_eng_excellence/context/a.md',
      'okrs/private_eng_excellence/context/a.md',
    ),
  ).toBe(false);
  expect(scoped.allowedMove('README.md', 'architecture/README.md')).toBe(false);
});

it('validates moves against non-Markdown entries, symlinks and directory parents', async () => {
  writeFileSync(join(root, 'architecture/occupied.md'), 'occupied');
  writeFileSync(join(root, 'architecture/blob'), 'not a directory');
  mkdirSync(join(root, 'architecture/tree.md'));
  writeFileSync(join(root, 'architecture/tree.md/file.txt'), 'occupied tree');
  git('add', '.');
  git('commit', '-m', 'structural obstacles');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const revision = await source.revision();
  for (const path of [
    'architecture/occupied.md',
    'architecture/tree.md',
    'architecture/link.md',
    'architecture/blob/child.md',
  ]) {
    await expect(
      source.validateStructure(revision, [{ path, sourcePath: 'architecture/overview.md' }]),
    ).rejects.toThrow();
  }
  for (const folder of [
    'architecture/blob/nested',
    'architecture/link.md/nested',
    'architecture/tree.md',
    'architecture/occupied.md',
  ]) {
    await expect(source.validateStructure(revision, [], [folder])).rejects.toThrow();
  }
  await expect(
    source.validateStructure(revision, [
      { path: 'architecture/overview.md', sourcePath: 'architecture/overview.md' },
    ]),
  ).rejects.toThrow('outside');
});
