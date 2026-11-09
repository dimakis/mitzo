import type Database from 'better-sqlite3';
import { TelosWorkError } from './telos-work-store.js';

export interface TelosLifecycleState {
  disposition: 'active' | 'archived' | 'trashed';
  restoreDisposition: 'active' | 'archived';
  pauseControlIds: string[];
  generation: number;
}
/** One bounded ancestry query, shared by progress admission and work revisions.
 * The caller's transaction supplies the snapshot/writer fence. No store opens,
 * role hydration, nested transactions or per-ancestor lookups occur here. */
export function readTelosLifecycleFacts(db: Database.Database, itemId: string) {
  const rows = db
    .prepare(
      `WITH RECURSIVE ancestry(id,parent_id,depth) AS (
    SELECT id,parent_id,0 FROM items WHERE id=?
    UNION ALL SELECT i.id,i.parent_id,a.depth+1 FROM items i JOIN ancestry a ON i.id=a.parent_id WHERE a.depth<1000
  ) SELECT a.id,a.parent_id,l.data FROM ancestry a LEFT JOIN telos_work_lifecycle l ON l.item_id=a.id ORDER BY a.depth`,
    )
    .all(itemId) as { id: string; parent_id: string | null; data: string | null }[];
  if (!rows.length) throw new TelosWorkError('not_found', 'Work item not found');
  if (
    rows.length > 1000 ||
    new Set(rows.map((r) => r.id)).size !== rows.length ||
    rows.at(-1)!.parent_id !== null
  )
    throw new TelosWorkError('conflict', 'Lifecycle ancestry unavailable or too large');
  return rows.map((row) => ({
    itemId: row.id,
    state: row.data
      ? (JSON.parse(row.data) as TelosLifecycleState)
      : {
          disposition: 'active' as const,
          restoreDisposition: 'active' as const,
          pauseControlIds: [],
          generation: 0,
        },
  }));
}
export function assertTelosItemActive(db: Database.Database, itemId: string) {
  const facts = readTelosLifecycleFacts(db, itemId);
  const hidden =
    facts.find((r) => r.state.disposition === 'trashed') ??
    facts.find((r) => r.state.disposition === 'archived');
  if (hidden)
    throw new TelosWorkError(
      'unauthorized',
      `Work is ${hidden.state.disposition}; restore or unarchive its selected root before new actions`,
    );
}
/** One flat collection read; no role, control, or per-item snapshots. */
export function readTelosLifecycleVisibility(db: Database.Database, ids: readonly string[]) {
  const conflict = (message: string): never => {
    throw new TelosWorkError('conflict', message);
  };
  type Disposition = TelosLifecycleState['disposition'];
  // Only selected identities and their ancestry enter this read. UNION keeps
  // corrupt cycles finite; the resolver retains the existing depth fence.
  const rows = db
    .prepare(
      `WITH RECURSIVE ancestry(id,parent_id) AS (
        SELECT id,parent_id FROM items WHERE id IN (SELECT value FROM json_each(?))
        UNION SELECT i.id,i.parent_id FROM items i JOIN ancestry a ON i.id=a.parent_id
      ) SELECT a.id,a.parent_id,l.data FROM ancestry a
        LEFT JOIN telos_work_lifecycle l ON l.item_id=a.id`,
    )
    .all(JSON.stringify(ids)) as Array<{
    id: string;
    parent_id: string | null;
    data: string | null;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const memo = new Map<string, { disposition: Disposition; depth: number }>();
  const resolve = (itemId: string): Disposition => {
    const path: typeof rows = [];
    const seen = new Set<string>();
    let id: string | null = itemId;
    while (id !== null && !memo.has(id)) {
      if (seen.has(id) || seen.size >= 1000)
        conflict('Lifecycle ancestry unavailable or too large');
      seen.add(id);
      const row = byId.get(id);
      if (!row) throw new TelosWorkError('not_found', 'Work item not found');
      path.push(row);
      id = row.parent_id;
    }
    let inherited =
      id === null ? { disposition: 'active' as Disposition, depth: 0 } : memo.get(id)!;
    for (const row of path.reverse()) {
      const local =
        row.data !== null ? (JSON.parse(row.data) as TelosLifecycleState).disposition : 'active';
      const disposition =
        local === 'trashed' || inherited.disposition === 'trashed'
          ? 'trashed'
          : local === 'archived' || inherited.disposition === 'archived'
            ? 'archived'
            : 'active';
      const depth = inherited.depth + 1;
      if (depth > 1000) conflict('Lifecycle ancestry unavailable or too large');
      inherited = { disposition, depth };
      memo.set(row.id, inherited);
    }
    return memo.get(itemId)!.disposition;
  };
  // A separately confirmed permanent deletion may remove selected IDs.
  return ids.flatMap((itemId) =>
    byId.has(itemId) ? [{ itemId, effectiveDisposition: resolve(itemId) }] : [],
  );
}
