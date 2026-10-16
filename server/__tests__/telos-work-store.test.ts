import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosWorkStore, type TelosWorkActor } from '../telos-work-store.js';
import { EventStore } from '../event-store.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import { SessionService, childInputHash } from '../session-service.js';
import { TaskStore } from '../task-store.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { captureMitzoTelosCore } from '../backup/mitzo-telos.js';
import { createTelosWorkFixtures } from './fixtures/telos-work-fixtures.js';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
const operator: TelosWorkActor = { kind: 'operator', id: 'operator-session' };
const conversation = (conversationId: string) => ({ namespace: 'mitzo' as const, conversationId });
const external = {
  namespace: 'external_codex' as const,
  conversationId: 'original-codex',
  url: 'codex://threads/original-codex',
};
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-work-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES items(id), summary TEXT, updated_at TEXT);
    CREATE TABLE links(id TEXT PRIMARY KEY, item_id TEXT REFERENCES items(id), type TEXT, url TEXT, title TEXT, description TEXT, created_at TEXT);
    INSERT INTO items VALUES('overall',NULL,'Overall','original'),('outcome','overall','Outcome','original'),('slice','outcome','Slice','original'),('other',NULL,'Unrelated','original');`);
  const events = new EventStore(join(root, 'events.db'));
  for (const [i, sessionId] of ['lead', 'worker-a', 'worker-b', 'reviewer'].entries()) {
    events.upsertSession({
      sessionId,
      conversationSource: 'mitzo',
      summary: sessionId,
      selectedModel: `offline-model-${i}`,
      reasoningEffort: 'high',
      cwd: join(root, sessionId),
      telosTaskId: 'legacy-id',
      goalId: 'accounting-goal',
    });
  }
  const policy = {
    ordinaryConversation: (id: string) => isAvailableTelosWorkConversation(events.getSession(id)),
  };
  const stores: TelosWorkStore[] = [];
  const open = () => {
    const store = new TelosWorkStore(path, policy);
    stores.push(store);
    return store;
  };
  const store = open();
  cleanups.push(() => {
    for (const s of stores) s.close();
    events.close();
    db.close();
  });
  let sequence = 0;
  const command = (itemId: string, change: Record<string, unknown>, actor = operator) =>
    store.execute(
      {
        itemId,
        requestId: `command-${++sequence}`,
        expectedRevision: store.read(itemId, operator).revision,
        ...change,
      },
      actor,
    );
  const link = (itemId: string, role: string, id: string) =>
    command(itemId, { operation: 'link', role, conversation: conversation(id) });
  return { root, path, db, events, store, open, command, link };
}

describe('durable Telos work relationships (offline, existing SQLite owners)', () => {
  it('keeps multiple chats and ordinary bindings independent from current assignment and external origins', () => {
    const f = fixture();
    const before = ['worker-a', 'worker-b', 'reviewer'].map((id) => f.events.getSession(id));
    f.command('slice', { operation: 'link', role: 'origin', conversation: external });
    f.command('other', { operation: 'link', role: 'origin', conversation: external });
    f.link('slice', 'worker', 'worker-a');
    f.link('slice', 'worker', 'worker-b');
    f.link('slice', 'reviewer', 'reviewer');
    expect(f.store.read('slice', operator).assignments).toEqual([]);
    f.command('slice', {
      operation: 'assign',
      role: 'worker',
      conversationId: 'worker-a',
      expectedAssignmentRevision: 0,
    });
    f.command('slice', {
      operation: 'assign',
      role: 'worker',
      conversationId: 'worker-b',
      expectedAssignmentRevision: 1,
    });
    const view = f.store.read('slice', operator);
    expect(view.links).toHaveLength(4);
    expect(view.assignments).toMatchObject([
      { role: 'worker', conversation: conversation('worker-b'), revision: 2 },
    ]);
    expect(f.store.forConversation(conversation('worker-a'), operator)).toMatchObject([
      { itemId: 'slice', role: 'worker' },
    ]);
    expect(f.store.forConversation(external, operator)).toHaveLength(2);
    expect(['worker-a', 'worker-b', 'reviewer'].map((id) => f.events.getSession(id))).toEqual(
      before,
    );
  });

  it('rejects competing assignment and stale work writes without losing the winner or history', () => {
    const f = fixture();
    f.link('slice', 'worker', 'worker-a');
    f.link('slice', 'worker', 'worker-b');
    const input = {
      operation: 'assign',
      itemId: 'slice',
      requestId: 'winner',
      expectedRevision: f.store.read('slice', operator).revision,
      role: 'worker',
      conversationId: 'worker-a',
      expectedAssignmentRevision: 0,
    };
    const winner = f.store.execute(input, operator);
    const competitor = f.open();
    expect(() =>
      competitor.execute({ ...input, requestId: 'loser', conversationId: 'worker-b' }, operator),
    ).toThrow(/conflict/i);
    expect(() =>
      f.command('slice', {
        operation: 'assign',
        role: 'worker',
        conversationId: 'worker-b',
        expectedAssignmentRevision: 0,
      }),
    ).toThrow(/conflict/i);
    expect(f.store.read('slice', operator)).toEqual(winner.work);
    expect(f.store.assignmentHistory('slice', operator)).toHaveLength(1);
  });

  it('replays an immutable command receipt after restart and rejects reusing its identity', () => {
    const f = fixture();
    const input = {
      operation: 'link',
      itemId: 'slice',
      requestId: 'link-once',
      expectedRevision: f.store.read('slice', operator).revision,
      role: 'worker',
      conversation: conversation('worker-a'),
    };
    const receipt = f.store.execute(input, operator);
    f.link('slice', 'reviewer', 'reviewer');
    const restarted = f.open();
    expect(restarted.execute(input, operator)).toEqual(receipt);
    expect(() =>
      restarted.execute({ ...input, conversation: conversation('worker-b') }, operator),
    ).toThrow(/identity/i);
    expect(restarted.read('slice', operator).links).toHaveLength(2);
  });

  it('keeps canonical parent_id authoritative and rejects cycles, missing parents and leaf parenting atomically', () => {
    const f = fixture();
    expect(f.store.read('outcome', operator).kind).toBeNull();
    f.command('overall', { operation: 'classify', kind: 'coordinator' });
    f.command('outcome', { operation: 'classify', kind: 'outcome' });
    f.command('slice', { operation: 'classify', kind: 'work_item' });
    for (const [itemId, parentId] of [
      ['overall', 'slice'],
      ['outcome', 'missing'],
      ['other', 'slice'],
    ]) {
      const before = f.store.read(itemId, operator);
      expect(() => f.command(itemId, { operation: 'reparent', parentId })).toThrow();
      expect(f.store.read(itemId, operator)).toEqual(before);
    }
    // The canonical owner's writes are covered too; no second composition tree.
    expect(() =>
      f.db.prepare("UPDATE items SET parent_id='slice' WHERE id='overall'").run(),
    ).toThrow(/cycle|parent/i);
    f.command('slice', { operation: 'reparent', parentId: 'other' });
    expect(f.db.prepare("SELECT parent_id FROM items WHERE id='slice'").get()).toEqual({
      parent_id: 'other',
    });
    expect(f.store.read('slice', operator).parentId).toBe('other');
  });

  it('retains exact adopted source snapshots and unknown legacy provenance through later changes', () => {
    const f = fixture();
    const source = createTelosWorkFixtures().homeStudio.snapshots[0];
    const snapshot = { ...source, itemId: 'slice', snapshotId: 'snapshot' };
    f.command('slice', { operation: 'source', snapshot });
    const legacy = {
      ...snapshot,
      itemId: 'other',
      snapshotId: 'unknown',
      source: null,
      selection: { kind: 'unknown' },
      adoptedBrief: null,
      artifacts: [],
      author: null,
      sourceCreatedAt: null,
      adoptedAt: null,
    };
    f.command('other', { operation: 'source', snapshot: legacy });
    expect(() =>
      f.command('slice', { operation: 'source', snapshot: { ...snapshot, author: 'rewritten' } }),
    ).toThrow(/immutable/i);
    expect(f.store.read('slice', operator).sources).toEqual([snapshot]);
    expect(f.store.read('other', operator).sources).toEqual([legacy]);
  });

  it('rejects unauthorized roles, non-conversations and implicit assignment without partial mutation', () => {
    const f = fixture();
    const before = f.store.read('slice', operator);
    expect(() =>
      f.command('slice', { operation: 'link', role: 'worker', conversation: external }),
    ).toThrow();
    expect(() => f.link('slice', 'worker', 'provider-continuation-only')).toThrow(/ordinary/i);
    expect(() =>
      f.command('slice', {
        operation: 'assign',
        role: 'lead',
        conversationId: 'lead',
        expectedAssignmentRevision: 0,
      }),
    ).toThrow(/link/i);
    const actor: TelosWorkActor = { kind: 'conversation', id: 'worker-a' };
    expect(() => f.store.read('slice', actor)).toThrow(/authorized/i);
    expect(() => f.command('slice', { operation: 'reparent', parentId: null }, actor)).toThrow(
      /authorized/i,
    );
    expect(f.store.read('slice', operator)).toEqual(before);
    f.link('slice', 'worker', 'worker-a');
    expect(f.store.read('slice', actor).links).toHaveLength(1);
    // A valid chat does not acquire operator authority through linking.
    expect(() => f.command('slice', { operation: 'classify', kind: 'coordinator' }, actor)).toThrow(
      /authorized/i,
    );
  });

  it('treats the real hideSession deletion path as unavailable while retaining role and assignment evidence', () => {
    const f = fixture();
    f.link('slice', 'worker', 'worker-a');
    f.command('slice', {
      operation: 'assign',
      role: 'worker',
      conversationId: 'worker-a',
      expectedAssignmentRevision: 0,
    });
    f.link('outcome', 'lead', 'lead');
    f.command('outcome', {
      operation: 'assign',
      role: 'lead',
      conversationId: 'lead',
      expectedAssignmentRevision: 0,
    });
    f.command('slice', {
      operation: 'source',
      snapshot: {
        ...createTelosWorkFixtures().homeStudio.snapshots[0],
        itemId: 'slice',
        snapshotId: 'context',
      },
    });
    f.events.hideSession('worker-a');
    f.events.hideSession('lead');
    expect(f.events.getSession('worker-a')?.isHidden).toBe(true);
    expect(f.store.forConversation(conversation('worker-a'), operator)).toMatchObject([
      { availability: 'unavailable' },
    ]);
    expect(f.store.read('slice', operator).links).toMatchObject([
      { conversation: conversation('worker-a'), availability: 'unavailable' },
    ]);
    expect(f.store.read('outcome', operator).links).toMatchObject([
      { conversation: conversation('lead'), availability: 'unavailable' },
    ]);
    expect(() => f.link('other', 'worker', 'worker-a')).toThrow(/ordinary/i);
    expect(() =>
      f.command('slice', {
        operation: 'assign',
        role: 'worker',
        conversationId: 'worker-a',
        expectedAssignmentRevision: 1,
      }),
    ).toThrow(/ordinary/i);
    expect(() => f.store.read('slice', { kind: 'conversation', id: 'worker-a' })).toThrow(
      /authorized/i,
    );
    const config = createTelosWorkFixtures().multipleChats.conversations[0];
    expect(() =>
      f.command('slice', {
        operation: 'request_attempt',
        attemptId: 'hidden-lead',
        predecessorAttemptId: null,
        leadConversationId: 'lead',
        contextSnapshotId: 'context',
        configuration: { binding: config.binding, selection: config.selection },
      }),
    ).toThrow(/lead/i);
    expect(f.store.read('slice', operator).assignments).toMatchObject([
      { conversation: conversation('worker-a'), revision: 1 },
    ]);
    expect(f.store.assignmentHistory('slice', operator)).toHaveLength(1);
    expect(f.store.read('slice', operator).attempts).toEqual([]);
  });

  it('refreshes backlink availability after the ordinary conversation policy changes', () => {
    const f = fixture();
    f.link('slice', 'worker', 'worker-a');
    expect(f.store.forConversation(conversation('worker-a'), operator)).toMatchObject([
      { availability: 'available' },
    ]);
    const metadata = new Database(join(f.root, 'events.db'));
    try {
      metadata.prepare("DELETE FROM sessions WHERE session_id='worker-a'").run();
    } finally {
      metadata.close();
    }
    const current = f.store.read('slice', operator).links;
    expect(current).toMatchObject([{ availability: 'unavailable' }]);
    expect(f.store.forConversation(conversation('worker-a'), operator)).toEqual(current);
  });

  it('retains unavailable conversation attribution instead of deleting role and assignment history', () => {
    const f = fixture();
    f.link('slice', 'worker', 'worker-a');
    f.command('slice', {
      operation: 'assign',
      role: 'worker',
      conversationId: 'worker-a',
      expectedAssignmentRevision: 0,
    });
    const metadata = new Database(join(f.root, 'events.db'));
    try {
      metadata.prepare("DELETE FROM sessions WHERE session_id='worker-a'").run();
    } finally {
      metadata.close();
    }
    expect(f.open().read('slice', operator).links).toMatchObject([
      { conversation: conversation('worker-a'), availability: 'unavailable' },
    ]);
    expect(f.store.read('slice', operator).assignments).toHaveLength(1);
    expect(f.store.assignmentHistory('slice', operator)).toHaveLength(1);
  });

  it('persists one allocation intent before cross-store work and recovers the same attempt/session after restart', () => {
    const f = fixture();
    f.link('outcome', 'lead', 'lead');
    f.command('outcome', {
      operation: 'assign',
      role: 'lead',
      conversationId: 'lead',
      expectedAssignmentRevision: 0,
    });
    const source = {
      ...createTelosWorkFixtures().homeStudio.snapshots[0],
      itemId: 'slice',
      snapshotId: 'context',
    };
    f.command('slice', { operation: 'source', snapshot: source });
    const config = createTelosWorkFixtures().multipleChats.conversations[0];
    const input = {
      itemId: 'slice',
      requestId: 'start-once',
      expectedRevision: f.store.read('slice', operator).revision,
      operation: 'request_attempt',
      attemptId: 'attempt-1',
      predecessorAttemptId: null,
      leadConversationId: 'lead',
      contextSnapshotId: 'context',
      configuration: { binding: config.binding, selection: config.selection },
    };
    const receipt = f.store.execute(input, operator);
    expect(f.store.pendingAllocations(operator)).toMatchObject([
      { attemptId: 'attempt-1', state: 'requested', allocationKey: 'attempt-1' },
    ]);
    const restarted = f.open();
    expect(restarted.execute(input, operator)).toEqual(receipt);
    expect(restarted.pendingAllocations(operator)).toHaveLength(1);
    // Host allocation receipt is supplied by the ordinary allocator, never by public API input.
    expect(() =>
      restarted.recordAllocation(
        'attempt-1',
        { workerConversationId: 'worker-a', allocationReceiptId: 'forged' },
        () => false,
      ),
    ).toThrow(/receipt/i);
    restarted.recordAllocation(
      'attempt-1',
      { workerConversationId: 'worker-a', allocationReceiptId: 'ordinary-allocation' },
      () => true,
    );
    expect(f.store.pendingAllocations(operator)).toEqual([]);
    expect(f.store.read('slice', operator).attempts).toMatchObject([
      { attemptId: 'attempt-1', state: 'chat_ready', workerConversationId: 'worker-a' },
    ]);
    expect(f.store.read('slice', operator).links).toMatchObject([
      { role: 'worker', conversation: conversation('worker-a'), attemptId: 'attempt-1' },
    ]);
    expect(f.store.read('slice', operator).assignments).toEqual([]);
    expect(f.store.read('slice', operator).attempts[0].executionTaskId).toBeNull();
    expect(() =>
      f.store.recordAllocation(
        'attempt-1',
        { workerConversationId: 'worker-b', allocationReceiptId: 'different' },
        () => true,
      ),
    ).toThrow(/conflict/i);
  });

  it('recovers the existing SessionService allocation after a crash between the two stores, without starting a turn', () => {
    const f = fixture();
    f.link('outcome', 'lead', 'lead');
    f.command('outcome', {
      operation: 'assign',
      role: 'lead',
      conversationId: 'lead',
      expectedAssignmentRevision: 0,
    });
    f.command('slice', {
      operation: 'source',
      snapshot: {
        ...createTelosWorkFixtures().homeStudio.snapshots[0],
        itemId: 'slice',
        snapshotId: 'context',
      },
    });
    const config = createTelosWorkFixtures().multipleChats.conversations[0];
    f.command('slice', {
      operation: 'request_attempt',
      attemptId: 'allocated-before-crash',
      predecessorAttemptId: null,
      leadConversationId: 'lead',
      contextSnapshotId: 'context',
      configuration: { binding: config.binding, selection: config.selection },
    });
    const intent = f.store.pendingAllocations(operator)[0];
    expect(intent.attempt).toMatchObject({
      childItemId: 'slice',
      leadConversationId: 'lead',
      contextSnapshotId: 'context',
    });
    const accountBinding = {
      accountId: config.binding.account.accountId,
      accountLabel: 'Offline fixture',
      provider: 'openai-codex' as const,
      model: config.selection.model,
      profileRevision: config.binding.account.profileRevision,
    };
    const authority = {
      parentConversationId: 'lead',
      parentActive: true,
      grantId: 'host-grant',
      grantRevision: 1,
      accountBinding,
      reasoningEffort: config.selection.thinking,
      taskRootId: 'execution-root',
      taskNodeId: 'execution-child',
      planRevision: 'pinned-plan',
      allowedFiles: ['src/**'],
      allowedCapabilities: ['read'],
      maxChildren: 2,
      maxConcurrent: 2,
      maxDepth: 2,
      maxSpawnsPerMinute: 2,
    };
    let starts = 0;
    const runtime = {
      inspect: async () => 'absent' as const,
      start: async () => {
        starts++;
        throw Error('No model execution authorized');
      },
      stop: async () => 'confirmed' as const,
    };
    const service = new SessionService(join(f.root, 'events.db'), runtime, async () => authority);
    cleanups.push(() => service.close());
    service.recordHostGrant(authority, 'operator-session');
    const request = {
      parentConversationId: 'lead',
      idempotencyKey: intent.allocationKey,
      prompt: 'Exact synthetic reviewed slice context',
      taskRootId: 'execution-root',
      taskNodeId: 'execution-child',
      planRevision: 'pinned-plan',
      grantId: 'host-grant',
      grantRevision: 1,
      accountBinding,
      reasoningEffort: config.selection.thinking,
      scope: { files: ['src/**'], capabilities: ['read'] },
      isolation: 'independent' as const,
    };
    const allocationInput = { ...request, inputHash: childInputHash(request) };
    const allocated = service.createChild(allocationInput, authority);
    // Simulate a lost response before Telos linking. Replay the ordinary owner key.
    const restarted = f.open();
    const recovered = service.createChild(allocationInput, authority);
    expect(recovered).toEqual(allocated);
    restarted.recordAllocation(
      intent.attemptId,
      { workerConversationId: recovered.conversationId, allocationReceiptId: recovered.inputHash },
      (evidence) => {
        const child = service.getChild(evidence.workerConversationId);
        return (
          !!child &&
          child.parentConversationId === 'lead' &&
          child.idempotencyKey === evidence.allocationKey &&
          child.inputHash === evidence.allocationReceiptId
        );
      },
    );
    expect(f.store.read('slice', operator).attempts).toMatchObject([
      { state: 'chat_ready', workerConversationId: allocated.conversationId },
    ]);
    expect(f.events.getSession(allocated.conversationId)?.accountBinding).toEqual(accountBinding);
    expect(starts).toBe(0);
    f.command('slice', {
      operation: 'request_attempt',
      attemptId: 'explicit-retry',
      predecessorAttemptId: intent.attemptId,
      leadConversationId: 'lead',
      contextSnapshotId: 'context',
      configuration: { binding: config.binding, selection: config.selection },
    });
    expect(f.store.read('slice', operator).attempts).toHaveLength(2);
    expect(f.store.pendingAllocations(operator)).toMatchObject([
      { attemptId: 'explicit-retry', allocationKey: 'explicit-retry' },
    ]);
  });

  it('rejects linking the lead as its own delegated worker even if the allocation adapter accepts it', () => {
    const f = fixture();
    f.link('outcome', 'lead', 'lead');
    f.command('outcome', {
      operation: 'assign',
      role: 'lead',
      conversationId: 'lead',
      expectedAssignmentRevision: 0,
    });
    f.command('slice', {
      operation: 'source',
      snapshot: {
        ...createTelosWorkFixtures().homeStudio.snapshots[0],
        itemId: 'slice',
        snapshotId: 'context',
      },
    });
    const config = createTelosWorkFixtures().multipleChats.conversations[0];
    f.command('slice', {
      operation: 'request_attempt',
      attemptId: 'attempt-1',
      predecessorAttemptId: null,
      leadConversationId: 'lead',
      contextSnapshotId: 'context',
      configuration: { binding: config.binding, selection: config.selection },
    });
    const before = f.store.read('slice', operator);
    expect(() =>
      f.store.recordAllocation(
        'attempt-1',
        { workerConversationId: 'lead', allocationReceiptId: 'wrong-worker' },
        () => true,
      ),
    ).toThrow(/lead/i);
    expect(f.store.read('slice', operator)).toEqual(before);
    expect(f.store.pendingAllocations(operator)).toHaveLength(1);
  });

  it('restores relationship history, source bytes and pending command receipts through the existing backup group', async () => {
    const f = fixture();
    f.command('slice', { operation: 'link', role: 'origin', conversation: external });
    f.link('slice', 'worker', 'worker-a');
    f.command('slice', {
      operation: 'assign',
      role: 'worker',
      conversationId: 'worker-a',
      expectedAssignmentRevision: 0,
    });
    const tasks = new TaskStore(join(f.root, 'tasks.db'));
    const artifacts = new TelosArtifactStore(f.path);
    cleanups.push(() => {
      tasks.close();
      artifacts.close();
    });
    const artifact = artifacts.save({
      itemId: 'slice',
      filename: 'brief.md',
      title: 'Exact source brief',
      bytes: Buffer.from('APPROVED-SYNTHETIC-BRIEF'),
      sessionId: 'worker-a',
      requestId: 'source-byte-pin',
    });
    const snapshot = {
      ...createTelosWorkFixtures().homeStudio.snapshots[0],
      itemId: 'slice',
      snapshotId: 'backup-source',
      artifacts: [
        { artifactId: artifact.id, revision: artifact.revision, sha256: artifact.sha256 },
      ],
    };
    f.command('slice', { operation: 'source', snapshot });
    f.link('outcome', 'lead', 'lead');
    f.command('outcome', {
      operation: 'assign',
      role: 'lead',
      conversationId: 'lead',
      expectedAssignmentRevision: 0,
    });
    const config = createTelosWorkFixtures().multipleChats.conversations[0];
    const command = {
      operation: 'request_attempt',
      itemId: 'slice',
      requestId: 'pending-before-backup',
      expectedRevision: f.store.read('slice', operator).revision,
      attemptId: 'pending',
      predecessorAttemptId: null,
      leadConversationId: 'lead',
      contextSnapshotId: 'backup-source',
      configuration: { binding: config.binding, selection: config.selection },
    };
    const receipt = f.store.execute(command, operator);
    const before = f.store.read('slice', operator);
    const destination = join(f.root, 'backup');
    await captureMitzoTelosCore({
      owners: { events: f.events, tasks, telos: artifacts },
      destination,
    });
    const restoredEvents = new EventStore(join(destination, 'mitzo-events', 'store.db'));
    const restoredArtifacts = new TelosArtifactStore(join(destination, 'telos', 'store.db'));
    const restored = new TelosWorkStore(join(destination, 'telos', 'store.db'), {
      ordinaryConversation: (id) => !!restoredEvents.getSession(id),
    });
    try {
      expect(restored.read('slice', operator)).toEqual(before);
      expect(restored.assignmentHistory('slice', operator)).toHaveLength(1);
      expect(restored.forConversation(external, operator)).toHaveLength(1);
      expect(restored.execute(command, operator)).toEqual(receipt);
      expect(restored.pendingAllocations(operator)).toMatchObject([
        { attemptId: 'pending', allocationKey: 'pending' },
      ]);
      expect(restoredArtifacts.read(artifact.id, artifact.revision).bytes.toString()).toBe(
        'APPROVED-SYNTHETIC-BRIEF',
      );
      expect(restoredEvents.getSession('worker-a')).toEqual(f.events.getSession('worker-a'));
    } finally {
      restored.close();
      restoredArtifacts.close();
      restoredEvents.close();
    }
  });
});
