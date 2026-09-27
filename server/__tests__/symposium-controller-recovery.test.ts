import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
it('replacement controller recovery leaves typed and historical mixed Symposium rows untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-recovery-')),
    path = join(root, 'events.db');
  const store = new EventStore(path),
    raw = new Database(path);
  try {
    for (const id of ['ordinary', 'native', 'mixed']) {
      store.upsertSession({ sessionId: id });
      raw
        .prepare(
          "UPDATE sessions SET state='ACTIVE',execution_id=?,execution_generation=1,execution_phase='RUNNING' WHERE session_id=?",
        )
        .run(`e-${id}`, id);
      store.insertSendCommand(`send-${id}`, id, { prompt: 'test' });
    }
    raw.prepare("UPDATE sessions SET session_type='symposium' WHERE session_id='native'").run();
    raw
      .prepare(
        "UPDATE sessions SET symposium_config='malformed legacy config' WHERE session_id='mixed'",
      )
      .run();
    const before = raw
      .prepare("SELECT * FROM sessions WHERE session_id IN ('native','mixed') ORDER BY session_id")
      .all();
    expect(store.recoverStaleSessions({ excludeSymposium: true })).toBe(1);
    expect(store.recoverOrphanedExecutions({ excludeSymposium: true })).toBe(1);
    store.recoverPendingSendCommands({ excludeSymposium: true });
    expect(
      raw
        .prepare(
          "SELECT * FROM sessions WHERE session_id IN ('native','mixed') ORDER BY session_id",
        )
        .all(),
    ).toEqual(before);
    for (const id of ['native', 'mixed'])
      expect(store.getSendCommand(`send-${id}`)?.error).toBeNull();
    expect(store.getSendCommand('send-ordinary')?.error).toContain('restarted');
  } finally {
    raw.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
