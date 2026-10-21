import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelosWorkStore } from '../telos-work-store.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';

const closes: Array<() => void> = [];
afterEach(() =>
  closes
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture(variant: 'fresh' | 'upgraded' = 'fresh') {
  const canonical = createTelosCanonicalData(variant);
  closes.push(() => canonical.close());
  let work = new TelosWorkStore(canonical.dbPath, { ordinaryConversation: () => true });
  closes.push(() => work.close());
  const actor = canonical.actor;
  const add = (id: string, parent: string | null = null) => {
    canonical.db
      .prepare(
        "INSERT INTO items(id,parent_id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,'manual',?,?,?,?)",
      )
      .run(id, parent, id, canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  };
  const command = (itemId: string, input: object) =>
    work.execute(
      {
        itemId,
        requestId: randomUUID(),
        expectedRevision: work.read(itemId, actor).revision,
        ...input,
      },
      actor,
    );
  const lifecycle = (itemId: string, operation: string, extra: object = {}) =>
    work.executeLifecycle(
      {
        itemId,
        requestId: randomUUID(),
        expectedRevision: work.read(itemId, actor).revision,
        operation,
        ...extra,
      },
      actor,
    );
  return {
    canonical,
    actor,
    add,
    command,
    lifecycle,
    get work() {
      return work;
    },
    restart() {
      work.close();
      work = new TelosWorkStore(canonical.dbPath, { ordinaryConversation: () => true });
    },
  };
}

it.each(['fresh', 'upgraded'] as const)(
  'adds lifecycle without rewriting %s canonical records and preserves archive through trash/restore/restart',
  (variant) => {
    const f = fixture(variant);
    const original = f.work.readRecord('studio', f.actor);
    const revision = f.work.read('studio', f.actor).revision;
    expect(f.work.readLifecycle('studio', f.actor).effectiveDisposition).toBe('active');
    f.lifecycle('studio', 'archive');
    expect(f.work.read('studio', f.actor).revision).not.toBe(revision);
    expect(f.work.readRecord('studio', f.actor)).toEqual(original);
    f.lifecycle('studio', 'trash');
    f.restart();
    expect(f.work.readLifecycle('studio', f.actor).effectiveDisposition).toBe('trashed');
    f.lifecycle('studio', 'restore');
    expect(f.work.readLifecycle('studio', f.actor).disposition).toBe('archived');
    f.lifecycle('studio', 'unarchive');
    expect(f.work.readRecord('studio', f.actor)).toEqual(original);
    expect(f.work.readLifecycle('studio', f.actor).history.map((h) => h.operation)).toEqual([
      'archive',
      'trash',
      'restore',
      'unarchive',
    ]);
  },
);

it('inherits root visibility and fences new actions without detaching children or destroying current evidence', () => {
  const f = fixture();
  f.add('child', 'studio');
  f.add('grandchild', 'child');
  f.add('unrelated');
  const old = f.work.read('grandchild', f.actor).revision;
  f.lifecycle('studio', 'archive');
  expect(f.work.readLifecycle('grandchild', f.actor)).toMatchObject({
    disposition: 'active',
    effectiveDisposition: 'archived',
    inheritedFrom: 'studio',
  });
  expect(f.work.read('grandchild', f.actor).revision).not.toBe(old);
  expect(() => f.work.assertControlAction('grandchild', 'new_worker_dispatch')).toThrow(
    /archived/i,
  );
  expect(() => f.work.assertControlAction('unrelated', 'new_worker_dispatch')).not.toThrow();
  expect(() => f.command('child', { operation: 'reparent', parentId: null })).toThrow(/archived/i);
  expect(f.work.read('child', f.actor).parentId).toBe('studio');
  f.lifecycle('studio', 'trash');
  expect(
    f.work
      .listLifecycle('trash', f.actor)
      .map((v) => v.itemId)
      .sort(),
  ).toEqual(['child', 'grandchild', 'studio']);
  expect(f.work.listLifecycle('active', f.actor).map((v) => v.itemId)).toContain('unrelated');
  f.lifecycle('studio', 'restore');
  f.lifecycle('studio', 'unarchive');
  expect(f.work.readLifecycle('child', f.actor).effectiveDisposition).toBe('active');
});

it('records operator pause as requested, blocks dispatch, accepts only genuine recipient evidence and resumes only its controls', () => {
  const f = fixture();
  f.add('outcome');
  f.command('outcome', { operation: 'classify', kind: 'outcome' });
  f.command('outcome', {
    operation: 'link',
    role: 'lead',
    conversation: { namespace: 'mitzo', conversationId: 'lead' },
  });
  f.command('outcome', {
    operation: 'assign',
    role: 'lead',
    conversationId: 'lead',
    expectedAssignmentRevision: 0,
  });
  const paused = f.lifecycle('outcome', 'pause').lifecycle!;
  expect(paused.pause.stage).toBe('requested');
  expect(paused.pause.controls).toHaveLength(3);
  expect(
    paused.pause.controls.every(
      (c) =>
        c.coordinatorConversationId === null &&
        c.priorityItemId === null &&
        c.origin === 'operator_pause',
    ),
  ).toBe(true);
  expect(() => f.work.assertControlAction('outcome', 'new_worker_dispatch')).toThrow(/hold/i);
  const safe = paused.pause.controls.find((c) => c.scope === 'safe_point')!;
  expect(() =>
    f.work.acknowledgeControl(
      { requestId: 'fake', controlId: safe.controlId, itemId: 'outcome', assignmentRevision: 1 },
      f.actor,
    ),
  ).toThrow(/recipient/i);
  f.work.acknowledgeControl(
    { requestId: 'real', controlId: safe.controlId, itemId: 'outcome', assignmentRevision: 1 },
    { kind: 'conversation', id: 'lead' },
  );
  expect(f.work.readControl(safe.controlId, f.actor).stage).toBe('acknowledged');
  f.restart();
  expect(f.work.readLifecycle('outcome', f.actor).pause.stage).not.toBe('applied');
  expect(() => f.work.enforceControlAction('outcome', 'safe_point', 'lead')).toThrow(/hold/i);
  expect(f.work.readControl(safe.controlId, f.actor).stage).toBe('applied');
  expect(f.work.readLifecycle('outcome', f.actor).pause.stage).toBe('requested');
});

it('keeps standalone outcomes pausable without any manufactured lead and retains original receipt on retry', () => {
  const f = fixture();
  f.add('alone');
  const input = {
    requestId: 'once',
    itemId: 'alone',
    expectedRevision: f.work.read('alone', f.actor).revision,
    operation: 'pause',
  };
  const first = f.work.executeLifecycle(input, f.actor);
  f.restart();
  expect(f.work.executeLifecycle(input, f.actor)).toEqual(first);
  expect(() => f.work.executeLifecycle({ ...input, operation: 'trash' }, f.actor)).toThrow(
    /identity/i,
  );
  expect(() =>
    f.work.executeLifecycle({ ...input, requestId: 'stale', operation: 'trash' }, f.actor),
  ).toThrow(/revision/i);
  f.lifecycle('alone', 'resume');
  expect(f.work.readLifecycle('alone', f.actor).pause.stage).toBe('running');
  expect(() => f.work.assertControlAction('alone', 'new_worker_dispatch')).not.toThrow();
  expect(() => f.work.assertControlAction('alone', 'publication')).toThrow(/revalidat/i);
});

it('requires operator authority, strict inputs and legal transitions; restoring never clears a pause', () => {
  const f = fixture();
  const input = {
    itemId: 'studio',
    requestId: 'unauthorized',
    expectedRevision: f.work.read('studio', f.actor).revision,
    operation: 'trash',
  };
  expect(() => f.work.executeLifecycle(input, { kind: 'conversation', id: 'planning' })).toThrow(
    /operator/i,
  );
  expect(() => f.work.executeLifecycle({ ...input, actorId: f.actor.id }, f.actor)).toThrow();
  expect(() => f.lifecycle('studio', 'restore')).toThrow(/trashed/i);
  f.lifecycle('studio', 'pause');
  f.lifecycle('studio', 'trash');
  expect(() => f.lifecycle('studio', 'resume')).toThrow(/trashed/i);
  f.lifecycle('studio', 'restore');
  expect(f.work.readLifecycle('studio', f.actor).pause.stage).toBe('requested');
});

it('permanently deletes only an explicitly confirmed unreferenced trashed leaf under a genuine host quiescence fence', () => {
  const f = fixture();
  f.add('empty');
  f.lifecycle('empty', 'trash');
  const input = {
    itemId: 'empty',
    requestId: 'purge',
    expectedRevision: f.work.read('empty', f.actor).revision,
    operation: 'delete_permanently',
    confirmation: { itemId: 'empty', phrase: 'DELETE PERMANENTLY' },
  };
  expect(() =>
    f.work.executeLifecycle({ ...input, confirmation: undefined }, f.actor, () => {}),
  ).toThrow();
  expect(() => f.work.executeLifecycle(input, f.actor)).toThrow(/quiescence/i);
  const busy = vi.fn(() => {
    throw new Error('active worker');
  });
  expect(() => f.work.executeLifecycle(input, f.actor, busy)).toThrow(/active worker/);
  expect(f.work.readLifecycle('empty', f.actor).disposition).toBe('trashed');
  const verify = vi.fn(() => {});
  const receipt = f.work.executeLifecycle(input, f.actor, verify);
  expect(verify).toHaveBeenCalledWith('empty');
  expect(receipt.lifecycle).toBeNull();
  expect(f.canonical.db.prepare('SELECT id FROM items WHERE id=?').get('empty')).toBeUndefined();
  f.restart();
  expect(
    f.work.executeLifecycle(input, f.actor, () => {
      throw new Error('must not repeat');
    }),
  ).toEqual(receipt);
});

it('refuses destructive cascades and retained source/artifact/session/history references', () => {
  const f = fixture();
  f.add('child', 'studio');
  f.lifecycle('studio', 'trash');
  expect(() =>
    f.lifecycle('studio', 'delete_permanently', {
      confirmation: { itemId: 'studio', phrase: 'DELETE PERMANENTLY' },
    }),
  ).toThrow(/child|reference/i);
  expect(f.work.read('child', f.actor).parentId).toBe('studio');
  f.add('referenced');
  f.command('referenced', { operation: 'classify', kind: 'outcome' });
  f.lifecycle('referenced', 'trash');
  const input = {
    itemId: 'referenced',
    requestId: 'permanent',
    expectedRevision: f.work.read('referenced', f.actor).revision,
    operation: 'delete_permanently',
    confirmation: { itemId: 'referenced', phrase: 'DELETE PERMANENTLY' },
  };
  expect(() => f.work.executeLifecycle(input, f.actor, () => {})).toThrow(/reference/i);
});

it('protects hidden hierarchy and deleted identities against writes by another canonical owner', () => {
  const f = fixture();
  f.add('child', 'studio');
  f.lifecycle('studio', 'trash');
  expect(() =>
    f.canonical.db.prepare('UPDATE items SET parent_id=NULL WHERE id=?').run('child'),
  ).toThrow(/lifecycle/i);
  expect(() => f.add('new-child', 'studio')).toThrow(/lifecycle/i);
  expect(() => f.canonical.db.prepare('DELETE FROM items WHERE id=?').run('studio')).toThrow(
    /lifecycle/i,
  );
  f.add('empty');
  f.lifecycle('empty', 'trash');
  f.work.executeLifecycle(
    {
      requestId: 'delete',
      itemId: 'empty',
      expectedRevision: f.work.read('empty', f.actor).revision,
      operation: 'delete_permanently',
      confirmation: { itemId: 'empty', phrase: 'DELETE PERMANENTLY' },
    },
    f.actor,
    () => {},
  );
  expect(() => f.add('empty')).toThrow(/identity/i);
});

it('resume preserves independent coordinator holds and priority work', () => {
  const f = fixture();
  f.add('coordinator');
  f.add('outcome', 'coordinator');
  f.add('priority', 'coordinator');
  for (const [itemId, kind] of [
    ['coordinator', 'coordinator'],
    ['outcome', 'outcome'],
    ['priority', 'outcome'],
  ])
    f.command(itemId, { operation: 'classify', kind });
  f.command('coordinator', {
    operation: 'link',
    role: 'lead',
    conversation: { namespace: 'mitzo', conversationId: 'coordinator-chat' },
  });
  f.command('coordinator', {
    operation: 'assign',
    role: 'lead',
    conversationId: 'coordinator-chat',
    expectedAssignmentRevision: 0,
  });
  const independent = f.work.requestControl(
    {
      requestId: 'independent',
      coordinatorItemId: 'coordinator',
      priorityItemId: 'priority',
      targetItemIds: ['outcome'],
      scope: 'new_worker_dispatch',
    },
    f.actor,
  );
  f.lifecycle('outcome', 'pause');
  f.lifecycle('outcome', 'resume');
  expect(f.work.readControl(independent.controlId, f.actor).stage).toBe('requested');
  expect(() => f.work.assertControlAction('outcome', 'new_worker_dispatch')).toThrow(/hold/i);
  expect(() => f.work.assertControlAction('priority', 'new_worker_dispatch')).not.toThrow();
});

it('rejects stale recipients after replacement during pause without rewriting historical ACKs', () => {
  const f = fixture();
  f.add('outcome');
  f.command('outcome', { operation: 'classify', kind: 'outcome' });
  const assign = (id: string, revision: number) => {
    f.command('outcome', {
      operation: 'link',
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId: id },
    });
    f.command('outcome', {
      operation: 'assign',
      role: 'lead',
      conversationId: id,
      expectedAssignmentRevision: revision,
    });
  };
  assign('old-lead', 0);
  const control = f.lifecycle('outcome', 'pause').lifecycle!.pause.controls[0];
  f.work.acknowledgeControl(
    { requestId: 'ack', controlId: control.controlId, itemId: 'outcome', assignmentRevision: 1 },
    { kind: 'conversation', id: 'old-lead' },
  );
  assign('new-lead', 1);
  expect(f.work.readControl(control.controlId, f.actor).targets[0]).toMatchObject({
    leadConversationId: 'new-lead',
    stage: 'requested',
    assignmentRevision: 2,
  });
  expect(() =>
    f.work.acknowledgeControl(
      {
        requestId: 'stale',
        controlId: control.controlId,
        itemId: 'outcome',
        assignmentRevision: 1,
      },
      { kind: 'conversation', id: 'old-lead' },
    ),
  ).toThrow(/recipient/i);
  expect(f.work.readControl(control.controlId, f.actor).history[0].conversationId).toBe('old-lead');
});

it('observes another database owner and rejects a command admitted before ancestor trash', () => {
  const f = fixture();
  f.add('child', 'studio');
  const before = f.work.read('child', f.actor).revision;
  const other = new TelosWorkStore(f.canonical.dbPath, { ordinaryConversation: () => true });
  closes.push(() => other.close());
  other.executeLifecycle(
    {
      itemId: 'studio',
      requestId: 'other-owner',
      expectedRevision: other.read('studio', f.actor).revision,
      operation: 'trash',
    },
    f.actor,
  );
  expect(() =>
    f.work.execute(
      {
        itemId: 'child',
        requestId: 'before',
        expectedRevision: before,
        operation: 'classify',
        kind: 'outcome',
      },
      f.actor,
    ),
  ).toThrow(/revision/i);
  expect(() => f.work.assertControlAction('child', 'safe_point')).toThrow(/trashed/i);
  expect(f.work.read('child', f.actor).kind).toBeNull();
});

it('refuses unknown extension references and asynchronous quiescence claims before destructive writes', () => {
  const f = fixture();
  f.add('empty');
  f.lifecycle('empty', 'trash');
  const input = {
    itemId: 'empty',
    requestId: 'purge',
    expectedRevision: f.work.read('empty', f.actor).revision,
    operation: 'delete_permanently',
    confirmation: { itemId: 'empty', phrase: 'DELETE PERMANENTLY' },
  };
  expect(() => f.work.executeLifecycle(input, f.actor, async () => {})).toThrow(/synchronous/i);
  f.canonical.db.exec('CREATE TABLE future_refs(id TEXT PRIMARY KEY,resource TEXT NOT NULL)');
  f.canonical.db
    .prepare('INSERT INTO future_refs VALUES(?,?)')
    .run('reference', 'telos://items/empty');
  expect(() => f.work.executeLifecycle(input, f.actor, () => {})).toThrow(/reference/i);
  expect(f.work.readLifecycle('empty', f.actor).disposition).toBe('trashed');
});
