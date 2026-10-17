import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { resolveTelosWorkRoleContext } from '../telos-work-role-context.js';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await cleanupJoiningFixtures();
});

async function fixture() {
  const ordinary = await createJoiningFixture();
  const root = mkdtempSync(join(tmpdir(), 'telos-role-host-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,context_hints TEXT,status TEXT,profile TEXT,updated_at TEXT);
    INSERT INTO items VALUES('goal',NULL,'Goal','Overall intent','','["Overall evidence"]','{}','active','manual','original'),('item','goal','Selected item','Selected intent','Selected rationale','["Evidence"]','{}','active','manual','original');
    CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,raw_snippet TEXT,timestamp TEXT);
    CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  db.close();
  const authorizeSettings = vi.fn(async () => {});
  const workspaces = vi.fn(() => ordinary.workspaces);
  const host = () =>
    createTelosWorkRoleHost({
      dbPath: () => path,
      events: ordinary.store,
      workspaces,
      ordinaryConversation: (id) => isAvailableTelosWorkConversation(ordinary.store.getSession(id)),
      resolvePreparation: ordinary.resolvePreparation,
      authorizeSettings,
    });
  const actor = { kind: 'operator' as const, id: 'operator' };
  const assertAuthorized = vi.fn(() => {});
  const request = (raw: unknown) => ({ actor, raw, signal: ordinary.signal, assertAuthorized });
  return { ordinary, path, host, request, authorizeSettings, workspaces, assertAuthorized };
}

async function setupInput(f: Awaited<ReturnType<typeof fixture>>) {
  const contextSelection = await f
    .host()
    .context(f.request({ itemId: 'item', role: 'lead', sourceSnapshotIds: [], artifactRefs: [] }));
  return {
    itemId: 'item',
    requestId: 'lead',
    expectedRevision: contextSelection.brief.revision,
    role: 'lead',
    expectedAssignmentRevision: 0,
    settings: f.ordinary.input.settings,
    contextSelection,
  };
}

it('builds an exact canonical role context from actual selected work and ancestors without allocating a session', async () => {
  const f = await fixture();
  const selection = await f
    .host()
    .context(f.request({ itemId: 'item', role: 'lead', sourceSnapshotIds: [], artifactRefs: [] }));
  expect(selection).toMatchObject({
    version: 1,
    itemId: 'item',
    role: 'lead',
    parentCriteria: [{ itemId: 'goal', criteria: ['Overall evidence'] }],
    overallGoal: { itemId: 'goal', text: 'Overall intent' },
    sources: [],
    artifacts: [],
  });
  expect(selection.brief.text).toContain('Selected intent');
  expect(f.assertAuthorized).toHaveBeenCalled();
  expect(f.workspaces).not.toHaveBeenCalled();
  expect(f.ordinary.store.listSessions()).toHaveLength(1);
});

it('uses real silent ordinary setup and retains canonical role context before returning the atomic lead receipt', async () => {
  const f = await fixture();
  const input = await setupInput(f);
  const receipt = await f.host().setup(f.request(input));
  const leadId = receipt.work.assignments[0].conversation.conversationId;
  expect(receipt.work.assignments[0]).toMatchObject({ role: 'lead', revision: 1 });
  expect(
    f.ordinary.store
      .getSessionEvents(leadId)
      .some((event) => event.type === 'telos_work_role_context'),
  ).toBe(true);
  expect(f.ordinary.store.getOrdinaryInitialCommandId(leadId)).toBeUndefined();
  expect(receipt.work.attempts).toEqual([]);
  expect(f.authorizeSettings).toHaveBeenCalled();
  expect(f.ordinary.store.listSessions()).toHaveLength(2);
});

it('rejects a caller-authored brief even with a valid self hash before touching ordinary workspaces', async () => {
  const f = await fixture();
  const input = await setupInput(f);
  input.contextSelection.brief.text = 'Caller-authored execution mandate';
  input.contextSelection.brief.sha256 = createHash('sha256')
    .update(input.contextSelection.brief.text)
    .digest('hex');
  await expect(f.host().setup(f.request(input))).rejects.toThrow('Reviewed work context changed');
  expect(f.workspaces).not.toHaveBeenCalled();
  expect(f.ordinary.store.listSessions()).toHaveLength(1);
});

it('rechecks canonical ancestor scope after asynchronous settings authorization before preparation', async () => {
  const f = await fixture();
  const input = await setupInput(f);
  f.authorizeSettings.mockImplementationOnce(async () => {
    const db = new Database(f.path);
    db.prepare(
      "UPDATE items SET acceptance_criteria='[\"Changed evidence\"]' WHERE id='goal'",
    ).run();
    db.close();
  });
  await expect(f.host().setup(f.request(input))).rejects.toThrow('Reviewed work context changed');
  expect(f.workspaces).not.toHaveBeenCalled();
  expect(f.ordinary.store.listSessions()).toHaveLength(1);
});

it('recovers the original completed receipt after canonical revisions change and a cold ordinary restart', async () => {
  const f = await fixture();
  const input = await setupInput(f);
  const first = await f.host().setup(f.request(input));
  const db = new Database(f.path);
  db.prepare("UPDATE items SET intent='Later accepted brief' WHERE id='item'").run();
  db.prepare("UPDATE items SET acceptance_criteria='[\"Later criteria\"]' WHERE id='goal'").run();
  db.close();
  f.ordinary.reopen();
  f.workspaces.mockClear();
  f.ordinary.resolvePreparation.mockClear();
  expect(await f.host().setup(f.request(input))).toEqual(first);
  expect(f.workspaces).not.toHaveBeenCalled();
  expect(f.ordinary.resolvePreparation).not.toHaveBeenCalled();
  expect(f.ordinary.store.listSessions()).toHaveLength(2);
  const privateDb = new Database(f.path);
  privateDb.prepare("UPDATE items SET profile='lifeops' WHERE id='goal'").run();
  privateDb.close();
  await expect(f.host().setup(f.request(input))).rejects.toThrow('unavailable');
});

it('rejects a revoked operator after settings waits and never opens canonical data for conversation authority', async () => {
  const f = await fixture();
  const input = await setupInput(f);
  f.authorizeSettings.mockImplementationOnce(async () => {
    f.assertAuthorized.mockImplementation(() => {
      throw new Error('operator revoked');
    });
  });
  await expect(f.host().setup(f.request(input))).rejects.toThrow('operator revoked');
  expect(f.workspaces).not.toHaveBeenCalled();
  f.assertAuthorized.mockImplementation(() => {});
  await expect(
    f.host().context({
      ...f.request({ itemId: 'item', role: 'lead', sourceSnapshotIds: [], artifactRefs: [] }),
      actor: { kind: 'conversation', id: 'source' },
    }),
  ).rejects.toThrow('Interactive operator authority required');
});

it('explicitly prepares an independent reviewer chat while preserving the current worker and its ordinary history', async () => {
  const f = await fixture();
  const work = new TelosWorkStore(f.path, {
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(f.ordinary.store.getSession(id)),
  });
  const actor = f.request({}).actor;
  const worker = work.execute(
    {
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'current-worker',
      expectedRevision: work.read('item', actor).revision,
      role: 'worker',
      conversationId: 'source',
      expectedAssignmentRevision: 0,
    },
    actor,
  );
  const originalWorker = f.ordinary.store.getSession('source');
  const workerEvents = f.ordinary.store.getSessionEvents('source');
  const originalHistory = work.assignmentHistory('item', actor);
  work.close();
  const contextSelection = await f
    .host()
    .context(
      f.request({ itemId: 'item', role: 'reviewer', sourceSnapshotIds: [], artifactRefs: [] }),
    );
  const input = {
    itemId: 'item',
    requestId: 'independent-reviewer',
    expectedRevision: contextSelection.brief.revision,
    role: 'reviewer',
    expectedAssignmentRevision: null,
    settings: f.ordinary.input.settings,
    contextSelection,
  };
  const reviewed = await f.host().setup(f.request(input));
  await expect(
    Promise.resolve().then(() =>
      f.host().setup(f.request({ ...input, expectedAssignmentRevision: 0 })),
    ),
  ).rejects.toThrow('Invalid role assignment selection');
  expect(reviewed.work.assignments).toEqual(worker.work.assignments);
  expect(reviewed.work.links).toEqual(expect.arrayContaining(worker.work.links));
  const reviewer = reviewed.work.links.find((link) => link.role === 'reviewer')!;
  expect(reviewer.conversation.conversationId).not.toBe('source');
  const reviewerSession = f.ordinary.store.getSession(reviewer.conversation.conversationId)!;
  expect(reviewerSession.agentProfile?.definition.name).toBe('Agent');
  expect(
    resolveTelosWorkRoleContext(
      f.ordinary.store,
      reviewerSession.sessionId,
      reviewerSession.accountBinding,
    )?.role,
  ).toBe('reviewer');
  expect(f.ordinary.store.getOrdinaryInitialCommandId(reviewerSession.sessionId)).toBeUndefined();
  expect(reviewed.work.attempts).toEqual([]);
  f.ordinary.reopen();
  expect(await f.host().setup(f.request(input))).toEqual(reviewed);
  expect(f.ordinary.store.getSession('source')).toEqual(originalWorker);
  expect(f.ordinary.store.getSessionEvents('source')).toEqual(workerEvents);
  const reopened = new TelosWorkStore(f.path, {
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(f.ordinary.store.getSession(id)),
  });
  try {
    expect(reopened.assignmentHistory('item', actor)).toEqual(originalHistory);
    expect(() =>
      reopened.execute(
        {
          operation: 'setup_role',
          itemId: 'item',
          requestId: 'invalid-reviewer-assignment',
          expectedRevision: reviewed.work.revision,
          role: 'reviewer',
          conversationId: 'source',
          expectedAssignmentRevision: 0,
        },
        actor,
      ),
    ).toThrow('reviewer cannot');
    expect(reopened.read('item', actor)).toEqual(reviewed.work);
  } finally {
    reopened.close();
  }
  expect(f.ordinary.store.listSessions()).toHaveLength(2);
});

it('retains explicit advisor purpose in the bound chat across a plain conversation reopen', async () => {
  const f = await fixture();
  const contextSelection = await f.host().context(
    f.request({
      itemId: 'item',
      role: 'advisor',
      advisorPurpose: 'child',
      sourceSnapshotIds: [],
      artifactRefs: [],
    }),
  );
  expect(contextSelection).toMatchObject({ role: 'advisor', advisorPurpose: 'child' });
  const input = {
    itemId: 'item',
    requestId: 'child-advisor',
    expectedRevision: contextSelection.brief.revision,
    role: 'advisor',
    expectedAssignmentRevision: null,
    settings: f.ordinary.input.settings,
    contextSelection,
  };
  const receipt = await f.host().setup(f.request(input));
  const advisorId = receipt.work.links.find((link) => link.role === 'advisor')!.conversation
    .conversationId;
  f.ordinary.reopen();
  const session = f.ordinary.store.getSession(advisorId)!;
  expect(
    resolveTelosWorkRoleContext(f.ordinary.store, advisorId, session.accountBinding),
  ).toMatchObject({ itemId: 'item', role: 'advisor', advisorPurpose: 'child' });
  expect(f.ordinary.store.getOrdinaryInitialCommandId(advisorId)).toBeUndefined();
});
