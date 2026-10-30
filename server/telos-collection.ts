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
    // Walk each completed descendant once; sibling count must not multiply
    // repeated passes over the collection or change the original row order.
    const children = new Map<string, string[]>();
    for (const row of selected.values()) {
      if (row.status !== 'completed' || !row.parent_id) continue;
      const ids = children.get(row.parent_id) ?? [];
      ids.push(row.id);
      children.set(row.parent_id, ids);
    }
    const queue = [...active];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const id of children.get(queue[cursor]) ?? []) {
        if (active.has(id)) continue;
        active.add(id);
        queue.push(id);
      }
    }
    for (const id of selected.keys()) if (!active.has(id)) selected.delete(id);
  }
  const selection = JSON.stringify([...selected.keys()]);
  const grouped = (table: 'sources' | 'links') => {
    const groups = new Map<string, Row[]>();
    // Select evidence for this view in SQLite, avoiding a full evidence scan
    // and retaining a constant number of reads across sibling items.
    for (const row of db
      .prepare(
        `SELECT * FROM ${table} WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
      )
      .all(selection) as Array<Row & { item_id: string }>) {
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
      db
        .prepare(
          'SELECT item_id,kind FROM telos_work_kinds WHERE item_id IN (SELECT value FROM json_each(?))',
        )
        .all(selection) as Array<{
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
