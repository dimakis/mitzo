import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { AcceptedKnowledgeSource } from '../knowledge-library-source.js';
import { KnowledgeDraftStore } from '../knowledge-draft-store.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
import { sessionCredentialTools } from '../session-credential-tools.js';
import { installKnowledgeDraftRuntime } from '../session-knowledge-tools.js';

let root: string;
let store: KnowledgeDraftStore;
let source: AcceptedKnowledgeSource;
let registry: SessionRegistry;
let release: () => void;
let unbind: () => void;
let revision: string;
let refresh: Mock<() => Promise<void>>;
const identity = { turnId: 'turn', callId: 'call' };
const input = () => ({
  requestId: 'a186b239-7960-4791-97fb-15c4be27da6d',
  title: 'Update the intended person profile',
  baseRevision: revision,
  documents: [{ path: 'direct_reports/person.md', content: '# Person\nNew responsibility.\n' }],
});
function git(...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
function tools() {
  return sessionCredentialTools('chat', registry.get('client')!, registry);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-chat-knowledge-'));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'direct_reports'));
  writeFileSync(join(root, 'direct_reports/person.md'), '# Person\nAccepted profile.\n');
  git('add', '.');
  git('commit', '-qm', 'accepted');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  revision = git('rev-parse', 'HEAD');
  // Dirty task files must never become the Library's baseline.
  writeFileSync(join(root, 'direct_reports/person.md'), '# Dirty task copy\n');
  source = new AcceptedKnowledgeSource(root, 'refs/remotes/origin/main', ['direct_reports']);
  store = new KnowledgeDraftStore(':memory:');
  refresh = vi.fn(async () => {});
  release = installKnowledgeDraftRuntime(async () => ({
    source,
    store,
    refresh,
    sourceIdentity: 'github:example/knowledge@main',
  }));
  registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'chat',
    mode: 'auto',
    cwd: root,
    abortController: new AbortController(),
    sessionAllowList: new Set(),
    ownerConnectionId: 'operator',
    accountBinding: { accountId: 'selected', provider: 'openai-codex', model: 'offline' },
  } as never);
  unbind = bindAgentLibraryTransport('operator', { id: 'login', expiresAt: Date.now() + 60_000 });
});
afterEach(() => {
  unbind();
  release();
  registry.dispose();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('reads the enrolled accepted document, independently of the writable task copy', async () => {
  const api = tools();
  expect(api.definitions.map((d) => d.name)).toEqual(
    expect.arrayContaining(['ReadKnowledge', 'SaveKnowledgeDraft']),
  );
  const catalog = await api.execute(
    'ReadKnowledge',
    { action: 'list' },
    new AbortController().signal,
    identity,
  );
  expect(JSON.parse(catalog!.content)).toMatchObject({
    revision,
    documents: [{ path: 'direct_reports/person.md' }],
  });
  const read = await api.execute(
    'ReadKnowledge',
    { action: 'read', path: 'direct_reports/person.md', revision },
    new AbortController().signal,
    identity,
  );
  expect(JSON.parse(read!.content)).toMatchObject({
    content: '# Person\nAccepted profile.\n',
    revision,
  });
  expect(store.list()).toEqual([]);
});

it('saves a visible Library draft at the requested path and returns an honest receipt without publishing', async () => {
  const api = tools();
  const first = await api.execute(
    'SaveKnowledgeDraft',
    input(),
    new AbortController().signal,
    identity,
  );
  expect(first?.isError).toBe(false);
  const receipt = JSON.parse(first!.content);
  expect(receipt).toMatchObject({
    status: 'draft-saved',
    libraryUrl: '/knowledge',
    accepted: false,
    documents: ['direct_reports/person.md'],
    nextAction: 'Open Knowledge → Drafts and send this draft for review.',
  });
  expect(store.get(receipt.draftId)).toMatchObject({
    state: 'draft',
    baseRevision: revision,
    documents: [
      {
        path: 'direct_reports/person.md',
        base: '# Person\nAccepted profile.\n',
        content: input().documents[0].content,
      },
    ],
  });
  expect(
    await api.execute('SaveKnowledgeDraft', input(), new AbortController().signal, {
      ...identity,
      callId: 'retry',
    }),
  ).toEqual(first);
  expect(store.list()).toHaveLength(1);
  expect((await source.read('direct_reports/person.md', revision)).content).toBe(
    '# Person\nAccepted profile.\n',
  );
});

it('preserves a saved draft when the same request is retried with different content', async () => {
  const api = tools();
  await api.execute('SaveKnowledgeDraft', input(), new AbortController().signal, identity);
  const changed = input();
  changed.documents[0].content = 'Different proposal';
  expect(
    (await api.execute('SaveKnowledgeDraft', changed, new AbortController().signal, identity))
      ?.isError,
  ).toBe(true);
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0].documents[0].content).toBe(input().documents[0].content);
});

it('recovers the same draft after a model change on the same account', async () => {
  const api = tools();
  const first = await api.execute(
    'SaveKnowledgeDraft',
    input(),
    new AbortController().signal,
    identity,
  );
  const session = registry.get('client')!;
  session.accountBinding = { ...session.accountBinding!, model: 'another-offline-model' };
  const retry = await api.execute(
    'SaveKnowledgeDraft',
    input(),
    new AbortController().signal,
    identity,
  );
  expect(retry).toEqual(first);
  expect(store.list()).toHaveLength(1);
});

it('recovers a receipt without overwriting later human edits or requiring the old accepted tip', async () => {
  const api = tools();
  const first = await api.execute(
    'SaveKnowledgeDraft',
    input(),
    new AbortController().signal,
    identity,
  );
  const { draftId } = JSON.parse(first!.content);
  const saved = store.get(draftId);
  store.save(
    saved.id,
    saved.version,
    saved.documents.map((d) => ({ ...d, content: 'Later human edit' })),
  );
  writeFileSync(join(root, 'direct_reports/person.md'), '# Later accepted version\n');
  git('add', '.');
  git('commit', '-qm', 'later accepted');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const retry = await api.execute(
    'SaveKnowledgeDraft',
    input(),
    new AbortController().signal,
    identity,
  );
  expect(retry?.isError).toBe(false);
  expect(JSON.parse(retry!.content)).toMatchObject({ draftId, version: 2, status: 'draft-saved' });
  expect(store.get(draftId).documents[0].content).toBe('Later human edit');
});

it.each(['accepted', 'closed'] as const)(
  'reports the current %s state when recovering a finished draft',
  async (state) => {
    const api = tools();
    const first = await api.execute(
      'SaveKnowledgeDraft',
      input(),
      new AbortController().signal,
      identity,
    );
    const { draftId } = JSON.parse(first!.content);
    store.status(draftId, state);
    const retry = await api.execute(
      'SaveKnowledgeDraft',
      input(),
      new AbortController().signal,
      identity,
    );
    const receipt = JSON.parse(retry!.content);
    expect(receipt).toMatchObject({ status: state, accepted: state === 'accepted' });
    expect(receipt.nextAction).not.toMatch(/send this draft for review/i);
    expect(receipt).not.toHaveProperty('published');
    expect(receipt).not.toHaveProperty('adopted');
  },
);

it('refuses a no-op proposal', async () => {
  const request = input();
  request.documents[0].content = '# Person\nAccepted profile.\n';
  expect(
    (await tools().execute('SaveKnowledgeDraft', request, new AbortController().signal, identity))
      ?.isError,
  ).toBe(true);
  expect(store.list()).toEqual([]);
});

it('rechecks authorization after a private document read before returning its text', async () => {
  const read = source.read.bind(source);
  vi.spyOn(source, 'read').mockImplementation(async (...args) => {
    const result = await read(...args);
    unbind();
    return result;
  });
  const result = await tools().execute(
    'ReadKnowledge',
    { action: 'read', path: 'direct_reports/person.md', revision },
    new AbortController().signal,
    identity,
  );
  expect(result?.isError).toBe(true);
  expect(result?.content).not.toContain('Accepted profile.');
});

it.each([
  'memory/Observations/draft.md',
  '../direct_reports/person.md',
  '/private/profile.md',
  'direct_reports/missing.md',
])('refuses an unaccepted or unintended destination %s', async (path) => {
  const request = input();
  request.documents[0].path = path;
  expect(
    (await tools().execute('SaveKnowledgeDraft', request, new AbortController().signal, identity))
      ?.isError,
  ).toBe(true);
  expect(store.list()).toEqual([]);
});

it('refreshes accepted knowledge and rejects stale proposals without substituting another document', async () => {
  refresh.mockImplementation(async () => {
    writeFileSync(join(root, 'direct_reports/person.md'), '# New accepted version\n');
    git('add', '.');
    git('commit', '-qm', 'new accepted');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  });
  const result = await tools().execute(
    'SaveKnowledgeDraft',
    input(),
    new AbortController().signal,
    identity,
  );
  expect(result?.isError).toBe(true);
  expect(result?.content).toMatch(/accepted knowledge changed/i);
  expect(store.list()).toEqual([]);
});

it('requires an authenticated interactive operator even for reads', async () => {
  unbind();
  const catalog = vi.spyOn(source, 'catalog');
  expect(
    (
      await tools().execute(
        'ReadKnowledge',
        { action: 'list' },
        new AbortController().signal,
        identity,
      )
    )?.isError,
  ).toBe(true);
  expect(catalog).not.toHaveBeenCalled();
  expect(store.list()).toEqual([]);
});

it.each(['logout', 'account', 'abort', 'ask', 'profile'])(
  'rechecks %s after source reads before saving or disclosing content',
  async (change) => {
    const api = tools();
    const original = source.read.bind(source);
    vi.spyOn(source, 'read').mockImplementation(async (...args) => {
      const result = await original(...args);
      const session = registry.get('client')!;
      if (change === 'logout') unbind();
      if (change === 'account')
        session.accountBinding = { ...session.accountBinding!, accountId: 'other' };
      if (change === 'abort') session.abortController.abort();
      if (change === 'ask') session.mode = 'ask';
      if (change === 'profile') bindAgentToolSelection(session, { tools: [] } as never);
      return result;
    });
    const result = await api.execute(
      'SaveKnowledgeDraft',
      input(),
      new AbortController().signal,
      identity,
    );
    expect(result?.isError).toBe(true);
    expect(result?.content).not.toContain('Accepted profile.');
    expect(store.list()).toEqual([]);
  },
);

it('does not let Ask mode save drafts', async () => {
  registry.get('client')!.mode = 'ask';
  expect(
    (await tools().execute('SaveKnowledgeDraft', input(), new AbortController().signal, identity))
      ?.isError,
  ).toBe(true);
  expect(store.list()).toEqual([]);
});
