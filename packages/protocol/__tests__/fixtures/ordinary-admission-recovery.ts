import { expect } from 'vitest';
import type { EventStore } from '../../src/event-store.js';

export const staleOrdinaryAdmissionCases = [
  'runtime',
  'workspace',
  'admission',
  'empty-admission',
] as const;

/** Shared restart contract for the actual Codex and Vertex admission owners. */
export function assertStaleOrdinaryAdmissionRecovery(
  store: EventStore,
  kind: (typeof staleOrdinaryAdmissionCases)[number],
  claim: () => boolean,
) {
  expect(claim()).toBe(true);
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  if (kind === 'runtime')
    db.prepare('UPDATE sessions SET runtime_binding=? WHERE session_id=?').run(
      '{"version":99}',
      's1',
    );
  else if (kind === 'workspace')
    db.prepare('UPDATE sessions SET cwd=?,repository_workspace_id=? WHERE session_id=?').run(
      '/next-task',
      'w2',
      's1',
    );
  else
    db.prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?').run(
      kind === 'empty-admission' ? '' : '{"version":99}',
      'c1',
    );

  store.upsertSession({ sessionId: 'legacy' });
  store.insertSendCommand('legacy-command', 'legacy', { prompt: 'legacy prompt' });
  const receiptBefore = db.prepare('SELECT * FROM send_commands WHERE client_msg_id=?').get('c1');
  const sessionBefore = db.prepare('SELECT * FROM sessions WHERE session_id=?').get('s1');
  const eventsBefore = db.prepare('SELECT * FROM events WHERE session_id=?').all('s1');

  expect(() => store.recoverPendingSendCommands()).not.toThrow();
  expect(claim).toThrow();
  if (kind === 'workspace') expect(store.hasUncertainOrdinaryCommand('s1')).toBe(true);
  expect(db.prepare('SELECT * FROM send_commands WHERE client_msg_id=?').get('c1')).toEqual(
    receiptBefore,
  );
  expect(db.prepare('SELECT * FROM sessions WHERE session_id=?').get('s1')).toEqual(sessionBefore);
  expect(db.prepare('SELECT * FROM events WHERE session_id=?').all('s1')).toEqual(eventsBefore);
  expect(store.getSendCommand('legacy-command')?.error).toMatch(/restarted/i);
  expect(store.getSession('legacy')?.state).toBe('ENDED');
  expect(store.getEventsAfter('legacy', 0).some((event) => event.type === 'error')).toBe(true);
}
