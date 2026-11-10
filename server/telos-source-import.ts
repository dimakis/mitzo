import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { TelosOutcomeContextHintsSchema, TelosOutcomeLinkSchema } from '@mitzo/protocol';
import { readTelosLifecycleVisibility } from './telos-lifecycle-facts.js';
import { TelosWorkError } from './telos-work-store.js';

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
export const TelosImportBody = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: identity,
        summary: z.string().min(1).max(20000),
        profile: z.string().min(1).max(100),
        parentId: identity.nullable().optional(),
        urgency: z.number().min(0).max(1).default(0),
        sources: z
          .array(
            z.strictObject({
              type: z.string().min(1).max(100),
              sourceId: z.string().min(1).max(300),
              url: z.string().max(4000),
              title: z.string().max(20000),
              author: z.string().max(500),
              timestamp: z.string().min(1).max(100),
              rawSnippet: z.string().max(50000).default(''),
            }),
          )
          .max(100),
        priority: z.number().int().min(1).max(10).default(5),
        categories: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
        firstSeen: z.iso.datetime({ offset: true }).optional(),
        contextHints: TelosOutcomeContextHintsSchema.optional(),
        links: z.array(TelosOutcomeLinkSchema).max(100).default([]),
      }),
    )
    .max(500),
});

/** Runs on the original canonical writer. Reads are batched; no owner opens,
 * per-parent queries or repeated ancestry/graph traversals occur here. */
export function importTelosSources(
  db: Database.Database,
  raw: unknown,
  insert: (summary: string, profile: string, parentId: string | undefined, id: string) => void,
) {
  if (!db.inTransaction) throw Error('Telos import requires its canonical writer');
  const { items } = TelosImportBody.parse(raw);
  const incoming = new Map(items.map((item) => [item.id, item]));
  if (incoming.size !== items.length)
    throw new TelosWorkError('invalid', 'Duplicate import item identity');
  const identities = JSON.stringify([
    ...new Set(items.flatMap((item) => [item.id, ...(item.parentId ? [item.parentId] : [])])),
  ]);
  const existing = new Map(
    (
      db
        .prepare('SELECT id,status FROM items WHERE id IN (SELECT value FROM json_each(?))')
        .all(identities) as Array<{ id: string; status: string }>
    ).map((item) => [item.id, item]),
  );
  const parents = [
    ...new Set(
      items
        .filter((item) => !existing.has(item.id) && item.parentId && existing.has(item.parentId))
        .map((item) => item.parentId!),
    ),
  ];
  for (const parent of parents)
    if (existing.get(parent)!.status === 'completed')
      throw new TelosWorkError(
        'conflict',
        'Completed import parent must be reopened before adding work',
      );
  if (
    parents.length &&
    readTelosLifecycleVisibility(db, parents).some(
      (parent) => parent.effectiveDisposition !== 'active',
    )
  )
    throw new TelosWorkError(
      'unauthorized',
      'Archived or trashed import parent must be restored before adding work',
    );
  const ready: typeof items = [];
  const waiting = new Map<string, typeof items>();
  for (const item of items) {
    if (existing.has(item.id) || !item.parentId || existing.has(item.parentId)) ready.push(item);
    else {
      if (!incoming.has(item.parentId))
        throw new TelosWorkError('invalid', 'Import parent missing or cyclic');
      const children = waiting.get(item.parentId) ?? [];
      children.push(item);
      waiting.set(item.parentId, children);
    }
  }
  for (let cursor = 0; cursor < ready.length; cursor++)
    ready.push(...(waiting.get(ready[cursor].id) ?? []));
  if (ready.length !== items.length)
    throw new TelosWorkError('invalid', 'Import parent missing or cyclic');
  const sourceKey = (itemId: string, type: string, sourceId: string) =>
    JSON.stringify([itemId, type, sourceId]);
  const savedSources = new Map(
    (
      db
        .prepare(
          'SELECT id,item_id,type,source_id FROM sources WHERE item_id IN (SELECT value FROM json_each(?))',
        )
        .all(JSON.stringify(items.map((item) => item.id))) as Array<{
        id: string;
        item_id: string;
        type: string;
        source_id: string;
      }>
    ).map((source) => [sourceKey(source.item_id, source.type, source.source_id), source.id]),
  );
  const initialize = db.prepare(
    'UPDATE items SET priority=?,starred=?,categories=?,context_hints=?,first_seen=?,created_at=? WHERE id=?',
  );
  const touch = db.prepare('UPDATE items SET last_seen=?,urgency=? WHERE id=?');
  const link = db.prepare(
    'INSERT INTO links(id,item_id,type,url,title,description,created_at) VALUES(?,?,?,?,?,?,?)',
  );
  const evidence =
    db.prepare(`INSERT INTO sources(id,item_id,type,source_id,url,title,author,timestamp,raw_snippet)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,title=excluded.title,
    author=excluded.author,timestamp=excluded.timestamp,raw_snippet=excluded.raw_snippet`);
  const now = new Date().toISOString();
  let created = 0;
  for (const item of ready) {
    if (!existing.has(item.id)) {
      insert(item.summary, item.profile, item.parentId ?? undefined, item.id);
      const hints = item.contextHints;
      initialize.run(
        item.priority,
        item.priority === 10 ? 1 : 0,
        JSON.stringify(item.categories),
        JSON.stringify({
          repos: hints?.repos ?? [],
          paths: hints?.paths ?? [],
          issues: hints?.issues ?? [],
          doc_ids: hints?.docIds ?? [],
          people: hints?.people ?? [],
          jira_keys: hints?.jiraKeys ?? [],
          keywords: hints?.keywords ?? [],
          task_hint: hints?.taskHint ?? '',
          session_ids: hints?.sessionIds ?? [],
        }),
        item.firstSeen ?? now,
        item.firstSeen ?? now,
        item.id,
      );
      for (const value of item.links)
        link.run(randomUUID(), item.id, value.type, value.url, value.title, value.description, now);
      created++;
    }
    // Source refreshes cannot replace authored content, structure or progress.
    touch.run(now, item.urgency, item.id);
    for (const source of item.sources) {
      const key = sourceKey(item.id, source.type, source.sourceId);
      const id = savedSources.get(key) ?? createHash('sha256').update(key).digest('hex');
      evidence.run(
        id,
        item.id,
        source.type,
        source.sourceId,
        source.url,
        source.title,
        source.author,
        source.timestamp,
        source.rawSnippet,
      );
      savedSources.set(key, id);
    }
  }
  return { ok: true as const, total: items.length, created };
}
