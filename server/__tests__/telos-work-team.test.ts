import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosWorkStore, type TelosWorkActor } from '../telos-work-store.js';

const operator: TelosWorkActor = { kind: 'operator', id: 'fixture-operator' };
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-team-'));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES items(id),summary TEXT,updated_at TEXT);
    INSERT INTO items VALUES('item',NULL,'Team work','original'),('other',NULL,'Other work','original');
    CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  db.close();
  const available = new Set(['owner-a', 'owner-b', 'reviewer', 'investigator']);
  const stores: TelosWorkStore[] = [];
  const open = () => {
    const store = new TelosWorkStore(path, { ordinaryConversation: (id) => available.has(id) });
    stores.push(store);
    return store;
  };
  const store = open();
  cleanups.push(() => {
    stores.forEach((entry) => entry.close());
    rmSync(root, { recursive: true, force: true });
  });
  let sequence = 0;
  const command = (
    change: Record<string, unknown>,
    expectedRevision = store.readTeam('item', operator).revision,
  ) =>
    store.executeTeam(
      { itemId: 'item', requestId: `fixture-request-${++sequence}`, expectedRevision, ...change },
      operator,
    );
  const member = (conversationId = 'owner-a', role = 'slice_owner') => ({
    conversationId,
    displayName: conversationId,
    role,
    responsibility: 'Deliver the agreed work',
    reportsToMembershipId: null,
  });
  const link = (conversationId = 'owner-a', role = 'slice_owner') =>
    command({ operation: 'link', ...member(conversationId, role) });
  return { store, open, available, command, member, link };
}

describe('explicit canonical Telos team', () => {
  it('starts empty without inferring a roster from formal role links or assignments', () => {
    const f = fixture();
    f.store.execute(
      {
        itemId: 'item',
        requestId: 'legacy-link',
        expectedRevision: f.store.read('item', operator).revision,
        operation: 'link',
        role: 'worker',
        conversation: { namespace: 'mitzo', conversationId: 'owner-a' },
      },
      operator,
    );
    expect(f.store.readTeam('item', operator).members).toEqual([]);
  });

  it('links an existing session, retaining only explicit membership with no grant or role mutation', () => {
    const f = fixture();
    const before = f.store.read('item', operator);
    const receipt = f.link();
    expect(receipt.team.members).toEqual([
      expect.objectContaining({
        conversationId: 'owner-a',
        role: 'slice_owner',
        state: 'current',
        linkedBy: 'operator:fixture-operator',
        operationId: receipt.commandId,
        endedAt: null,
        endedBy: null,
        replacedByMembershipId: null,
      }),
    ]);
    expect(f.store.read('item', operator)).toEqual(before);
    expect(() => f.store.read('item', { kind: 'conversation', id: 'owner-a' })).toThrow(
      /authorized/,
    );
    expect(() => f.store.readTeam('item', { kind: 'conversation', id: 'owner-a' })).toThrow(
      /Operator/,
    );
  });

  it('atomically replaces an owner and retains former attribution and stale reporting targets after restart', () => {
    const f = fixture();
    const owner = f.link().team.members[0];
    f.command({
      operation: 'link',
      ...f.member('reviewer', 'reviewer'),
      reportsToMembershipId: owner.membershipId,
    });
    const replaced = f.command({
      operation: 'replace',
      membershipId: owner.membershipId,
      ...f.member('owner-b'),
    });
    const current = replaced.team.members.find((m) => m.conversationId === 'owner-b')!;
    expect(replaced.team.members.find((m) => m.membershipId === owner.membershipId)).toMatchObject({
      state: 'former',
      replacedByMembershipId: current.membershipId,
      endedBy: 'operator:fixture-operator',
      operationId: replaced.commandId,
    });
    expect(replaced.team.members.find((m) => m.role === 'reviewer')?.reportsToMembershipId).toBe(
      owner.membershipId,
    );
    expect(f.open().readTeam('item', operator)).toEqual(replaced.team);
    expect(f.store.read('item', operator).assignments).toEqual([]);
  });

  it('unlinks without erasing history and exact lost-response replay survives newer changes and unavailability', () => {
    const f = fixture();
    const original = f.link().team.members[0];
    const input = {
      itemId: 'item',
      requestId: 'unlink-exact',
      expectedRevision: f.store.readTeam('item', operator).revision,
      operation: 'unlink',
      membershipId: original.membershipId,
    };
    const receipt = f.store.executeTeam(input, operator);
    f.link('owner-b');
    f.available.delete('owner-a');
    expect(f.open().executeTeam(input, operator)).toEqual(receipt);
    expect(receipt.team.members[0]).toMatchObject({
      state: 'former',
      operationId: receipt.commandId,
    });
    expect(() => f.store.executeTeam({ ...input, membershipId: 'different' }, operator)).toThrow(
      /identity/,
    );
    expect(f.store.readTeam('item', operator).members).toHaveLength(2);
  });

  it('rejects competing changes, duplicate owners, invalid targets and unauthorized or unsupported sessions', () => {
    const f = fixture();
    const stale = f.store.readTeam('item', operator).revision;
    const owner = f.link().team.members[0];
    expect(() =>
      f.command({ operation: 'unlink', membershipId: owner.membershipId }, stale),
    ).toThrow(/revision/i);
    expect(() => f.link('owner-b')).toThrow(/replace/i);
    expect(() => f.command({ operation: 'link', ...f.member('missing', 'reviewer') })).toThrow(
      /compatible|available/i,
    );
    expect(() =>
      f.command({
        operation: 'link',
        ...f.member('reviewer', 'reviewer'),
        reportsToMembershipId: 'not-a-member',
      }),
    ).toThrow(/report/i);
    expect(() =>
      f.command({
        operation: 'replace',
        membershipId: owner.membershipId,
        ...f.member('owner-b', 'reviewer'),
      }),
    ).toThrow(/role/i);
    expect(() =>
      f.store.executeTeam(
        {
          itemId: 'item',
          requestId: 'denied',
          expectedRevision: stale,
          operation: 'link',
          ...f.member(),
        },
        { kind: 'conversation', id: 'owner-a' },
      ),
    ).toThrow(/Operator/);
    expect(f.store.readTeam('item', operator).members).toHaveLength(1);
  });

  it('rolls back membership and receipt when the final host authority fence fails', () => {
    const f = fixture();
    const before = f.store.readTeam('item', operator);
    const input = {
      itemId: 'item',
      requestId: 'fenced',
      expectedRevision: before.revision,
      operation: 'link',
      ...f.member(),
    };
    expect(() =>
      f.store.executeTeam(input, operator, () => {
        throw new Error('authority revoked');
      }),
    ).toThrow('authority revoked');
    expect(f.store.readTeam('item', operator)).toEqual(before);
    const receipt = f.store.executeTeam(input, operator);
    expect(receipt.team.members).toHaveLength(1);
    expect(
      f.store.executeTeam(input, operator, () => {
        throw new Error('new actions denied');
      }),
    ).toEqual(receipt);
  });
});
