import type Database from 'better-sqlite3';

/** A read-only admission proved a due transition; never escalate on an I/O error. */
export class TelosCollectionWakeupRequired extends Error {
  constructor() {
    super('Expired snoozes require canonical renewal');
  }
}

/** Match MGMT's host-local, inclusive calendar-day expiry. The caller owns an
 * IMMEDIATE writer transaction; history and status commit or roll back together. */
export function renewDueTelosSnoozes(
  db: Database.Database,
  items: Array<Record<string, unknown> & { id: string }>,
  now = new Date(),
): boolean {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const ids = items
    .filter(
      (row) =>
        row.status === 'snoozed' &&
        typeof row.snoozed_until === 'string' &&
        row.snoozed_until <= today,
    )
    .map((row) => row.id);
  if (!ids.length) return false;
  if (db.readonly) throw new TelosCollectionWakeupRequired();
  if (!db.inTransaction) throw Error('Canonical snooze renewal requires its writer transaction');
  const timestamp = `${today}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  const selected = JSON.stringify(ids);
  const eligible =
    "id IN (SELECT value FROM json_each(?)) AND status='snoozed' AND snoozed_until <= ?";
  db.prepare(
    `INSERT INTO history(item_id,old_status,new_status,changed_at) SELECT id,'snoozed','active',? FROM items WHERE ${eligible}`,
  ).run(timestamp, selected, today);
  db.prepare(
    `UPDATE items SET status='active',snoozed_until=NULL,updated_at=? WHERE ${eligible}`,
  ).run(timestamp, selected, today);
  return true;
}
