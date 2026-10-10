import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../src/event-store.js';
import { SessionOutputReferenceStore } from '../src/session-output-reference-store.js';
import type { OutputContributorBinding } from '../src/session-output-reference.js';

const stores: EventStore[] = [];
const connections: Database.Database[] = [];
const roots: string[] = [];
const account = {
  accountId: 'offline',
  accountLabel: 'Offline account',
  provider: 'openai-codex' as const,
  profileRevision: 'offline-profile',
  model: 'offline-model',
};
function open(path: string) {
  const store = new EventStore(path);
  stores.push(store);
  return store;
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'output-association-')));
  roots.push(root);
  const path = join(root, 'events.db');
  const store = open(path);
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.append('source', 'message_start', { messageId: 'draft' });
  store.append('source', 'block_start', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'block_delta', { messageId: 'draft', blockId: 'text', delta: 'Draft' });
  store.append('source', 'block_end', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'message_end', { messageId: 'draft' });
  const output = store.registerSessionOutput('source', {
    requestId: 'keep',
    title: 'Draft',
    source: store.listSessionOutputCandidates('source')[0].source,
  });
  const binding: OutputContributorBinding = {
    parentSessionId: 'source',
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: createHash('sha256')
      .update(JSON.stringify(['source', output.outputId, 1, output.source.sha256]))
      .digest('hex'),
    mode: 'ask',
    label: 'Contributor',
    additionalInstructions: 'Retained guidance',
  };
  const db = new Database(path);
  connections.push(db);
  const allocation = (sessionId = 'coordinator', key = 'add') => ({
    sessionId,
    idempotencyKey: key,
    fingerprint: 'exact-request',
    summary: 'Contributor',
    binding: account,
    config: {
      version: 2,
      revision: 1,
      state: 'draft',
      anchorSeatId: 'contributor',
      activeSeatCap: 1,
      seats: [
        {
          id: 'contributor',
          name: 'Contributor',
          role: 'coder',
          model: account.model,
          accountBinding: account,
          systemPrompt: 'Guidance',
          color: '#335577',
        },
      ],
      turnRules: { mode: 'directed', maxTurns: 64 },
      interceptMode: 'manual',
    },
    profileSelections: { contributor: { profileId: 'writer', revision: 2 } },
    outputBinding: binding,
  });
  return { root, path, store, db, output, binding, allocation };
}
afterEach(() => {
  vi.restoreAllMocks();
  stores.splice(0).forEach((store) => store.close());
  connections.splice(0).forEach((db) => db.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('output contributor persistence boundary', () => {
  it('rechecks the guarded association facade after source/digest validation and refuses allocation on denial', () => {
    const { db, store, binding, allocation } = fixture();
    const history = store.getSessionEvents('source');
    const guardedLookup = vi
      .spyOn(store, 'getOutputContributorForOutput')
      .mockImplementation(() => {
        throw Error('Guarded association lookup refused');
      });
    expect(() =>
      store.createSymposiumSession({
        ...allocation(),
        outputBinding: { ...binding, contextPackageDigest: '0'.repeat(64) },
      }),
    ).toThrow('Output contributor context revision conflict');
    expect(guardedLookup).not.toHaveBeenCalled();
    expect(() => store.createSymposiumSession(allocation())).toThrow(
      'Guarded association lookup refused',
    );
    expect(guardedLookup).toHaveBeenCalledExactlyOnceWith('source', binding.outputId);
    expect(store.getSession('coordinator')).toBeNull();
    expect(store.getSymposiumSessionAllocation('add', 'exact-request')).toBeNull();
    expect(store.getOutputContributorBindings('source')).toEqual([]);
    expect(store.getSessionEvents('source')).toEqual(history);
    expect(db.prepare('SELECT * FROM symposium_session_allocations').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM symposium_configuration_operations').all()).toEqual([]);
  });

  it('borrows the exact connection and leaves association writes in its caller transaction', () => {
    const { db, binding } = fixture();
    const outputs = new SessionOutputReferenceStore(db);
    db.exec(`CREATE TEMP TRIGGER reject_borrowed_association AFTER INSERT ON events
      WHEN NEW.type='output_contributor_created'
      BEGIN SELECT RAISE(ABORT, 'borrowed connection injection'); END;`);
    expect(() => db.transaction(() => outputs.recordContributor(binding, 'borrowed'))()).toThrow(
      'borrowed connection injection',
    );
    expect(outputs.getContributorBinding('borrowed')).toBeNull();
    db.exec('DROP TRIGGER reject_borrowed_association');
    expect(() =>
      db.transaction(() => {
        outputs.recordContributor(binding, 'borrowed');
        expect(outputs.getContributorBinding('borrowed')).toEqual({
          ...binding,
          coordinatorSessionId: 'borrowed',
        });
        throw Error('caller rollback');
      })(),
    ).toThrow('caller rollback');
    expect(outputs.getContributorBinding('borrowed')).toBeNull();
  });

  it.each(['allocation', 'association'])(
    'rolls back all domains after %s insertion fails',
    (phase) => {
      const { db, store, allocation } = fixture();
      db.exec(
        phase === 'allocation'
          ? `CREATE TRIGGER fail_allocation AFTER INSERT ON symposium_session_allocations
         BEGIN SELECT RAISE(ABORT, 'allocation injection'); END;`
          : `CREATE TRIGGER fail_association AFTER INSERT ON events
         WHEN NEW.type='output_contributor_created'
         BEGIN SELECT RAISE(ABORT, 'association injection'); END;`,
      );
      const history = store.getSessionEvents('source');
      expect(() => store.createSymposiumSession(allocation())).toThrow(`${phase} injection`);
      expect(store.getSession('coordinator')).toBeNull();
      expect(store.getSymposiumSessionAllocation('add', 'exact-request')).toBeNull();
      expect(store.getOutputContributorBindings('source')).toEqual([]);
      expect(store.getSessionEvents('source')).toEqual(history);
      expect(db.prepare('SELECT * FROM symposium_session_allocations').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM symposium_configuration_operations').all()).toEqual([]);
    },
  );

  it('keeps allocation/config before the association and exact retries leave history and receipts unchanged', () => {
    const { db, store, allocation, binding } = fixture();
    db.exec(`CREATE TABLE insertion_order (step TEXT);
      CREATE TRIGGER track_allocation AFTER INSERT ON symposium_session_allocations
      BEGIN INSERT INTO insertion_order VALUES ('allocation'); END;
      CREATE TRIGGER track_association AFTER INSERT ON events
      WHEN NEW.type='output_contributor_created'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE session_id='coordinator' AND symposium_revision=1)
          THEN RAISE(ABORT, 'config not committed first') END;
        INSERT INTO insertion_order VALUES ('association');
      END;`);
    expect(store.createSymposiumSession(allocation())).toEqual({
      sessionId: 'coordinator',
      created: true,
    });
    expect(db.prepare('SELECT step FROM insertion_order ORDER BY rowid').all()).toEqual([
      { step: 'allocation' },
      { step: 'association' },
    ]);
    const events = store.getSessionEvents('source');
    const receipts = db.prepare('SELECT * FROM symposium_session_allocations').all();
    expect(events.at(-1)?.type).toBe('output_contributor_created');
    expect(events.at(-2)?.type).toBe('session_output_registered');
    expect(store.createSymposiumSession(allocation('unused-retry-id'))).toEqual({
      sessionId: 'coordinator',
      created: false,
    });
    expect(store.getSession('unused-retry-id')).toBeNull();
    expect(store.getSessionEvents('source')).toEqual(events);
    expect(db.prepare('SELECT * FROM symposium_session_allocations').all()).toEqual(receipts);
    expect(store.getOutputContributorBinding('coordinator')).toEqual({
      ...binding,
      coordinatorSessionId: 'coordinator',
    });
    expect(() => store.createSymposiumSession({ ...allocation(), fingerprint: 'changed' })).toThrow(
      'conflict',
    );
  });

  it('checks exact uniqueness outside the newest 100 association projection', () => {
    const { store, binding, allocation } = fixture();
    store.createSymposiumSession(allocation());
    for (let n = 0; n < 100; n++)
      store.append('source', 'output_contributor_created', {
        ...binding,
        outputId: randomUUID(),
        coordinatorSessionId: `other-${n}`,
      });
    expect(store.getOutputContributorBindings('source')).toHaveLength(100);
    expect(
      store
        .getOutputContributorBindings('source')
        .some((row) => row.coordinatorSessionId === 'coordinator'),
    ).toBe(false);
    expect(
      store.getOutputContributorForOutput('source', binding.outputId)?.coordinatorSessionId,
    ).toBe('coordinator');
    expect(() => store.createSymposiumSession(allocation('duplicate', 'different-key'))).toThrow(
      'already has a contributor',
    );
    expect(store.getSession('duplicate')).toBeNull();
  });

  it('retains source/association history and profile receipts on reopen and owner backup', async () => {
    const { root, path, store, db, binding, output, allocation } = fixture();
    store.createSymposiumSession(allocation());
    const history = store.getSessionEvents('source');
    const snapshot = join(root, 'snapshot.db');
    await store.backupSnapshot(snapshot);
    store.close();
    // Existing references/association history must survive additive index initialization.
    db.exec(
      'DROP INDEX idx_output_contributor_association; DROP INDEX idx_output_contributor_coordinator',
    );
    for (const retained of [open(path), open(snapshot)]) {
      expect(retained.getSessionEvents('source')).toEqual(history);
      expect(retained.readSessionOutput('source', output.outputId)).toEqual({
        output,
        content: 'Draft',
      });
      expect(retained.getOutputContributorBinding('coordinator')).toEqual({
        ...binding,
        coordinatorSessionId: 'coordinator',
      });
      expect(retained.getSymposiumInitialProfileSelections('coordinator')).toEqual({
        contributor: { profileId: 'writer', revision: 2 },
      });
      expect(retained.createSymposiumSession(allocation('unused-retry-id'))).toEqual({
        sessionId: 'coordinator',
        created: false,
      });
    }
  });

  it('rechecks uniqueness after another database owner commits and shares the original retry receipt', () => {
    const { path, store, binding, allocation } = fixture();
    const second = open(path);
    expect(second.getOutputContributorForOutput('source', binding.outputId)).toBeNull();
    store.createSymposiumSession(allocation());
    expect(() => second.createSymposiumSession(allocation('duplicate', 'another-request'))).toThrow(
      'already has a contributor',
    );
    expect(second.getSession('duplicate')).toBeNull();
    expect(second.createSymposiumSession(allocation('retry-id'))).toEqual({
      sessionId: 'coordinator',
      created: false,
    });
    expect(store.getOutputContributorBindings('source')).toHaveLength(1);
  });
});
