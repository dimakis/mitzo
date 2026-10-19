import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosWorkStore } from '../telos-work-store.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';
import { TelosWorkRoleSetup } from '../telos-work-role-setup.js';
import {
  retainTelosWorkRoleContext,
  TelosWorkRoleContextSelectionSchema,
} from '../telos-work-role-context.js';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await cleanupJoiningFixtures();
});

async function roleFixture() {
  const f = await createJoiningFixture();
  const root = mkdtempSync(join(tmpdir(), 'telos-role-owner-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,updated_at TEXT); INSERT INTO items VALUES('item',NULL,'Source-only item','original')",
  );
  db.close();
  const open = () =>
    new TelosWorkStore(path, {
      ordinaryConversation: (id) => isAvailableTelosWorkConversation(f.store.getSession(id)),
    });
  let work = open();
  cleanups.push(() => work.close());
  const actor = { kind: 'operator' as const, id: 'operator' };
  work.execute(
    {
      operation: 'link',
      itemId: 'item',
      requestId: 'origin',
      expectedRevision: work.read('item', actor).revision,
      role: 'origin',
      conversation: {
        namespace: 'external_codex',
        conversationId: 'source',
        url: 'codex://threads/source',
      },
    },
    actor,
  );
  const brief = 'Selected work';
  work.execute(
    {
      operation: 'source',
      itemId: 'item',
      requestId: 'adopt-source',
      expectedRevision: work.read('item', actor).revision,
      snapshot: {
        version: 1,
        snapshotId: 'reviewed-source',
        itemId: 'item',
        source: {
          namespace: 'external_codex',
          conversationId: 'source',
          url: 'codex://threads/source',
        },
        selection: { kind: 'unknown' },
        adoptedBrief: null,
        artifacts: [],
        author: 'operator',
        sourceCreatedAt: null,
        adoptedAt: null,
      },
    },
    actor,
  );
  const input = {
    itemId: 'item',
    requestId: 'setup-lead',
    expectedRevision: work.read('item', actor).revision,
    role: 'lead' as const,
    expectedAssignmentRevision: 0,
    settings: f.input.settings,
    contextSelection: {
      version: 1,
      itemId: 'item',
      role: 'lead',
      brief: {
        revision: 'r1',
        sha256: createHash('sha256').update(brief).digest('hex'),
        text: brief,
      },
      parentCriteria: [],
      overallGoal: { itemId: 'item', revision: 'r1', text: 'Goal' },
      sources: work.read('item', actor).sources,
      artifacts: [],
    },
  };
  const authorize = vi.fn(async () => {});
  const assertBeforeApply = vi.fn(() => {});
  const retainContext = vi.fn(
    async (scope: { conversationId: string; setup: { input: { contextSelection: unknown } } }) => {
      retainTelosWorkRoleContext(
        f.store,
        scope.conversationId,
        f.store.getSession(scope.conversationId)!.accountBinding!,
        TelosWorkRoleContextSelectionSchema.parse(scope.setup.input.contextSelection),
      );
    },
  );
  const owner = () =>
    new TelosWorkRoleSetup({
      work,
      events: f.store,
      workspaces: f.workspaces,
      authorize,
      assertBeforeApply,
      retainContext,
      resolvePreparation: f.resolvePreparation,
    });
  return {
    f,
    input,
    actor,
    owner,
    authorize,
    assertBeforeApply,
    retainContext,
    get work() {
      return work;
    },
    reopen() {
      work.close();
      work = open();
      f.reopen();
    },
  };
}

it('rejects oversized reviewed context before retaining an intent or preparing an ordinary session', async () => {
  const r = await roleFixture();
  const input = structuredClone(r.input);
  input.contextSelection.brief.text = 'Reviewed bytes '.repeat(8_000);
  input.contextSelection.brief.sha256 = createHash('sha256')
    .update(input.contextSelection.brief.text)
    .digest('hex');
  const prepare = vi.spyOn(r.work, 'prepareRoleSetup');
  const before = r.work.read('item', r.actor);
  const sessions = r.f.store.listSessions();
  await expect(r.owner().setup(r.actor, input, r.f.signal)).rejects.toThrow(/exceeds.*size/);
  expect(prepare).not.toHaveBeenCalled();
  expect(r.f.resolvePreparation).not.toHaveBeenCalled();
  expect(r.retainContext).not.toHaveBeenCalled();
  expect(r.f.store.listSessions()).toEqual(sessions);
  expect(r.work.read('item', r.actor)).toEqual(before);
});

it('recovers uncertain preparation from durable intent without allocating another session or command', async () => {
  const r = await roleFixture();
  const before = r.work.read('item', r.actor);
  r.retainContext.mockRejectedValueOnce(new Error('context retention interrupted'));
  await expect(r.owner().setup(r.actor, r.input, r.f.signal)).rejects.toThrow(
    'context retention interrupted',
  );
  const pending = r.work.prepareRoleSetup(r.input, r.actor);
  const prepared = r.f.store.getOrdinarySessionPreparation(pending.setup.allocationOperationId)!;
  expect(prepared).toBeDefined();
  expect(r.work.read('item', r.actor)).toEqual(before);
  r.reopen();
  r.f.resolvePreparation.mockClear();
  const receipt = await r.owner().setup(r.actor, r.input, r.f.signal);
  expect(r.f.resolvePreparation).not.toHaveBeenCalled();
  expect(receipt.work.assignments[0].conversation.conversationId).toBe(prepared.sessionId);
  expect(r.f.store.listSessions()).toHaveLength(2);
  expect(r.f.store.getOrdinaryInitialCommandId(prepared.sessionId)).toBeUndefined();
  expect(receipt.work.attempts).toEqual([]);
  expect(receipt.work.sources).toEqual(before.sources);
  expect(receipt.work.links.filter((link) => link.role === 'origin')).toEqual(before.links);
  expect(await r.owner().setup(r.actor, r.input, r.f.signal)).toEqual(receipt);
  await expect(
    r.owner().setup(
      r.actor,
      {
        ...r.input,
        settings: {
          ...r.input.settings,
          selection: { ...r.input.settings.selection, model: 'changed' },
        },
      },
      r.f.signal,
    ),
  ).rejects.toThrow('identity reused');
});

it('rechecks authority after context awaits and rejects late revocation without partial role binding', async () => {
  const r = await roleFixture();
  const before = r.work.read('item', r.actor);
  r.retainContext.mockImplementationOnce(async () => {
    r.authorize.mockRejectedValue(new Error('operator revoked'));
  });
  await expect(r.owner().setup(r.actor, r.input, r.f.signal)).rejects.toThrow('operator revoked');
  expect(r.work.read('item', r.actor)).toEqual(before);
  expect(r.assertBeforeApply).not.toHaveBeenCalled();
  expect(r.f.store.listSessions()).toHaveLength(2);
  await expect(
    r.owner().setup({ kind: 'conversation', id: 'source' }, r.input, r.f.signal),
  ).rejects.toThrow('Operator authority required');
});

it('checks the synchronous exact scope fence and unavailable prepared sessions before the atomic apply', async () => {
  const r = await roleFixture();
  const before = r.work.read('item', r.actor);
  r.assertBeforeApply.mockImplementationOnce(() => {
    throw new Error('scope denied');
  });
  await expect(r.owner().setup(r.actor, r.input, r.f.signal)).rejects.toThrow('scope denied');
  expect(r.work.read('item', r.actor)).toEqual(before);
  const pending = r.work.prepareRoleSetup(r.input, r.actor);
  const prepared = r.f.store.getOrdinarySessionPreparation(pending.setup.allocationOperationId)!;
  r.f.store.hideSession(prepared.sessionId);
  await expect(r.owner().setup(r.actor, r.input, r.f.signal)).rejects.toThrow(
    'registered ordinary',
  );
  expect(r.work.read('item', r.actor)).toEqual(before);
});

it('keeps additional worker and advisor links independent and rolls back competing current assignments', async () => {
  const r = await roleFixture();
  const selected = await r.owner().setup(r.actor, r.input, r.f.signal);
  const worker = r.work.execute(
    {
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'additional-worker',
      expectedRevision: selected.work.revision,
      role: 'worker',
      conversationId: 'source',
      expectedAssignmentRevision: null,
    },
    r.actor,
  );
  expect(worker.work.assignments).toEqual(selected.work.assignments);
  expect(worker.work.links).toContainEqual(
    expect.objectContaining({
      role: 'worker',
      conversation: { namespace: 'mitzo', conversationId: 'source' },
    }),
  );
  const advisor = r.work.execute(
    {
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'advisor',
      expectedRevision: worker.work.revision,
      role: 'advisor',
      conversationId: 'source',
      expectedAssignmentRevision: null,
    },
    r.actor,
  );
  expect(advisor.work.assignments).toEqual(selected.work.assignments);
  expect(() =>
    r.work.execute(
      {
        operation: 'setup_role',
        itemId: 'item',
        requestId: 'competing-lead',
        expectedRevision: advisor.work.revision,
        role: 'lead',
        conversationId: 'source',
        expectedAssignmentRevision: 0,
      },
      r.actor,
    ),
  ).toThrow('Assignment revision conflict');
  expect(r.work.read('item', r.actor)).toEqual(advisor.work);
  const replaced = r.work.execute(
    {
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'replace-lead',
      expectedRevision: advisor.work.revision,
      role: 'lead',
      conversationId: 'source',
      expectedAssignmentRevision: 1,
    },
    r.actor,
  );
  expect(replaced.work.assignments[0]).toMatchObject({
    role: 'lead',
    revision: 2,
    conversation: { namespace: 'mitzo', conversationId: 'source' },
  });
  expect(replaced.work.links).toEqual(expect.arrayContaining(advisor.work.links));
  expect(r.work.assignmentHistory('item', r.actor)).toHaveLength(2);
});

it('freezes caller and callback inputs across asynchronous preparation', async () => {
  const r = await roleFixture();
  const original = structuredClone(r.input);
  r.authorize.mockImplementationOnce(async (...args: unknown[]) => {
    const passed = args[0] as {
      setup: { input: { role: string; settings: { selection: { model: string } } } };
    };
    passed.setup.input.role = 'advisor';
    passed.setup.input.settings.selection.model = 'callback-change';
    r.input.settings.selection.model = 'caller-change';
  });
  const selected = await r.owner().setup(r.actor, original, r.f.signal);
  const retained = r.work.prepareRoleSetup(original, r.actor);
  expect(retained.setup.input).toEqual(original);
  expect(selected.work.assignments[0].role).toBe('lead');
  expect(
    r.f.store.getSession(selected.work.assignments[0].conversation.conversationId)?.selectedModel,
  ).toBe(original.settings.selection.model);
});

it('refuses revoked resolver authority before reserving an ordinary session', async () => {
  const r = await roleFixture();
  const resolved = await r.f.resolvePreparation();
  r.f.resolvePreparation.mockImplementationOnce(async () => {
    r.authorize.mockRejectedValue(new Error('revoked while resolving'));
    return resolved;
  });
  const before = r.work.read('item', r.actor);
  await expect(r.owner().setup(r.actor, r.input, r.f.signal)).rejects.toThrow(
    'revoked while resolving',
  );
  const pending = r.work.prepareRoleSetup(r.input, r.actor);
  expect(
    r.f.store.getOrdinarySessionPreparation(pending.setup.allocationOperationId),
  ).toBeUndefined();
  expect(r.f.store.listSessions()).toHaveLength(1);
  expect(r.retainContext).not.toHaveBeenCalled();
  expect(r.work.read('item', r.actor)).toEqual(before);
});

it('links an additional lead chat without replacing the explicitly current lead', async () => {
  const r = await roleFixture();
  const first = await r.owner().setup(r.actor, r.input, r.f.signal);
  const additional = r.work.execute(
    {
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'additional-lead',
      expectedRevision: first.work.revision,
      role: 'lead',
      conversationId: 'source',
      expectedAssignmentRevision: null,
    },
    r.actor,
  );
  expect(additional.work.assignments).toEqual(first.work.assignments);
  expect(additional.work.links).toEqual(expect.arrayContaining(first.work.links));
  expect(additional.work.links).toContainEqual(
    expect.objectContaining({
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId: 'source' },
    }),
  );
  expect(r.work.assignmentHistory('item', r.actor)).toHaveLength(1);
});

it('prepares an additional lead through the coordinator without implicitly selecting a current lead', async () => {
  const r = await roleFixture();
  const selected = await r
    .owner()
    .setup(r.actor, { ...r.input, expectedAssignmentRevision: null }, r.f.signal);
  expect(selected.work.assignments).toEqual([]);
  expect(selected.work.links.filter((link) => link.role === 'lead')).toHaveLength(1);
  expect(r.work.assignmentHistory('item', r.actor)).toEqual([]);
  const leadId = selected.work.links.find((link) => link.role === 'lead')!.conversation
    .conversationId;
  expect(r.f.store.getOrdinaryInitialCommandId(leadId)).toBeUndefined();
});

it('rejects reuse of a prepared lead workspace for a different worker request without rewriting its chat or role history', async () => {
  const r = await roleFixture();
  const first = await r.owner().setup(r.actor, r.input, r.f.signal);
  const leadId = first.work.assignments[0].conversation.conversationId;
  const lead = r.f.store.getSession(leadId);
  const events = r.f.store.getSessionEvents(leadId);
  const input = {
    ...r.input,
    requestId: 'different-worker',
    expectedRevision: first.work.revision,
    role: 'worker',
    expectedAssignmentRevision: null,
    contextSelection: { ...r.input.contextSelection, role: 'worker', leadConversationId: leadId },
  };
  await expect(r.owner().setup(r.actor, input, r.f.signal)).rejects.toThrow();
  r.reopen();
  await expect(r.owner().setup(r.actor, input, r.f.signal)).rejects.toThrow();
  expect(r.work.read('item', r.actor)).toEqual(first.work);
  expect(r.work.assignmentHistory('item', r.actor)).toHaveLength(1);
  expect(r.f.store.getSession(leadId)).toEqual(lead);
  expect(r.f.store.getSessionEvents(leadId)).toEqual(events);
  expect(r.f.store.listSessions()).toHaveLength(2);
  expect(r.f.store.getOrdinaryInitialCommandId(leadId)).toBeUndefined();
});

it('replaces only an explicitly selected current worker and preserves additional workers and their ordinary settings', async () => {
  const r = await roleFixture();
  r.f.store.upsertSession({
    sessionId: 'worker-a',
    conversationSource: 'mitzo',
    selectedModel: 'offline-a',
    cwd: '/offline/a',
  });
  r.f.store.upsertSession({
    sessionId: 'worker-b',
    conversationSource: 'mitzo',
    selectedModel: 'offline-b',
    cwd: '/offline/b',
  });
  const a = r.f.store.getSession('worker-a');
  const b = r.f.store.getSession('worker-b');
  const current = r.work.execute(
    {
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'worker-a-current',
      expectedRevision: r.work.read('item', r.actor).revision,
      role: 'worker',
      conversationId: 'worker-a',
      expectedAssignmentRevision: 0,
    },
    r.actor,
  );
  const additional = r.work.execute(
    {
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'worker-b-additional',
      expectedRevision: current.work.revision,
      role: 'worker',
      conversationId: 'worker-b',
      expectedAssignmentRevision: null,
    },
    r.actor,
  );
  expect(additional.work.assignments).toEqual(current.work.assignments);
  expect(() =>
    r.work.execute(
      {
        operation: 'setup_role',
        itemId: 'item',
        requestId: 'worker-b-competing',
        expectedRevision: additional.work.revision,
        role: 'worker',
        conversationId: 'worker-b',
        expectedAssignmentRevision: 0,
      },
      r.actor,
    ),
  ).toThrow('Assignment revision conflict');
  expect(r.work.read('item', r.actor)).toEqual(additional.work);
  const replaced = r.work.execute(
    {
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'worker-b-replace',
      expectedRevision: additional.work.revision,
      role: 'worker',
      conversationId: 'worker-b',
      expectedAssignmentRevision: 1,
    },
    r.actor,
  );
  expect(replaced.work.assignments).toEqual([
    expect.objectContaining({
      role: 'worker',
      revision: 2,
      conversation: { namespace: 'mitzo', conversationId: 'worker-b' },
    }),
  ]);
  expect(replaced.work.links).toEqual(additional.work.links);
  r.reopen();
  expect(r.work.read('item', r.actor)).toEqual(replaced.work);
  expect(r.f.store.getSession('worker-a')).toEqual(a);
  expect(r.f.store.getSession('worker-b')).toEqual(b);
  expect(r.work.assignmentHistory('item', r.actor)).toHaveLength(2);
});

it('selects an explicitly prepared ordinary lead atomically while preserving its source and starting zero commands', async () => {
  const f = await createJoiningFixture();
  const root = mkdtempSync(join(tmpdir(), 'telos-role-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,updated_at TEXT); INSERT INTO items VALUES('item',NULL,'Source-only item','original')",
  );
  db.close();
  const work = new TelosWorkStore(path, {
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(f.store.getSession(id)),
  });
  cleanups.push(() => work.close());
  const operator = { kind: 'operator' as const, id: 'operator' };
  const origin = {
    namespace: 'external_codex' as const,
    conversationId: 'source',
    url: 'codex://threads/source',
  };
  work.execute(
    {
      operation: 'link',
      itemId: 'item',
      requestId: 'origin',
      expectedRevision: work.read('item', operator).revision,
      role: 'origin',
      conversation: origin,
    },
    operator,
  );
  const before = work.read('item', operator);
  const allocationOperationId = randomUUID();
  const resolved = await f.resolvePreparation();
  const { receipt } = await f.workspaces.prepareOrdinarySession(
    {
      ...resolved,
      allocationOperationId,
      id: f.input.settings.repositoryWorkspaceId,
      settings: f.input.settings,
      signal: f.signal,
    },
    f.store,
  );
  const command = {
    operation: 'setup_role',
    itemId: 'item',
    requestId: 'select-lead',
    expectedRevision: before.revision,
    role: 'lead',
    conversationId: receipt.sessionId,
    expectedAssignmentRevision: 0,
  };
  // Existing schema accepts only separate link/assign writes. The missing atomic
  // role operation is the behavior under test, with all real owners already ready.
  const selected = work.execute(command, operator);
  expect(selected.work.links.filter((link) => link.role === 'origin')).toEqual(before.links);
  expect(selected.work.links).toContainEqual(
    expect.objectContaining({
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId: receipt.sessionId },
    }),
  );
  expect(selected.work.assignments).toEqual([
    expect.objectContaining({
      role: 'lead',
      revision: 1,
      conversation: { namespace: 'mitzo', conversationId: receipt.sessionId },
    }),
  ]);
  expect(work.execute(command, operator)).toEqual(selected);
  expect(f.store.getOrdinaryInitialCommandId(receipt.sessionId)).toBeUndefined();
  expect(selected.work.attempts).toEqual([]);
});

it('rejects a globally retained role request UUID from another auth actor before creating another intent or resolving ordinary preparation', async () => {
  const r = await roleFixture();
  r.input.requestId = randomUUID();
  r.retainContext.mockRejectedValueOnce(new Error('uncertain role retention'));
  await expect(r.owner().setup(r.actor, r.input, r.f.signal)).rejects.toThrow(
    'uncertain role retention',
  );
  const original = r.work.prepareRoleSetup(r.input, r.actor).setup;
  r.f.resolvePreparation.mockClear();
  await expect(
    r.owner().setup({ kind: 'operator', id: 'new-auth-session' }, r.input, r.f.signal),
  ).rejects.toThrow('another operator');
  expect(r.f.resolvePreparation).not.toHaveBeenCalled();
  expect(r.work.prepareRoleSetup(r.input, r.actor).setup).toEqual(original);
  expect(r.f.store.listSessions()).toHaveLength(2);
});
