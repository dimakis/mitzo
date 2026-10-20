import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelosWorkCommandReceiptSchema, TelosWorkViewSchema } from '@mitzo/protocol';
import { TelosWorkStore } from '../telos-work-store.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture(role: 'lead' | 'worker' = 'lead') {
  const canonical = createTelosCanonicalData();
  cleanup.push(() => canonical.close());
  for (const id of ['original', 'additional', 'replacement', 'foreign'])
    canonical.events.upsertSession({ sessionId: id, conversationSource: 'mitzo', summary: id });
  const work = new TelosWorkStore(canonical.dbPath, {
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(canonical.events.getSession(id)),
  });
  cleanup.push(() => work.close());
  const actor = canonical.actor;
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
  command('studio', { operation: 'classify', kind: 'outcome' });
  let itemId = 'studio';
  if (role === 'worker') {
    canonical.db
      .prepare(
        "INSERT INTO items(id,parent_id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES('slice','studio','Slice','manual',?,?,?,?)",
      )
      .run(canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
    command('slice', { operation: 'classify', kind: 'work_item' });
    itemId = 'slice';
  }
  for (const id of ['original', 'additional', 'replacement'])
    command(itemId, {
      operation: 'link',
      role,
      conversation: { namespace: 'mitzo', conversationId: id },
    });
  const assign = (conversationId: string) =>
    command(itemId, {
      operation: 'assign',
      role,
      conversationId,
      expectedAssignmentRevision:
        work.read(itemId, actor).assignments.find((a) => a.role === role)?.revision ?? 0,
    });
  return {
    ...canonical,
    work,
    command,
    itemId,
    role,
    assign,
    read: () => work.read(itemId, actor),
  };
}

it.each(['lead', 'worker'] as const)(
  'projects proven %s assignment identities independently of additional links, link dates and current authority',
  (role) => {
    const f = fixture(role);
    expect(f.read().assignmentHistory?.[role]).toEqual({ complete: true, conversationIds: [] });
    f.assign('original');
    f.assign('replacement');
    const view = f.read();
    expect(view.assignmentHistory?.[role]).toEqual({
      complete: true,
      conversationIds: ['original', 'replacement'],
    });
    expect(view.assignments).toMatchObject([
      { role, revision: 2, conversation: { conversationId: 'replacement' } },
    ]);
    expect(view.links.map((link) => link.conversation.conversationId)).toEqual([
      'original',
      'additional',
      'replacement',
    ]);
    expect(view.assignmentHistory?.[role]?.conversationIds).not.toContain('additional');
    expect(
      f.work.read(f.itemId, { kind: 'conversation', id: 'original' }).assignmentHistory,
    ).toEqual(view.assignmentHistory);
    expect(() => f.work.read(f.itemId, { kind: 'conversation', id: 'foreign' })).toThrow(
      /authoriz/i,
    );
  },
);

it('marks an incomplete legacy assignment stream unknown without changing revision tokens or making a link current', () => {
  const f = fixture();
  f.assign('original');
  f.assign('replacement');
  const before = f.read();
  f.db
    .prepare(
      "DELETE FROM telos_work_assignment_history WHERE item_id=? AND json_extract(data,'$.revision')=1",
    )
    .run(f.itemId);
  const view = f.read();
  expect(view.revision).toBe(before.revision);
  expect(view.assignments).toEqual(before.assignments);
  expect(view.links).toEqual(before.links);
  expect(view.assignmentHistory?.lead).toEqual({
    complete: false,
    conversationIds: ['replacement'],
  });
});

it('deduplicates a repeatedly assigned conversation while keeping lead and worker history separate', () => {
  const f = fixture();
  f.assign('original');
  f.assign('original');
  f.command(f.itemId, {
    operation: 'link',
    role: 'worker',
    conversation: { namespace: 'mitzo', conversationId: 'additional' },
  });
  f.command(f.itemId, {
    operation: 'assign',
    role: 'worker',
    conversationId: 'additional',
    expectedAssignmentRevision: 0,
  });
  expect(f.read().assignmentHistory).toEqual({
    lead: { complete: true, conversationIds: ['original'] },
    worker: { complete: true, conversationIds: ['additional'] },
  });
  expect(f.read().assignments).toMatchObject([
    { role: 'lead', revision: 2, conversation: { conversationId: 'original' } },
    { role: 'worker', revision: 1, conversation: { conversationId: 'additional' } },
  ]);
});

it.each(['malformed', 'contradictory', 'unlinked'] as const)(
  'keeps %s legacy history explicit without disclosing new conversation identities',
  (damage) => {
    const f = fixture();
    f.assign('original');
    const view = f.read();
    const prior = f.work.assignmentHistory(f.itemId, f.actor)[0];
    f.db.prepare('INSERT INTO telos_work_assignment_history(item_id,data) VALUES(?,?)').run(
      f.itemId,
      damage === 'malformed'
        ? '{'
        : JSON.stringify({
            ...prior,
            conversation: {
              namespace: 'mitzo',
              conversationId: damage === 'unlinked' ? 'private-unlinked' : 'additional',
            },
          }),
    );
    const after = f.read();
    expect(after.assignmentHistory?.lead?.complete).toBe(false);
    expect(after.assignmentHistory?.lead?.conversationIds).not.toContain('private-unlinked');
    expect(after.assignments).toEqual(view.assignments);
    expect(after.revision).toBe(view.revision);
  },
);

it.each(['first', 'last'] as const)(
  'withholds linked history contradicted by an unlinked record appearing %s, without disclosing that private ID',
  (order) => {
    const f = fixture();
    f.assign('original');
    f.assign('replacement');
    const before = f.read();
    const recorded = f.work.assignmentHistory(f.itemId, f.actor);
    const contradictory = {
      ...recorded[0],
      conversation: { namespace: 'mitzo', conversationId: 'private-unlinked' },
    };
    const rows = order === 'first' ? [contradictory, ...recorded] : [...recorded, contradictory];
    f.db.transaction(() => {
      f.db.prepare('DELETE FROM telos_work_assignment_history WHERE item_id=?').run(f.itemId);
      for (const row of rows)
        f.db
          .prepare('INSERT INTO telos_work_assignment_history(item_id,data) VALUES(?,?)')
          .run(f.itemId, JSON.stringify(row));
    })();
    const view = f.read();
    expect(view.assignmentHistory?.lead).toEqual({
      complete: false,
      conversationIds: ['replacement'],
    });
    expect(view.assignmentHistory?.lead?.conversationIds).not.toContain('original');
    expect(view.assignmentHistory?.lead?.conversationIds).not.toContain('private-unlinked');
    expect(view.assignments).toEqual(before.assignments);
    expect(view.links).toEqual(before.links);
    expect(view.revision).toBe(before.revision);
  },
);

it('accepts and replays old receipts without projecting or rewriting their missing history field', () => {
  const f = fixture();
  const input = {
    operation: 'assign',
    itemId: f.itemId,
    requestId: 'old-assignment',
    expectedRevision: f.read().revision,
    role: 'lead',
    conversationId: 'original',
    expectedAssignmentRevision: 0,
  };
  const current = f.work.execute(input, f.actor);
  const old = structuredClone(current);
  delete old.work.assignmentHistory;
  expect(TelosWorkViewSchema.parse(old.work)).toEqual(old.work);
  expect(TelosWorkCommandReceiptSchema.parse(old)).toEqual(old);
  f.db
    .prepare('UPDATE telos_work_commands SET receipt=? WHERE request_id=?')
    .run(JSON.stringify(old), input.requestId);
  f.assign('replacement');
  expect(f.work.execute(input, f.actor)).toEqual(old);
  expect(f.read().assignments).toMatchObject([
    { role: 'lead', revision: 2, conversation: { conversationId: 'replacement' } },
  ]);
  expect(f.read().assignmentHistory?.lead).toEqual({
    complete: true,
    conversationIds: ['original', 'replacement'],
  });
});
