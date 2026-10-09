import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcceptedKnowledgeSource } from '../knowledge-library-source.js';
import { KnowledgeDraftStore } from '../knowledge-draft-store.js';

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
