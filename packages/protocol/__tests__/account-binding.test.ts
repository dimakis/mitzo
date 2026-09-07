import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import Database from 'better-sqlite3';

describe('durable account binding', () => {
  it('keeps a corrupt binding explicitly unavailable instead of treating it as legacy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-binding-'));
    const path = join(dir, 'events.db');
    const store = new EventStore(path);
    try {
      store.upsertSession({ sessionId: 'bad' });
      const db = new Database(path);
      db.prepare('UPDATE sessions SET account_binding=? WHERE session_id=?').run(
        '{bad-json',
        'bad',
      );
      db.close();
      expect(store.getSession('bad')?.accountBinding?.provider).toBe('unavailable');
      expect(store.listSessions()).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('survives restart and unrelated metadata updates, leaving legacy sessions unbound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-binding-'));
    const path = join(dir, 'events.db');
    const binding = {
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'anthropic-vertex',
      model: 'sonnet',
      profileRevision: 'abc',
    };
    let store = new EventStore(path);
    try {
      store.upsertSession({ sessionId: 'new', accountBinding: binding });
      store.upsertSession({ sessionId: 'new', summary: 'Renamed' });
      store.upsertSession({ sessionId: 'legacy' });
      store.close();
      store = new EventStore(path);
      expect(store.getSession('new')?.accountBinding).toEqual(binding);
      expect(store.getSession('legacy')?.accountBinding).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
