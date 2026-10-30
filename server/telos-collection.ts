import type Database from 'better-sqlite3';
import type { TelosWorkItem } from '@mitzo/protocol';
import { projectTelosWorkRecord } from './telos-work-record.js';
import type { TelosLifecycleVisibility } from './telos-lifecycle-tree.js';

type Row = Record<string, unknown>;
export interface TelosCollection {
  records: TelosWorkItem[];
  failures: Array<{ itemId: string; code: 'invalid_record' }>;
  profiles: string[];
}
/** Called under the canonical owner's read transaction. Identity comes only from
 * stored rows. Evidence and kinds are grouped once, never hydrated via Python or
 * the relationship snapshot (which includes unrelated role/history reads). */
export function projectTelosCollection(
  db: Database.Database,
  items: Array<Row & { id: string; parent_id: string | null }>,
  lifecycle: readonly TelosLifecycleVisibility[],
  view: 'active' | 'archive' | 'trash',
): TelosCollection {
  const disposition = { active: 'active', archive: 'archived', trash: 'trashed' }[view];
  const visible = new Set(
    lifecycle.filter((row) => row.effectiveDisposition === disposition).map((row) => row.itemId),
  );
  const selected = new Map(items.filter((row) => visible.has(row.id)).map((row) => [row.id, row]));
  if (view === 'active') {
    const active = new Set(
      items
        .filter(
          (row) => ['active', 'acknowledged'].includes(String(row.status)) && visible.has(row.id),
        )
        .map((row) => row.id),
    );
    // Keep completed milestones below listed parents, including nested milestones.
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of selected.values())
        if (
          row.status === 'completed' &&
          row.parent_id &&
          active.has(row.parent_id) &&
          !active.has(row.id)
        ) {
          active.add(row.id);
          changed = true;
        }
    }
    for (const id of selected.keys()) if (!active.has(id)) selected.delete(id);
  }
  const grouped = (table: 'sources' | 'links') => {
    const groups = new Map<string, Row[]>();
    // The collection is bounded by the owner. Joining items omits detached evidence.
    for (const row of db
      .prepare(
        `SELECT ${table}.* FROM ${table} JOIN items ON items.id=${table}.item_id ORDER BY ${table}.rowid`,
      )
      .all() as Array<Row & { item_id: string }>) {
      if (!selected.has(row.item_id)) continue;
      const entries = groups.get(row.item_id) ?? [];
      entries.push(row);
      groups.set(row.item_id, entries);
    }
    return groups;
  };
  const sources = grouped('sources'),
    links = grouped('links');
  const kinds = new Map(
    (
      db.prepare('SELECT item_id,kind FROM telos_work_kinds').all() as Array<{
        item_id: string;
        kind: TelosWorkItem['kind'];
      }>
    ).map((row) => [row.item_id, row.kind]),
  );
  const result: TelosCollection = {
    records: [],
    failures: [],
    profiles: [...new Set(items.map((row) => String(row.profile ?? '')))].filter(Boolean).sort(),
  };
  for (const row of selected.values()) {
    try {
      result.records.push(
        projectTelosWorkRecord(
          row,
          sources.get(row.id) ?? [],
          links.get(row.id) ?? [],
          kinds.get(row.id) ?? null,
        ),
      );
    } catch {
      result.failures.push({ itemId: row.id, code: 'invalid_record' });
    }
  }
  return result;
}
