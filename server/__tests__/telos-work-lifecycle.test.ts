import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelosWorkStore } from '../telos-work-store.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosWorkControlViewSchema } from '@mitzo/protocol';

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

it.each(['archive', 'trash'] as const)(
  'retains descendants without lifecycle rows beneath a root after %s when another canonical writer attempts a cascading DELETE',
  (operation) => {
    const f = fixture();
    f.add('child', 'studio');
    f.add('grandchild', 'child');
    f.add('unrelated');
    f.lifecycle('studio', operation);
    expect(
      f.canonical.db
        .prepare("SELECT item_id FROM telos_work_lifecycle WHERE item_id IN ('child','grandchild')")
        .all(),
    ).toEqual([]);
    const before = f.canonical.db.prepare('SELECT * FROM items ORDER BY id').all();
    const history = f.canonical.db.prepare('SELECT * FROM history ORDER BY id').all();
    expect(() => f.canonical.db.prepare("DELETE FROM items WHERE id='grandchild'").run()).toThrow(
      /lifecycle/i,
    );
    expect(() => f.canonical.db.prepare("DELETE FROM items WHERE id='child'").run()).toThrow(
      /lifecycle/i,
    );
    expect(f.canonical.db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(before);
    expect(f.canonical.db.prepare('SELECT * FROM history ORDER BY id').all()).toEqual(history);
    expect(f.work.read('grandchild', f.actor).parentId).toBe('child');
    expect(f.canonical.db.prepare("DELETE FROM items WHERE id='unrelated'").run().changes).toBe(1);
    f.lifecycle('studio', operation === 'archive' ? 'unarchive' : 'restore');
    expect(f.canonical.db.prepare("DELETE FROM items WHERE id='child'").run().changes).toBe(1);
    expect(
      f.canonical.db.prepare("SELECT id FROM items WHERE id IN ('child','grandchild')").all(),
    ).toEqual([]);
  },
);

it('upgrades the already-enrolled own-row-only delete trigger before another canonical writer can erase inherited descendants', () => {
  const f = fixture();
  f.add('child', 'studio');
  f.add('grandchild', 'child');
  f.lifecycle('studio', 'trash');
  f.canonical.db.exec(`DROP TRIGGER telos_work_lifecycle_delete_guard;
    CREATE TRIGGER telos_work_lifecycle_delete_guard BEFORE DELETE ON items WHEN EXISTS(SELECT 1 FROM telos_work_lifecycle WHERE item_id=OLD.id AND purging=0) BEGIN SELECT RAISE(ABORT,'Use confirmed Telos lifecycle deletion'); END;`);
  f.restart();
  expect(() => f.canonical.db.prepare("DELETE FROM items WHERE id='child'").run()).toThrow(
    /lifecycle/i,
  );
  expect(
    f.canonical.db
      .prepare("SELECT id,parent_id FROM items WHERE id IN ('child','grandchild') ORDER BY id")
      .all(),
  ).toEqual([
    { id: 'child', parent_id: 'studio' },
    { id: 'grandchild', parent_id: 'child' },
  ]);
});

it.each(['{}', '{"disposition":null}'])(
  'retains raw descendants and unknown ancestor lifecycle data %s instead of authorizing a cascade',
  (raw) => {
    const f = fixture();
    f.add('child', 'studio');
    f.add('grandchild', 'child');
    f.canonical.db
      .prepare('INSERT INTO telos_work_lifecycle(item_id,data) VALUES(?,?)')
      .run('studio', raw);
    const items = f.canonical.db.prepare('SELECT * FROM items ORDER BY id').all();
    const history = f.canonical.db.prepare('SELECT * FROM history ORDER BY id').all();
    expect(() => f.canonical.db.prepare("DELETE FROM items WHERE id='child'").run()).toThrow(
      /lifecycle/i,
    );
    expect(() => f.canonical.db.prepare("DELETE FROM items WHERE id='grandchild'").run()).toThrow(
      /lifecycle/i,
    );
    expect(f.canonical.db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(items);
    expect(f.canonical.db.prepare('SELECT * FROM history ORDER BY id').all()).toEqual(history);
    expect(
      f.canonical.db.prepare("SELECT data FROM telos_work_lifecycle WHERE item_id='studio'").get(),
    ).toEqual({ data: raw });
  },
);

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

it('requires explicit operator-pause origin for null coordinator/priority identities', () => {
  const f = fixture();
  const pause = f.lifecycle('studio', 'pause').lifecycle!.pause.controls[0];
  expect(TelosWorkControlViewSchema.safeParse(pause).success).toBe(true);
  expect(TelosWorkControlViewSchema.safeParse({ ...pause, origin: undefined }).success).toBe(false);
  expect(
    TelosWorkControlViewSchema.safeParse({
      ...pause,
      coordinatorConversationId: 'manufactured-lead',
    }).success,
  ).toBe(false);
  expect(
    TelosWorkControlViewSchema.safeParse({ ...pause, priorityItemId: 'manufactured-priority' })
      .success,
  ).toBe(false);
});

it.each([
  ['extension_json', 'reference JSON', '{"outcome":"empty"}'],
  ['extension_untyped', 'reference', 'telos://items/empty'],
  ['telos_work_lifecycle_extension', 'reference TEXT', 'telos://items/empty'],
  [
    'extension_generated',
    "payload TEXT, reference TEXT GENERATED ALWAYS AS ('em' || 'pty') STORED",
    'retained payload',
  ],
])(
  'refuses unknown references in %s before quiescence or deletion and retains raw extension data',
  (table, columns, value) => {
    const f = fixture();
    f.add('empty');
    f.lifecycle('empty', 'trash');
    f.canonical.db.exec(`CREATE TABLE ${table}(${columns})`);
    const inputColumn = table === 'extension_generated' ? 'payload' : 'reference';
    f.canonical.db.prepare(`INSERT INTO ${table}(${inputColumn}) VALUES(?)`).run(value);
    const before = f.canonical.db.prepare(`SELECT * FROM ${table}`).all();
    const quiescence = vi.fn(() => {});
    expect(() =>
      f.work.executeLifecycle(
        {
          itemId: 'empty',
          requestId: 'purge-extension',
          expectedRevision: f.work.read('empty', f.actor).revision,
          operation: 'delete_permanently',
          confirmation: { itemId: 'empty', phrase: 'DELETE PERMANENTLY' },
        },
        f.actor,
        quiescence,
      ),
    ).toThrow(/reference/i);
    expect(quiescence).not.toHaveBeenCalled();
    expect(f.canonical.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
    expect(f.work.readLifecycle('empty', f.actor).disposition).toBe('trashed');
  },
);

it.each([
  ['quoted ID value', 'item"quoted', '{"reference":"item\\"quoted"}'],
  ['backslash ID value', 'item\\path', '{"reference":"item\\\\path"}'],
  ['quoted ID key', 'item"quoted', '{"item\\"quoted":true}'],
  ['backslash ID key', 'item\\path', '{"item\\\\path":true}'],
  ['Unicode value', 'empty', '{"reference":"\\u0065\\u006d\\u0070\\u0074\\u0079"}'],
  ['Unicode key', 'empty', '{"\\u0065\\u006d\\u0070\\u0074\\u0079":true}'],
  ['root string', 'item"quoted', '"item\\"quoted"'],
  ['nested array', 'empty', '[{"nested":["prefix-\\u0065\\u006d\\u0070\\u0074\\u0079-suffix"]}]'],
])(
  'retains decoded JSON references for %s before host quiescence without rewriting raw evidence',
  (_label, itemId, raw) => {
    const f = fixture();
    f.add(itemId);
    f.lifecycle(itemId, 'trash');
    // An actual pending-role journal has JSON custody without an item_id column.
    f.canonical.db
      .prepare(
        'INSERT INTO telos_work_role_setups(actor_id,request_id,fingerprint,intent) VALUES(?,?,?,?)',
      )
      .run('operator:retained', 'pending-reference', 'retained-fingerprint', raw);
    expect(raw.includes(itemId)).toBe(false);
    const verify = vi.fn(() => {});
    expect(() =>
      f.work.executeLifecycle(
        {
          requestId: 'permanent',
          itemId,
          operation: 'delete_permanently',
          expectedRevision: f.work.read(itemId, f.actor).revision,
          confirmation: { itemId, phrase: 'DELETE PERMANENTLY' },
        },
        f.actor,
        verify,
      ),
    ).toThrow(/reference/i);
    expect(verify).not.toHaveBeenCalled();
    expect(
      f.canonical.db
        .prepare('SELECT intent FROM telos_work_role_setups WHERE request_id=?')
        .get('pending-reference'),
    ).toEqual({ intent: raw });
    expect(f.work.readLifecycle(itemId, f.actor).disposition).toBe('trashed');
  },
);

it('retains a Unicode-escaped JSON reference in another canonical item without rewriting either item', () => {
  const f = fixture();
  f.add('empty');
  f.lifecycle('empty', 'trash');
  const raw = '{"task_hint":"\\u0065\\u006d\\u0070\\u0074\\u0079"}';
  f.canonical.db.prepare("UPDATE items SET context_hints=? WHERE id='studio'").run(raw);
  const verify = vi.fn(() => {});
  expect(() =>
    f.work.executeLifecycle(
      {
        requestId: 'permanent',
        itemId: 'empty',
        operation: 'delete_permanently',
        expectedRevision: f.work.read('empty', f.actor).revision,
        confirmation: { itemId: 'empty', phrase: 'DELETE PERMANENTLY' },
      },
      f.actor,
      verify,
    ),
  ).toThrow(/reference/i);
  expect(verify).not.toHaveBeenCalled();
  expect(f.canonical.db.prepare("SELECT context_hints FROM items WHERE id='studio'").get()).toEqual(
    { context_hints: raw },
  );
  expect(f.work.readLifecycle('empty', f.actor).disposition).toBe('trashed');
});

it('allows only the original confirmed unreferenced leaf when unrelated JSON has no decoded reference', () => {
  const f = fixture();
  f.add('empty');
  f.lifecycle('empty', 'trash');
  f.canonical.db.exec('CREATE TABLE unrelated_refs(payload JSON)');
  const raw = '{"other":["different",true,null,{"unrelated":"kept"}]}';
  f.canonical.db.prepare('INSERT INTO unrelated_refs VALUES(?)').run(raw);
  const verify = vi.fn(() => {});
  const input = {
    requestId: 'permanent',
    itemId: 'empty',
    operation: 'delete_permanently',
    expectedRevision: f.work.read('empty', f.actor).revision,
    confirmation: { itemId: 'empty', phrase: 'DELETE PERMANENTLY' },
  };
  const receipt = f.work.executeLifecycle(input, f.actor, verify);
  expect(receipt.lifecycle).toBeNull();
  expect(verify).toHaveBeenCalledExactlyOnceWith('empty');
  expect(f.canonical.db.prepare('SELECT payload FROM unrelated_refs').get()).toEqual({
    payload: raw,
  });
  expect(
    f.work.executeLifecycle(input, f.actor, () => {
      throw new Error('must not repeat');
    }),
  ).toEqual(receipt);
});

function deletionInput(f: ReturnType<typeof fixture>, itemId = 'empty') {
  return {
    requestId: `delete-${itemId}`,
    itemId,
    operation: 'delete_permanently',
    expectedRevision: f.work.read(itemId, f.actor).revision,
    confirmation: { itemId, phrase: 'DELETE PERMANENTLY' },
  };
}

it('permits only the original writable owner during its exact synchronous deletion frame, never before, after or on replay', () => {
  const f = fixture();
  f.add('empty');
  f.lifecycle('empty', 'trash');
  const input = deletionInput(f);
  const check = f.work.assertLifecycleDeletionWriter.bind(f.work, 'empty', f.canonical.dbPath);
  expect(check).toThrow(/deletion.*frame/i);
  const verify = vi.fn(() => {
    expect(check).not.toThrow();
  });
  const receipt = f.work.executeLifecycle(input, f.actor, verify);
  expect(verify).toHaveBeenCalledExactlyOnceWith('empty');
  expect(check).toThrow(/deletion.*frame/i);
  expect(
    f.work.executeLifecycle(input, f.actor, () => {
      throw new Error('must not replay callback');
    }),
  ).toEqual(receipt);
  expect(check).toThrow(/deletion.*frame/i);
});

it('rejects another writable/read-only/closed owner and path/item mismatches inside the original callback', () => {
  const f = fixture();
  f.add('empty');
  f.lifecycle('empty', 'trash');
  const other = new TelosWorkStore(f.canonical.dbPath, { ordinaryConversation: () => true });
  const readonly = TelosWorkStore.openReadOnly(f.canonical.dbPath, {
    ordinaryConversation: () => true,
  });
  const closed = new TelosWorkStore(f.canonical.dbPath, { ordinaryConversation: () => true });
  closed.close();
  closes.push(
    () => other.close(),
    () => readonly.close(),
  );
  f.work.executeLifecycle(deletionInput(f), f.actor, () => {
    for (const owner of [other, readonly, closed])
      expect(() => owner.assertLifecycleDeletionWriter('empty', f.canonical.dbPath)).toThrow(
        /deletion.*frame/i,
      );
    expect(() => f.work.assertLifecycleDeletionWriter('different', f.canonical.dbPath)).toThrow(
      /deletion.*frame/i,
    );
    expect(() =>
      f.work.assertLifecycleDeletionWriter('empty', `${f.canonical.dbPath}.different`),
    ).toThrow(/deletion.*frame/i);
    expect(() => f.work.assertLifecycleDeletionWriter('empty', 'telos.db')).toThrow(
      /deletion.*frame/i,
    );
    expect(() => f.work.assertLifecycleDeletionWriter('empty', f.canonical.dbPath)).not.toThrow();
  });
});

it('rejects deletion from a pre-existing immediate transaction without running the host check', () => {
  const f = fixture();
  f.add('empty');
  f.lifecycle('empty', 'trash');
  f.add('other');
  const input = deletionInput(f);
  const verify = vi.fn(() => {});
  f.work.execute(
    {
      itemId: 'other',
      requestId: 'outer',
      expectedRevision: f.work.read('other', f.actor).revision,
      operation: 'classify',
      kind: 'outcome',
    },
    f.actor,
    () => {
      expect(() => f.work.executeLifecycle(input, f.actor, verify)).toThrow(/deletion.*frame/i);
    },
  );
  expect(verify).not.toHaveBeenCalled();
  expect(f.work.readLifecycle('empty', f.actor).disposition).toBe('trashed');
});

it('rejects deletion from a deferred read transaction instead of treating inTransaction as a writer proof', () => {
  const f = fixture();
  f.add('empty');
  f.lifecycle('empty', 'trash');
  f.command('studio', {
    operation: 'link',
    role: 'advisor',
    conversation: { namespace: 'mitzo', conversationId: 'planning' },
  });
  const input = deletionInput(f);
  const verify = vi.fn(() => {});
  let attempted = false;
  const reader = new TelosWorkStore(f.canonical.dbPath, {
    ordinaryConversation: () => {
      if (!attempted) {
        attempted = true;
        expect(() => reader.executeLifecycle(input, f.actor, verify)).toThrow(/deletion.*frame/i);
      }
      return true;
    },
  });
  closes.push(() => reader.close());
  reader.read('studio', f.actor);
  expect(attempted).toBe(true);
  expect(verify).not.toHaveBeenCalled();
  expect(f.work.readLifecycle('empty', f.actor).disposition).toBe('trashed');
});

it.each(['throw', 'nonvoid', 'promise', 'rejecting-promise'] as const)(
  'expires the original deletion frame on %s and preserves the item',
  async (mode) => {
    const f = fixture();
    f.add('empty');
    f.lifecycle('empty', 'trash');
    const check = () => f.work.assertLifecycleDeletionWriter('empty', f.canonical.dbPath);
    let continuation: Promise<void> | undefined;
    expect(() =>
      f.work.executeLifecycle(deletionInput(f), f.actor, () => {
        check();
        if (mode === 'throw') throw new Error('host refusal');
        if (mode === 'nonvoid') return true;
        if (mode === 'rejecting-promise') {
          continuation = Promise.reject(new Error('private rejected callback'));
          return continuation;
        }
        continuation = Promise.resolve().then(() => {
          expect(check).toThrow(/deletion.*frame/i);
        });
        return continuation;
      }),
    ).toThrow(mode === 'throw' ? /host refusal/ : /synchronous/i);
    if (mode === 'rejecting-promise')
      await expect(continuation).rejects.toThrow(/private rejected/);
    else await continuation;
    expect(check).toThrow(/deletion.*frame/i);
    expect(f.work.readLifecycle('empty', f.actor).disposition).toBe('trashed');
  },
);

it('refuses a reentrant deletion callback and does not let a caught nested attempt retain the outer frame', () => {
  const f = fixture();
  for (const id of ['empty', 'nested']) {
    f.add(id);
    f.lifecycle(id, 'trash');
  }
  const outer = deletionInput(f);
  const nested = deletionInput(f, 'nested');
  const verify = vi.fn(() => {});
  expect(() =>
    f.work.executeLifecycle(outer, f.actor, () => {
      f.work.assertLifecycleDeletionWriter('empty', f.canonical.dbPath);
      expect(() => f.work.executeLifecycle(nested, f.actor, verify)).toThrow(/deletion.*frame/i);
    }),
  ).toThrow(/deletion.*frame/i);
  expect(verify).not.toHaveBeenCalled();
  for (const id of ['empty', 'nested'])
    expect(f.work.readLifecycle(id, f.actor).disposition).toBe('trashed');
});

it('preserves nested ordinary lifecycle operations outside a deletion callback', () => {
  const f = fixture();
  f.add('empty');
  f.add('other');
  const archive = {
    requestId: 'nested-archive',
    itemId: 'empty',
    operation: 'archive',
    expectedRevision: f.work.read('empty', f.actor).revision,
  };
  f.work.execute(
    {
      itemId: 'other',
      requestId: 'outer',
      operation: 'classify',
      kind: 'outcome',
      expectedRevision: f.work.read('other', f.actor).revision,
    },
    f.actor,
    () => {
      expect(f.work.executeLifecycle(archive, f.actor).lifecycle?.disposition).toBe('archived');
    },
  );
  expect(f.work.readLifecycle('empty', f.actor).disposition).toBe('archived');
  expect(() => f.work.assertLifecycleDeletionWriter('empty', f.canonical.dbPath)).toThrow(
    /deletion.*frame/i,
  );
});
