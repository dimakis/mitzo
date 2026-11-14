import { installCurrentFileProbe } from '@mitzo/sqlite-file-owner';
import { lstatSync, realpathSync } from 'node:fs';
import {
  openTelosOwnedDatabase,
  type TelosOwnedDatabase,
} from '@mitzo/protocol/telos-sqlite-owners';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializeTelosSchema } from './telos-schema.js';
import { initializeTelosWorkKinds } from './telos-work-schema.js';
import { assertTelosItemActive } from './telos-lifecycle-facts.js';
import { drainRejectedTelosAuthority } from './telos-authority-diagnostic.js';
import { retainCallbackOutcome } from './turn-callbacks.js';
import {
  TelosEditItemInputSchema,
  type TelosEditItemInput,
  TelosCreateChildInputSchema,
  type TelosCreateChildInput,
  TelosCreateFeatureInputSchema,
  type TelosCreateFeatureInput,
} from '@mitzo/protocol';

export interface TelosItemUpdateInput {
  itemId: string;
  requestId: string;
  expectedRevision: string;
  status?: 'active' | 'acknowledged' | 'completed';
  note: string;
}
interface ItemRow {
  id: string;
  summary: string;
  status: string;
  parent_id: string | null;
  intent: string;
  rationale: string;
  acceptance_criteria: string;
  updated_at: string;
}
interface UpdateRow {
  session_id: string;
  request_id: string;
  note: string;
  old_status: string;
  new_status: string;
  created_at: string;
}
function assertCurrent(assertion?: () => void): void {
  if (!assertion) return;
  const result: unknown = assertion();
  if (result === undefined) return;
  drainRejectedTelosAuthority(result, 'item-authority');
  throw Error('Synchronous Telos item authority required');
}

/** Operates on the canonical Telos DB, preserving its existing item/history model. */
export class TelosItemStore {
  protected db: Database.Database;
  #telosOwner: TelosOwnedDatabase;
  constructor(
    private readonly path: string,
    options: { initialize?: boolean; readOnly?: boolean } = {},
  ) {
    const creating = options.initialize && !existsSync(path);
    if (options.initialize) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#telosOwner = openTelosOwnedDatabase('canonical', path, {
      fileMustExist: !options.initialize,
      ...(options.readOnly ? { readonly: true } : {}),
    });
    this.db = this.#telosOwner.database;
    try {
      if (creating) chmodSync(path, 0o600);
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      if (options.initialize) {
        this.db.pragma('journal_mode = WAL');
        initializeTelosSchema(this.db);
      }
      this.db
        .prepare(
          'SELECT id,summary,status,parent_id,intent,rationale,acceptance_criteria,updated_at,snoozed_until FROM items LIMIT 1',
        )
        .get();
      this.db.prepare('SELECT item_id,old_status,new_status,changed_at FROM history LIMIT 1').get();
      this.#telosOwner.seal();
    } catch (error) {
      this.#telosOwner.close();
      throw error;
    }
  }
  close(): void {
    this.#telosOwner.close();
  }
  /** Pure admission read on this owner's original transaction/connection. */
  assertLifecycleActive(itemId: string): void {
    assertTelosItemActive(this.db, itemId);
  }

  private hasUpdates(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telos_item_updates'")
      .get();
  }
  private workKind(itemId: string): 'coordinator' | 'outcome' | 'work_item' | null {
    if (
      !this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telos_work_kinds'")
        .get()
    )
      return null;
    return (
      (
        this.db.prepare('SELECT kind FROM telos_work_kinds WHERE item_id=?').get(itemId) as
          { kind: 'coordinator' | 'outcome' | 'work_item' } | undefined
      )?.kind ?? null
    );
  }
  private snapshot(itemId: string, updatesExist = this.hasUpdates()) {
    const row = this.db.prepare('SELECT * FROM items WHERE id=?').get(itemId) as
      ItemRow | undefined;
    if (!row) throw new Error('Telos item not found');
    const children = this.db
      .prepare('SELECT * FROM items WHERE parent_id=? ORDER BY id')
      .all(itemId) as ItemRow[];
    const updates = updatesExist
      ? (this.db
          .prepare(
            'SELECT session_id,request_id,note,old_status,new_status,created_at FROM telos_item_updates WHERE item_id=? ORDER BY seq DESC LIMIT 20',
          )
          .all(itemId) as UpdateRow[])
      : [];
    const kind = this.workKind(itemId);
    return {
      id: row.id,
      workLevel:
        kind === 'coordinator'
          ? 'outcome'
          : kind === 'outcome'
            ? 'feature'
            : kind === 'work_item'
              ? 'slice'
              : null,
      summary: row.summary,
      status: row.status,
      parentId: row.parent_id,
      intent: row.intent,
      rationale: row.rationale,
      acceptanceCriteria: JSON.parse(row.acceptance_criteria || '[]') as string[],
      updatedAt: row.updated_at,
      revision: createHash('sha256')
        .update(JSON.stringify([row, children, updates, kind]))
        .digest('hex'),
      children: children.map((child) => ({
        id: child.id,
        summary: child.summary,
        status: child.status,
      })),
      updates: updates.map((entry) => ({
        sessionId: entry.session_id,
        requestId: entry.request_id,
        note: entry.note,
        oldStatus: entry.old_status,
        status: entry.new_status,
        createdAt: entry.created_at,
      })),
    };
  }

  private updateReceipt(sessionId: string, requestId: string) {
    return this.db
      .prepare(
        'SELECT input_hash,receipt FROM telos_item_updates WHERE session_id=? AND request_id=?',
      )
      .get(sessionId, requestId) as { input_hash: string; receipt: string } | undefined;
  }
  /** Inspect the canonical atomic ledger without creating schema or retrying an edit. */
  observeUpdateReceipt(
    itemId: string,
    sessionId: string,
    requestId: string,
    assertion: () => void,
  ) {
    if (typeof assertion !== 'function' || this.db.inTransaction)
      throw Error('Original guarded Telos reader required');
    return this.db.transaction(() => {
      assertCurrent(assertion);
      // This is a read, not deletion authority or enrollment. Legacy canonical
      // databases also require SQLite's actual open-file/path identity probe.
      installCurrentFileProbe(this.db);
      const fileCurrent = () => {
        if (
          (
            this.db.prepare('SELECT mitzo_file_owner_current() AS current').get() as {
              current: number;
            }
          ).current !== 1
        )
          throw Error('Canonical Telos database identity changed');
      };
      fileCurrent();
      const stat = lstatSync(this.path, { bigint: true });
      if (!stat.isFile()) throw Error('Canonical Telos database identity changed');
      const canonicalDatabaseIdentity = {
        realpath: realpathSync(this.path),
        dev: String(stat.dev),
        ino: String(stat.ino),
        uid: String(stat.uid),
      };
      const updateReceipt = this.hasUpdates()
        ? (this.updateReceipt(sessionId, requestId) ?? null)
        : null;
      const itemExists = !!this.db.prepare('SELECT 1 FROM items WHERE id=?').get(itemId);
      assertCurrent(assertion);
      fileCurrent();
      return { canonicalDatabaseIdentity, updateReceipt, itemExists };
    })();
  }

  /** One writer and receipt path for creation, brief edits and progress updates.
   * Reuse schema observations only within this transaction, never across calls. */
  private writeWithReceipt<T extends TelosItemUpdateReceipt>(
    sessionId: string,
    requestId: string,
    fingerprint: unknown,
    assertion: (() => void) | undefined,
    apply: (inputHash: string, updatesExist: boolean) => T,
  ): T {
    return this.db
      .transaction(() => {
        assertCurrent(assertion);
        const inputHash = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
        const updatesExist = this.hasUpdates();
        if (updatesExist) {
          const previous = this.updateReceipt(sessionId, requestId);
          if (previous) {
            if (previous.input_hash !== inputHash)
              throw retainCallbackOutcome(
                Error('Update request identity reused with different input'),
                'settled',
              );
            return JSON.parse(previous.receipt) as T;
          }
        }
        const receipt = apply(inputHash, updatesExist);
        this.db
          .prepare('UPDATE telos_item_updates SET receipt=? WHERE session_id=? AND request_id=?')
          .run(JSON.stringify(receipt), sessionId, requestId);
        return receipt;
      })
      .immediate();
  }

  /** One consistent read; inspection never creates progress tables or changes items. */
  read(itemId: string) {
    return this.db.transaction(() => this.snapshot(itemId))();
  }

  /** Native invocation authority is checked while the real read snapshot is open. */
  readGuarded(itemId: string, assertion: () => void) {
    if (typeof assertion !== 'function') throw Error('Synchronous Telos item authority required');
    if (this.db.inTransaction) throw Error('Original Telos item reader required');
    return this.db.transaction(() => {
      assertCurrent(assertion);
      const item = this.snapshot(itemId);
      assertCurrent(assertion);
      return item;
    })();
  }

  update(input: TelosItemUpdateInput, sessionId: string) {
    return this.mutate(input, sessionId);
  }
  /** Child, history and immutable receipt share the canonical owner's writer.
   * The host supplies current invocation and parent lifecycle checks; this does
   * not capture source materials, assign a role or start execution. */
  createChildGuarded(
    raw: TelosCreateChildInput,
    sessionId: string,
    assertion: () => void,
    beforeApply: () => void,
  ): TelosChildCreationReceipt {
    return this.createBacklogGuarded(
      TelosCreateChildInputSchema.parse(raw),
      sessionId,
      assertion,
      beforeApply,
    ) as TelosChildCreationReceipt;
  }

  createFeatureGuarded(
    raw: TelosCreateFeatureInput,
    sessionId: string,
    assertion: () => void,
  ): TelosItemUpdateReceipt {
    return this.createBacklogGuarded(
      TelosCreateFeatureInputSchema.parse(raw),
      sessionId,
      assertion,
    );
  }

  /** Both creators share the original canonical writer, atomic audit and replay ledger. */
  private createBacklogGuarded(
    input: TelosCreateFeatureInput | TelosCreateChildInput,
    sessionId: string,
    assertion: () => void,
    beforeApply?: () => void,
  ): TelosItemUpdateReceipt & { parentRevision?: string } {
    const child = 'parentId' in input ? input : undefined;
    if (
      typeof assertion !== 'function' ||
      (child && typeof beforeApply !== 'function') ||
      !sessionId.trim()
    )
      throw Error('Synchronous Telos creation authority and session required');
    if (this.db.inTransaction) throw Error('Original Telos item writer required');
    return this.writeWithReceipt(
      sessionId,
      input.requestId,
      { operation: child ? 'create-child' : 'create-feature', input },
      assertion,
      (inputHash, updatesExist) => {
        const parent = child ? this.snapshot(child.parentId, updatesExist) : undefined;
        if (child && parent?.revision !== child.expectedParentRevision)
          throw retainCallbackOutcome(
            Error('Telos item changed; read the parent again before creating a child'),
            'settled',
          );
        if (parent?.status === 'completed')
          throw retainCallbackOutcome(
            Error('Telos item is completed; reopen the parent before adding work'),
            'settled',
          );
        assertCurrent(assertion);
        // Eligibility checks apply to new effects, not recovery of committed receipts.
        assertCurrent(beforeApply);
        const itemId = createHash('sha256')
          .update(
            JSON.stringify([child ? 'telos-child' : 'telos-feature', sessionId, input.requestId]),
          )
          .digest('hex')
          .slice(0, 16);
        const now = new Date().toISOString();
        if (!updatesExist) this.ensureUpdates();
        const parentKind = child ? this.workKind(child.parentId) : null;
        const kind =
          !child || parentKind === 'coordinator'
            ? 'outcome'
            : parentKind === 'outcome'
              ? 'work_item'
              : null;
        if (kind) initializeTelosWorkKinds(this.db);
        this.db
          .prepare(
            `INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,status,
          context_hints,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,?,?,?,'manual','active',?,?,?,?,?)`,
          )
          .run(
            itemId,
            child?.parentId ?? null,
            input.summary,
            input.intent,
            input.rationale,
            JSON.stringify(input.acceptanceCriteria),
            JSON.stringify({ session_ids: [sessionId] }),
            now,
            now,
            now,
            now,
          );
        if (kind)
          this.db
            .prepare('INSERT INTO telos_work_kinds(item_id,kind) VALUES(?,?)')
            .run(itemId, kind);
        this.db
          .prepare(
            "INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,NULL,'active',?)",
          )
          .run(itemId, now);
        if (child)
          this.db.prepare('UPDATE items SET updated_at=? WHERE id=?').run(now, child.parentId);
        this.db
          .prepare(
            `INSERT INTO telos_item_updates
          (item_id,session_id,request_id,input_hash,note,old_status,new_status,created_at,receipt)
          VALUES(?,?,?,?,?,'active','active',?,'{}')`,
          )
          .run(itemId, sessionId, input.requestId, inputHash, input.note, now);
        const item = this.snapshot(itemId, true);
        return {
          item,
          update: item.updates[0],
          ...(child ? { parentRevision: this.snapshot(child.parentId, true).revision } : {}),
        };
      },
    );
  }

  private ensureUpdates() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS telos_item_updates (
      seq INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
      session_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      note TEXT NOT NULL, old_status TEXT NOT NULL, new_status TEXT NOT NULL,
      created_at TEXT NOT NULL, receipt TEXT NOT NULL,
      UNIQUE(session_id,request_id));
      CREATE INDEX IF NOT EXISTS telos_item_updates_item ON telos_item_updates(item_id,seq);`);
  }
  editGuarded(
    raw: TelosEditItemInput,
    sessionId: string,
    assertion: () => void,
    beforeApply?: () => void,
  ) {
    if (typeof assertion !== 'function') throw Error('Synchronous Telos item authority required');
    if (this.db.inTransaction) throw Error('Original Telos item writer required');
    const input = TelosEditItemInputSchema.parse(raw);
    return this.mutate(input, sessionId, assertion, beforeApply, input);
  }

  /** Repair an unclassified backlog item without changing retained role context.
   * Classification shares the canonical edit transaction and replay receipt. */
  private classifyUnassigned(itemId: string, level: NonNullable<TelosEditItemInput['workLevel']>) {
    const kind = { outcome: 'coordinator', feature: 'outcome', slice: 'work_item' }[level];
    const existing = this.workKind(itemId);
    if (existing === kind) return;
    if (existing)
      throw Error(
        'Telos work level is already classified; existing roles and history require a reviewed migration',
      );
    for (const [table, condition] of [
      ['telos_work_assignments', 'item_id=?'],
      ['telos_work_attempts', 'item_id=?'],
      ['telos_work_links', "item_id=? AND role IN ('lead','worker')"],
      [
        'telos_work_role_setups',
        "json_extract(intent,'$.input.itemId')=? AND json_extract(intent,'$.input.role') IN ('lead','worker')",
      ],
    ]) {
      if (
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
        this.db.prepare(`SELECT 1 FROM ${table} WHERE ${condition} LIMIT 1`).get(itemId)
      )
        throw Error(
          'Telos work level cannot change after lead or worker setup; preserve the original attempt',
        );
    }
    const row = this.db.prepare('SELECT parent_id FROM items WHERE id=?').get(itemId) as {
      parent_id: string | null;
    };
    const parentKind = row.parent_id ? this.workKind(row.parent_id) : null;
    if (
      (level === 'outcome' && row.parent_id !== null) ||
      (level === 'feature' && row.parent_id !== null && parentKind !== 'coordinator') ||
      (level === 'slice' && parentKind !== 'outcome')
    )
      throw Error(
        'Telos work level does not match its parent; classify the outcome and feature first',
      );
    if (
      level === 'slice' &&
      this.db.prepare('SELECT 1 FROM items WHERE parent_id=? LIMIT 1').get(itemId)
    )
      throw Error('Telos work level slice cannot contain child work');
    initializeTelosWorkKinds(this.db);
    if (
      level === 'outcome' &&
      this.db
        .prepare(
          "SELECT 1 FROM items i JOIN telos_work_kinds k ON k.item_id=i.id WHERE i.parent_id=? AND k.kind='work_item' LIMIT 1",
        )
        .get(itemId)
    )
      throw Error('Telos work level outcome requires feature children');
    this.db.prepare('INSERT INTO telos_work_kinds(item_id,kind) VALUES(?,?)').run(itemId, kind);
  }

  /** The original canonical owner keeps the outer writer and receipt ordering. */
  updateGuarded(
    input: TelosItemUpdateInput,
    sessionId: string,
    assertion: () => void,
    beforeApply?: () => void,
  ) {
    if (typeof assertion !== 'function') throw Error('Synchronous Telos item authority required');
    if (this.db.inTransaction) throw Error('Original Telos item writer required');
    return this.mutate(input, sessionId, assertion, beforeApply);
  }

  private mutate(
    input: TelosItemUpdateInput,
    sessionId: string,
    assertion?: () => void,
    beforeApply?: () => void,
    edit?: TelosEditItemInput,
  ) {
    if (!sessionId || !input.note.trim()) throw new Error('Session and evidence note required');
    return this.writeWithReceipt(
      sessionId,
      input.requestId,
      edit ? { operation: 'edit', input } : input,
      assertion,
      (inputHash, updatesExist) => {
        const before = this.snapshot(input.itemId, updatesExist);
        if (before.revision !== input.expectedRevision)
          throw retainCallbackOutcome(
            Error('Telos item changed; read it again before updating'),
            'settled',
          );
        if (input.status === 'completed') {
          const unfinished = this.db
            .prepare(
              `WITH RECURSIVE descendants(id,status) AS (
          SELECT id,status FROM items WHERE parent_id=?
          UNION SELECT i.id,i.status FROM items i JOIN descendants d ON i.parent_id=d.id
        ) SELECT id FROM descendants WHERE status!='completed' LIMIT 1`,
            )
            .get(input.itemId);
          if (unfinished)
            throw retainCallbackOutcome(
              Error('Unfinished milestones; complete them before the parent'),
              'settled',
            );
        }
        // No authority callback runs after a status/history/receipt effect.
        assertCurrent(assertion);
        // Fresh-effect eligibility must not hide a known committed receipt.
        assertCurrent(beforeApply);
        if (!updatesExist) this.ensureUpdates();
        if (edit?.workLevel) this.classifyUnassigned(input.itemId, edit.workLevel);
        const status = input.status ?? before.status;
        const now = new Date().toISOString();
        if (edit)
          this.db
            .prepare(
              'UPDATE items SET summary=?,intent=?,rationale=?,acceptance_criteria=? WHERE id=?',
            )
            .run(
              edit.summary ?? before.summary,
              edit.intent ?? before.intent,
              edit.rationale ?? before.rationale,
              JSON.stringify(edit.acceptanceCriteria ?? before.acceptanceCriteria),
              input.itemId,
            );
        this.db
          .prepare(
            `UPDATE items SET status=?,updated_at=?,
        snoozed_until=CASE WHEN ?='snoozed' THEN snoozed_until ELSE NULL END WHERE id=?`,
          )
          .run(status, now, status, input.itemId);
        if (status !== before.status)
          this.db
            .prepare(
              'INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,?,?,?)',
            )
            .run(input.itemId, before.status, status, now);
        this.db
          .prepare(
            `INSERT INTO telos_item_updates
        (item_id,session_id,request_id,input_hash,note,old_status,new_status,created_at,receipt)
        VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            input.itemId,
            sessionId,
            input.requestId,
            inputHash,
            input.note,
            before.status,
            status,
            now,
            '{}',
          );
        const item = this.snapshot(input.itemId, true);
        return { item, update: item.updates[0] };
      },
    );
  }
}
export type TelosItemUpdateReceipt = {
  item: ReturnType<TelosItemStore['read']>;
  update: ReturnType<TelosItemStore['read']>['updates'][number];
};
export type TelosChildCreationReceipt = TelosItemUpdateReceipt & { parentRevision: string };
