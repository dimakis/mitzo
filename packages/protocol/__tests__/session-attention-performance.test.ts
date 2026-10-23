import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';

function internal(store: EventStore) {
  return store as unknown as {
    db: Database.Database;
    stmts: { getAttentionSessions: Database.Statement };
  };
}
const digestRows = (db: Database.Database) =>
  createHash('sha256')
    .update(JSON.stringify(db.prepare('SELECT * FROM sessions ORDER BY session_id').all()))
    .digest('hex');

it.each(['fresh', 'upgraded'] as const)(
  'uses an ordered attention index without sorting wide session payloads on a %s database',
  (schema) => {
    const directory = mkdtempSync(join(tmpdir(), 'mitzo-attention-index-'));
    const path = join(directory, 'events.db');
    let store = new EventStore(path);
    try {
      const { db, stmts } = internal(store);
      const insert = db.prepare(`INSERT INTO sessions
        (session_id, conversation_source, initial_prompt, is_active, is_hidden, last_speaker, last_speaker_at, prompt_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const widePrompt = 'synthetic retained context '.repeat(1024);
      db.transaction(() => {
        for (let i = 0; i < 512; i++)
          insert.run(`noise-${i}`, 'mitzo', widePrompt, 0, 0, 'user', i, 1);
        for (let i = 0; i < 16; i++)
          insert.run(`visible-${i}`, 'mitzo', widePrompt, 0, 0, 'assistant', 10000 + i, 1);
        insert.run('hidden', 'mitzo', widePrompt, 0, 1, 'assistant', 50000, 1);
        insert.run('unregistered', 'legacy', '', 0, 0, 'assistant', 49999, 0);
        insert.run('legacy-accepted', 'legacy', '', 0, 0, 'assistant', 40000, 1);
        insert.run('imported', 'external_import', '', 0, 0, 'assistant', 30000, 0);
      })();
      store.registerInternalSdkExecution({
        sdkSessionId: 'private-sdk',
        parentSessionId: 'visible-0',
        operationId: 'synthetic-op',
        purpose: 'web_search',
        cwd: '/synthetic/project',
      });
      insert.run('private-sdk', 'mitzo', widePrompt, 1, 0, 'assistant', 60000, 1);
      const expected = [
        'legacy-accepted',
        'imported',
        ...Array.from({ length: 8 }, (_, i) => `visible-${15 - i}`),
      ];
      const query = stmts.getAttentionSessions.source;
      expect(store.getAttentionSessions().map((session) => session.sessionId)).toEqual(expected);
      if (schema === 'upgraded') {
        // Stabilize the existing legacy-enrollment migration before modelling
        // an otherwise current database that lacks only the new index.
        store.close();
        store = new EventStore(path);
        const upgradeDb = internal(store).db;
        upgradeDb.exec('DROP INDEX IF EXISTS idx_sessions_attention');
        const before = digestRows(upgradeDb);
        const oracle = store.getAttentionSessions();
        store.close();
        store = new EventStore(path);
        expect(digestRows(internal(store).db)).toBe(before);
        expect(store.getAttentionSessions()).toEqual(oracle);
      }
      const plan = (
        internal(store).db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]
      ).map((row) => row.detail);
      expect(plan.some((detail) => detail.includes('USING INDEX idx_sessions_attention'))).toBe(
        true,
      );
      expect(plan.some((detail) => detail.includes('TEMP B-TREE'))).toBe(false);
      // Visibility, speaker and registration checks remain live, before LIMIT.
      store.hideSession('legacy-accepted');
      store.updateLastSpeaker('imported', 'user');
      expect(store.getAttentionSessions().map((session) => session.sessionId)).toEqual(
        Array.from({ length: 10 }, (_, i) => `visible-${15 - i}`),
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
