import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { closeSync, openSync } from 'node:fs';
import { TodoCreateBody } from './api-schemas.js';
import { initializeTelosSchema } from './telos-schema.js';
import { importTelosSources } from './telos-source-import.js';
import {
  TelosOutcomeCreateBodySchema,
  type TelosOutcomeCreation,
  type TelosWorkItem,
} from '@mitzo/protocol';
import { projectTelosWorkRecord } from './telos-work-record.js';
import { telosCollectionProfiles } from './telos-collection.js';
import { TelosItemStore } from './telos-item-store.js';
import { assertTelosItemActive, readTelosLifecycleVisibility } from './telos-lifecycle-facts.js';
import {
  dueTelosSnoozeIds,
  renewDueTelosSnoozes,
  telosLocalDate,
  TelosCollectionWakeupRequired,
} from './telos-snooze.js';
import { TelosWorkError } from './telos-work-store.js';

export interface NativeTelosItem {
  id: string;
  summary: string;
  intent: string;
  rationale: string;
  acceptanceCriteria: string[];
  profile: string;
  urgency: number;
  priority: number;
  categories: string[];
  starred: boolean;
  status: TelosWorkItem['status'];
  ageDays: number;
  parentId: string | null;
  children: NativeTelosItem[];
  childCount: number;
  completedChildCount: number;
  sources: Array<{ type: string; url: string; title: string; author: string; snippet: string }>;
  links: Array<{ type: string; url: string; title: string; description: string }>;
  contextHints: TelosWorkItem['contextHints'];
  goalId: string | null;
}
interface NativeTelosCreationReceipt {
  ok: true;
  created: boolean;
  item: NativeTelosItem;
}

/** Mitzo owns the original canonical tables. Existing IDs, unknown columns and
 * extension tables are retained; no hydration/re-identification through Python. */
export class TelosRuntimeStore extends TelosItemStore {
  static initialize(path: string) {
    closeSync(openSync(path, 'wx', 0o600));
    const db = new Database(path, { fileMustExist: true });
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      initializeTelosSchema(db);
    } finally {
      db.close();
    }
  }
  private insertItem?: Database.Statement;
  private insertHistory?: Database.Statement;
  private insertLink?: Database.Statement;
  private readonly mutationAuthority?: () => void;
  constructor(path: string, options: { readOnly?: boolean; assertCurrentSync?: () => void } = {}) {
    super(path, { readOnly: options.readOnly });
    this.mutationAuthority = options.assertCurrentSync;
  }
  private checkMutationAuthority() {
    const result: unknown = this.mutationAuthority?.();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw Error('Synchronous current Telos authority required');
    }
  }
  private item(id: string): NativeTelosItem {
    const db = this.db;
    const row = db.prepare('SELECT * FROM items WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw Error('Telos item not found');
    const sources = db
      .prepare('SELECT * FROM sources WHERE item_id=? ORDER BY rowid')
      .all(id) as Record<string, unknown>[];
    const links = db
      .prepare('SELECT * FROM links WHERE item_id=? ORDER BY rowid')
      .all(id) as Record<string, unknown>[];
    return this.project(row, sources, links);
  }
  private project(
    row: Record<string, unknown>,
    sources: Record<string, unknown>[],
    links: Record<string, unknown>[],
  ): NativeTelosItem {
    const record = projectTelosWorkRecord(row, sources, links, null);
    return {
      id: record.itemId,
      summary: record.summary,
      intent: record.intent,
      rationale: record.rationale,
      acceptanceCriteria: record.acceptanceCriteria,
      profile: record.profile,
      urgency: Number(row.urgency ?? 0),
      priority: record.priority ?? (record.starred ? 10 : 5),
      categories: record.categories,
      starred: record.starred,
      status: record.status,
      ageDays:
        Math.max(0, Math.floor((Date.now() - Date.parse(String(row.first_seen))) / 86400000)) || 0,
      parentId: record.parentId,
      children: [],
      childCount: 0,
      completedChildCount: 0,
      sources: sources.map((s) => ({
        type: String(s.type),
        url: String(s.url),
        title: String(s.title),
        author: String(s.author),
        snippet: String(s.raw_snippet ?? '').slice(0, 200),
      })),
      links: record.links.map((l) => ({
        type: l.type,
        url: l.url,
        title: l.title,
        description: l.description,
      })),
      contextHints: record.contextHints,
      goalId: (row.goal_id ?? null) as string | null,
    };
  }
  private projectRows(rows: Array<Record<string, unknown> & { id: string }>) {
    const db = this.db,
      selection = JSON.stringify(rows.map((row) => row.id));
    const grouped = (table: 'sources' | 'links') => {
      const result = new Map<string, Record<string, unknown>[]>();
      for (const row of db
        .prepare(
          `SELECT * FROM ${table} WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
        )
        .all(selection) as Array<Record<string, unknown> & { item_id: string }>) {
        const values = result.get(row.item_id) ?? [];
        values.push(row);
        result.set(row.item_id, values);
      }
      return result;
    };
    const sources = grouped('sources'),
      links = grouped('links');
    return rows.map((row) => this.project(row, sources.get(row.id) ?? [], links.get(row.id) ?? []));
  }
  list(profile?: string, view: 'active' | 'archive' | 'trash' | boolean = 'active') {
    const all = view === true;
    const selectedView = typeof view === 'boolean' ? 'active' : view;
    let dueRows: Array<Record<string, unknown> & { id: string }> = [];
    const db = this.db;
    const read = db.transaction(() => {
      const select = db.prepare(
        'SELECT * FROM items ORDER BY starred DESC,urgency DESC,first_seen,rowid',
      );
      const rows = select.all() as Array<Record<string, unknown> & { id: string }>;
      if (dueTelosSnoozeIds(rows).length) {
        dueRows = rows;
        throw new TelosCollectionWakeupRequired();
      }
      // Select before hydrating evidence: retained history and other profiles
      // must not consume the requested collection's bound or parse budget.
      const profiles = telosCollectionProfiles(rows.map((i) => String(i.profile)));
      const matching = rows.filter((i) => !profile || i.profile === profile);
      const disposition = { active: 'active', archive: 'archived', trash: 'trashed' }[selectedView];
      const lifecycle = new Set(
        readTelosLifecycleVisibility(
          db,
          rows.map((row) => row.id),
        )
          .filter((row) => row.effectiveDisposition === disposition)
          .map((row) => row.itemId),
      );
      const visible = new Set(
        matching
          .filter(
            (i) =>
              lifecycle.has(i.id) &&
              (all ||
                selectedView !== 'active' ||
                ['active', 'acknowledged'].includes(String(i.status))),
          )
          .map((i) => i.id),
      );
      if (!all && selectedView === 'active') {
        const children = new Map<string, string[]>();
        for (const item of matching)
          if (item.status === 'completed' && item.parent_id && lifecycle.has(item.id)) {
            const parentId = String(item.parent_id);
            const siblings = children.get(parentId) ?? [];
            siblings.push(item.id);
            children.set(parentId, siblings);
          }
        const queue = [...visible];
        for (let cursor = 0; cursor < queue.length; cursor++)
          for (const id of children.get(queue[cursor]) ?? [])
            if (!visible.has(id)) {
              visible.add(id);
              queue.push(id);
            }
      }
      const selectedRows = matching.filter((i) => visible.has(i.id));
      if (selectedRows.length > 5000) throw Error('Telos collection exceeds bounded selection');
      const items = this.projectRows(selectedRows);
      const selected = new Map(items.map((i) => [i.id, i]));
      const roots: typeof items = [];
      for (const item of selected.values()) {
        // The single lifecycle traversal already validated all ancestry.
        if (item.parentId && selected.has(item.parentId))
          selected.get(item.parentId)!.children.push(item);
        else roots.push(item);
      }
      for (const item of items) {
        item.childCount = item.children.length;
        item.completedChildCount = item.children.filter((c) => c.status === 'completed').length;
      }
      return { profiles, items: roots };
    });
    try {
      return read();
    } catch (error) {
      if (!(error instanceof TelosCollectionWakeupRequired) || db.readonly || db.inTransaction)
        throw error;
      db.transaction(() => renewDueTelosSnoozes(db, dueRows, () => {})).immediate();
      return read();
    }
  }
  renewSnoozes() {
    const rows = this.db
      .prepare("SELECT id,status,snoozed_until FROM items WHERE status='snoozed'")
      .all() as Array<Record<string, unknown> & { id: string }>;
    if (!dueTelosSnoozeIds(rows).length) return;
    this.db.transaction(() => renewDueTelosSnoozes(this.db, rows, () => {})).immediate();
  }
  importSources(raw: unknown) {
    return this.db
      .transaction(() => {
        this.checkMutationAuthority();
        return importTelosSources(this.db, raw, (summary, profile, parentId, id) =>
          this.insert({ summary, profile, parentId, id }),
        );
      })
      .immediate();
  }
  private insert(input: {
    id: string;
    summary: string;
    profile: string;
    parentId?: string;
    outcome?: TelosOutcomeCreation;
  }) {
    const db = this.db,
      now = new Date().toISOString(),
      hints = input.outcome?.contextHints ?? {};
    const context = {
      repos: hints.repos ?? [],
      paths: hints.paths ?? [],
      issues: hints.issues ?? [],
      doc_ids: hints.docIds ?? [],
      people: hints.people ?? [],
      jira_keys: hints.jiraKeys ?? [],
      keywords: hints.keywords ?? [],
      task_hint: hints.taskHint ?? '',
      session_ids: hints.sessionIds ?? [],
    };
    (this.insertItem ??= db.prepare(
      `INSERT INTO items(id,summary,intent,rationale,acceptance_criteria,idempotency_key,profile,starred,priority,urgency,context_hints,first_seen,last_seen,created_at,updated_at,parent_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )).run(
      input.id,
      input.summary,
      input.outcome?.intent ?? '',
      input.outcome?.rationale ?? '',
      JSON.stringify(input.outcome?.acceptanceCriteria ?? []),
      input.outcome?.idempotencyKey ?? null,
      input.profile,
      input.outcome ? 1 : 0,
      input.outcome ? 10 : 5,
      input.outcome ? 1 : 0,
      JSON.stringify(context),
      now,
      now,
      now,
      now,
      input.parentId ?? null,
    );
    (this.insertHistory ??= db.prepare(
      'INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,NULL,?,?)',
    )).run(input.id, 'active', now);
    for (const link of input.outcome?.links ?? [])
      (this.insertLink ??= db.prepare(
        'INSERT INTO links(id,item_id,type,url,title,description,created_at) VALUES(?,?,?,?,?,?,?)',
      )).run(randomUUID(), input.id, link.type, link.url.trim(), link.title, link.description, now);
  }
  create(raw: unknown, profile?: string, parentId?: string) {
    const input = TodoCreateBody.parse(
      typeof raw === 'string' ? { summary: raw, profile, parentId } : raw,
    );
    const { summary } = input;
    parentId = input.parentId;
    return this.db
      .transaction(() => {
        this.checkMutationAuthority();
        if (parentId) {
          assertTelosItemActive(this.db, parentId);
          const parent = this.db.prepare('SELECT status FROM items WHERE id=?').get(parentId) as {
            status: string;
          };
          if (parent.status === 'completed')
            throw Error('Telos item is completed; reopen the parent before adding work');
        }
        const id = randomUUID();
        this.insert({ id, summary, profile: input.profile, parentId });
        return { ok: true as const, item: this.item(id) };
      })
      .immediate();
  }
  createOutcome(raw: unknown, assertCurrent?: () => void): NativeTelosCreationReceipt {
    const input = TelosOutcomeCreateBodySchema.parse(raw);
    if (
      input.links?.some((link) => {
        const url = link.url.trim();
        return (
          !url ||
          url.startsWith('/') ||
          url.includes('.claude/worktrees/') ||
          url.includes('.cursor/worktrees/')
        );
      })
    )
      throw new TelosWorkError(
        'invalid',
        'Outcome links must use portable repository-relative paths or URLs',
      );
    const db = this.db;
    return db
      .transaction(() => {
        this.checkMutationAuthority();
        const current: unknown = assertCurrent?.();
        if (current !== undefined) {
          void Promise.resolve(current).catch(() => {});
          throw Error('Synchronous current Telos authority required');
        }
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const previous = db
          .prepare(
            'SELECT input_hash,item_id,receipt FROM mitzo_telos_creation_receipts WHERE request_id=?',
          )
          .get(input.idempotencyKey) as
          { input_hash: string; item_id: string; receipt: string } | undefined;
        if (previous && previous.input_hash !== hash)
          throw Error('Telos creation identity reused with different input');
        if (previous) {
          if (!db.prepare('SELECT id FROM items WHERE id=?').get(previous.item_id))
            throw Error('Deleted Telos outcome cannot be recreated with this identity');
          return {
            ...(JSON.parse(previous.receipt) as NativeTelosCreationReceipt),
            created: false,
          };
        }
        const historical = db
          .prepare('SELECT id FROM items WHERE idempotency_key=?')
          .get(input.idempotencyKey) as { id: string } | undefined;
        if (historical)
          throw Error(
            'Historical Telos creation identity already exists; inspect the original outcome',
          );
        const id = randomUUID();
        this.insert({ id, summary: input.summary, profile: input.profile, outcome: input });
        for (const summary of input.milestones)
          this.insert({ id: randomUUID(), summary, profile: input.profile, parentId: id });
        const records = this.projectRows(
          db
            .prepare('SELECT * FROM items WHERE id=? OR parent_id=? ORDER BY rowid')
            .all(id, id) as Array<Record<string, unknown> & { id: string }>,
        );
        const item = records.find((row) => row.id === id)!;
        item.children = records.filter((row) => row.parentId === id);
        item.childCount = item.children.length;
        item.completedChildCount = item.children.filter((c) => c.status === 'completed').length;
        const receipt: NativeTelosCreationReceipt = {
          ok: true as const,
          created: true,
          item,
        };
        db.prepare(
          'INSERT INTO mitzo_telos_creation_receipts(request_id,input_hash,item_id,receipt) VALUES(?,?,?,?)',
        ).run(input.idempotencyKey, hash, id, JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }
  action(
    id: string,
    input: {
      action: 'ack' | 'done' | 'snooze' | 'star' | 'unstar' | 'priority';
      days?: number;
      priority?: number;
    },
    actor = 'interactive',
  ) {
    const db = this.db;
    // One ancestry read inside this original writer fences concurrent archive.
    const current = () => assertTelosItemActive(db, id);
    {
      if (input.action === 'ack' || input.action === 'done') {
        this.updateGuarded(
          {
            itemId: id,
            requestId: randomUUID(),
            expectedRevision: this.read(id).revision,
            status: input.action === 'done' ? 'completed' : 'acknowledged',
            note: 'Updated by the interactive operator.',
          },
          actor,
          () => {},
          () => {
            this.checkMutationAuthority();
            current();
          },
        );
      } else
        db.transaction(() => {
          this.checkMutationAuthority();
          current();
          const now = new Date().toISOString();
          if (input.action === 'priority') {
            if (!Number.isInteger(input.priority) || input.priority! < 1 || input.priority! > 10)
              throw Error('Priority must be an integer from 1 to 10');
            db.prepare('UPDATE items SET priority=?,updated_at=? WHERE id=?').run(
              input.priority,
              now,
              id,
            );
          } else if (input.action === 'snooze') {
            const days = input.days ?? 3;
            if (!Number.isInteger(days) || days < 1 || days > 3650)
              throw Error('Snooze days must be an integer from 1 to 3650');
            const before = (
              db.prepare('SELECT status FROM items WHERE id=?').get(id) as { status: string }
            ).status;
            const until = new Date();
            until.setDate(until.getDate() + days);
            db.prepare(
              "UPDATE items SET status='snoozed',snoozed_until=?,updated_at=? WHERE id=?",
            ).run(telosLocalDate(until), now, id);
            db.prepare(
              "INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,?,'snoozed',?)",
            ).run(id, before, now);
          } else
            db.prepare('UPDATE items SET starred=?,updated_at=? WHERE id=?').run(
              input.action === 'star' ? 1 : 0,
              now,
              id,
            );
        }).immediate();
      return { ok: true as const };
    }
  }
}

export { initializeTelosSchema as initializeTelosRuntimeSchema } from './telos-schema.js';
