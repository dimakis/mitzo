import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { maintenanceFingerprint } from '@mitzo/protocol/event-store';
import type { CodexConversationStore } from './codex-conversation-store.js';

/** Observational only. An idle handoff authorizes replacing a stopped host,
 * never interpreting a legacy outcome, recovering input or acquiring ownership. */
export function maintenanceIdleFingerprint(
  events: Database.Database,
  native: CodexConversationStore,
  eventsPath: string,
  quarantined: readonly string[],
  owners: readonly string[],
): string {
  if (
    events
      .prepare(
        "SELECT 1 FROM sessions WHERE execution_phase IS NOT NULL AND execution_phase!='TERMINAL' LIMIT 1",
      )
      .get() ||
    events
      .prepare(
        "SELECT 1 FROM session_prompt_deliveries WHERE json_extract(data,'$.state') IN ('pending','dispatching') LIMIT 1",
      )
      .get()
  )
    throw Error('Idle handoff requires no execution or pending prompt delivery');
  const journals = [
    [
      'capabilities.db',
      'capability_operations',
      "SELECT 1 FROM capability_operations WHERE status IN ('pending_approval','running','verification_pending') LIMIT 1",
    ],
    [
      'openai-key-operations.db',
      'openai_key_operations',
      "SELECT 1 FROM openai_key_operations WHERE phase NOT IN ('complete','aborted') LIMIT 1",
    ],
  ];
  const retainedJournals: unknown[] = [];
  for (const [name, table, query] of journals) {
    const path = join(dirname(eventsPath), name);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        retainedJournals.push({ name, absent: true });
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o022)
      throw Error('Original owned background journal required');
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      if (db.prepare(query).get()) throw Error('Background recovery still owns work');
      const digest = createHash('sha256');
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate())
        digest.update(JSON.stringify(row));
      retainedJournals.push({ name, dev: stat.dev, ino: stat.ino, sha256: digest.digest('hex') });
      const after = lstatSync(path);
      if (after.dev !== stat.dev || after.ino !== stat.ino)
        throw Error('Background journal changed');
    } finally {
      db.close();
    }
  }
  return maintenanceFingerprint({
    kind: 'idle-no-delivery-v1',
    native: native.maintenanceIdleFingerprint(quarantined, owners),
    journals: retainedJournals,
    // Uncertain deliveries stay unavailable; the scheduler never resends them.
    uncertain: events
      .prepare(
        "SELECT * FROM session_prompt_deliveries WHERE json_extract(data,'$.state')='uncertain' ORDER BY id",
      )
      .all(),
    timers: events.prepare('SELECT * FROM session_prompt_timers ORDER BY id').all(),
  });
}
