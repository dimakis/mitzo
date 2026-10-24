import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  TelosWorkLifecycleCommandSchema,
  TelosWorkLifecycleListSchema,
  TelosWorkLifecycleReceiptSchema,
  TelosWorkLifecycleViewSchema,
  TelosWorkIdSchema,
  type TelosWorkLifecycleView,
  type TelosWorkLifecycleReceipt,
  type TelosWorkView,
} from '@mitzo/protocol';
import { TelosWorkControls } from './telos-work-controls.js';
import { TelosWorkError, type TelosWorkActor } from './telos-work-store.js';

type Disposition = TelosWorkLifecycleView['disposition'];
interface State {
  disposition: Disposition;
  restoreDisposition: 'active' | 'archived';
  pauseControlIds: string[];
  generation: number;
}
const initial = (): State => ({
  disposition: 'active',
  restoreDisposition: 'active',
  pauseControlIds: [],
  generation: 0,
});
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const deletionOwnedTables = new Set([
  'items',
  'history',
  'telos_work_lifecycle',
  'telos_work_lifecycle_commands',
  'telos_work_lifecycle_history',
]);
function conflict(message: string): never {
  throw new TelosWorkError('conflict', message);
}
/** JSON custody can escape both item IDs and otherwise plain ASCII references.
 * Decode actual documents without changing their retained bytes. Non-JSON text
 * keeps the original raw scan; unsupported parser failures propagate closed. */
function decodedJsonReferences(raw: string, itemId: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  const pending: unknown[] = [parsed];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (value.includes(itemId)) return true;
    } else if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key.includes(itemId)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

/** Additive metadata in the canonical owner, not a second outcome or scheduler.
 * Archive/trash preserve rows and relationships. Current output can reconcile;
 * only new actions are denied. A pause is the existing scoped control protocol.
 */
export class TelosWorkLifecycle {
  constructor(
    private readonly db: Database.Database,
    private readonly work: (id: string) => TelosWorkView,
    private readonly controls: TelosWorkControls,
  ) {}
  private operator(actor: TelosWorkActor) {
    if (actor.kind !== 'operator' || !actor.id.trim())
      throw new TelosWorkError('unauthorized', 'Interactive operator required');
  }
  private state(id: string): State {
    const row = this.db.prepare('SELECT data FROM telos_work_lifecycle WHERE item_id=?').get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as State) : initial();
  }
  /** Also hashed into work revisions. An ancestor transition invalidates a
   * child's pending command without changing canonical brief/status timestamps. */
  revisionFacts(itemId: string): Array<{ itemId: string; state: State }> {
    const result: Array<{ itemId: string; state: State }> = [];
    const seen = new Set<string>();
    let id: string | null = itemId;
    while (id !== null) {
      if (seen.has(id) || seen.size >= 1000)
        conflict('Lifecycle ancestry unavailable or too large');
      seen.add(id);
      const row = this.db.prepare('SELECT parent_id FROM items WHERE id=?').get(id) as
        { parent_id: string | null } | undefined;
      if (!row) throw new TelosWorkError('not_found', 'Work item not found');
      result.push({ itemId: id, state: this.state(id) });
      id = row.parent_id;
    }
    return result;
  }
  private disposition(itemId: string) {
    const ancestors = this.revisionFacts(itemId);
    const hidden =
      ancestors.find((entry) => entry.state.disposition === 'trashed') ??
      ancestors.find((entry) => entry.state.disposition === 'archived');
    return {
      disposition: ancestors[0].state.disposition,
      effectiveDisposition: hidden?.state.disposition ?? ('active' as Disposition),
      inheritedFrom: hidden && hidden.itemId !== itemId ? hidden.itemId : null,
    };
  }
  assertActive(itemId: string): void {
    const state = this.disposition(itemId);
    if (state.effectiveDisposition !== 'active')
      throw new TelosWorkError(
        'unauthorized',
        `Work is ${state.effectiveDisposition}; restore or unarchive its selected root before new actions`,
      );
  }
  read(itemId: string, actor: TelosWorkActor): TelosWorkLifecycleView {
    this.operator(actor);
    return this.db.transaction(() => {
      const work = this.work(itemId);
      const controls = this.controls
        .inbox(itemId, actor)
        .filter((c) => c.origin === 'operator_pause' && c.stage !== 'released');
      const stage = !controls.length
        ? 'running'
        : controls.every((c) => c.stage === 'applied')
          ? 'applied'
          : controls.every((c) => c.stage === 'acknowledged' || c.stage === 'applied')
            ? 'acknowledged'
            : 'requested';
      const history = (
        this.db
          .prepare('SELECT data FROM telos_work_lifecycle_history WHERE item_id=? ORDER BY seq')
          .all(itemId) as { data: string }[]
      ).map((r) => JSON.parse(r.data));
      return TelosWorkLifecycleViewSchema.parse({
        itemId,
        revision: work.revision,
        ...this.disposition(itemId),
        pause: { stage, controls },
        history,
      });
    })();
  }
  list(raw: unknown, actor: TelosWorkActor): TelosWorkLifecycleView[] {
    this.operator(actor);
    const view = TelosWorkLifecycleListSchema.parse(raw);
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id FROM items ORDER BY id LIMIT 5001').all() as {
        id: string;
      }[];
      if (rows.length > 5000) conflict('Lifecycle list exceeds bounded selection');
      const disposition = { active: 'active', archive: 'archived', trash: 'trashed' }[view];
      return rows
        .filter((r) => this.disposition(r.id).effectiveDisposition === disposition)
        .map((r) => this.read(r.id, actor));
    })();
  }
  /** Read-only host seam for an already-authenticated canonical list. Select
   * only IDs from its original parsed payload; no actor is inferred or granted.
   * This does not expose history, controls, revisions or a new HTTP/tool route. */
  visibilityForCanonicalList(
    raw: unknown,
  ): Array<Pick<TelosWorkLifecycleView, 'itemId' | 'effectiveDisposition'>> {
    const ids = TelosWorkIdSchema.array().max(5000).parse(raw);
    if (new Set(ids).size !== ids.length) conflict('Duplicate canonical list identity');
    return this.db.transaction(() =>
      ids.flatMap((itemId) => {
        // The canonical read can race a separately confirmed permanent deletion.
        // Omit disappeared identities rather than inventing active visibility.
        if (!this.db.prepare('SELECT 1 FROM items WHERE id=?').get(itemId)) return [];
        return [{ itemId, effectiveDisposition: this.disposition(itemId).effectiveDisposition }];
      }),
    )();
  }
  execute(
    raw: unknown,
    actor: TelosWorkActor,
    assertQuiescent?: (itemId: string) => void,
    beforeCommit?: () => void,
  ): TelosWorkLifecycleReceipt {
    this.operator(actor);
    const input = TelosWorkLifecycleCommandSchema.parse(raw);
    const actorId = `operator:${actor.id}`;
    return this.db
      .transaction(() => {
        const fingerprint = digest(input);
        const saved = this.db
          .prepare(
            'SELECT fingerprint,receipt FROM telos_work_lifecycle_commands WHERE actor_id=? AND request_id=?',
          )
          .get(actorId, input.requestId) as { fingerprint: string; receipt: string } | undefined;
        if (saved) {
          if (saved.fingerprint !== fingerprint)
            conflict('Lifecycle request identity reused with different input');
          return TelosWorkLifecycleReceiptSchema.parse(JSON.parse(saved.receipt));
        }
        if (this.work(input.itemId).revision !== input.expectedRevision)
          conflict('Work revision conflict; read current lifecycle before retrying');
        const state = this.state(input.itemId);
        switch (input.operation) {
          case 'pause':
            this.assertActive(input.itemId);
            if (
              state.pauseControlIds.some((id) => this.controls.read(id, actor).stage !== 'released')
            )
              conflict('Outcome already has an operator pause');
            state.pauseControlIds = (
              ['new_worker_dispatch', 'safe_point', 'publication'] as const
            ).map(
              (scope) =>
                this.controls.requestOperatorPause(input.itemId, input.requestId, scope, actor)
                  .controlId,
            );
            break;
          case 'resume':
            this.assertActive(input.itemId);
            if (!state.pauseControlIds.length) conflict('No operator pause to resume');
            for (const controlId of state.pauseControlIds)
              this.controls.release(
                { requestId: digest([input.requestId, controlId]), controlId },
                actor,
              );
            state.pauseControlIds = [];
            break;
          case 'archive':
            if (state.disposition !== 'active') conflict('Only an active item can be archived');
            state.disposition = 'archived';
            break;
          case 'unarchive':
            if (state.disposition !== 'archived')
              conflict('Only an archived item can be unarchived');
            state.disposition = 'active';
            break;
          case 'trash':
            if (state.disposition === 'trashed') conflict('Item is already trashed');
            state.restoreDisposition = state.disposition;
            state.disposition = 'trashed';
            break;
          case 'restore':
            if (state.disposition !== 'trashed') conflict('Only a trashed item can be restored');
            state.disposition = state.restoreDisposition;
            break;
          case 'delete_permanently': {
            if (input.confirmation.itemId !== input.itemId)
              conflict('Exact item confirmation required');
            if (state.disposition !== 'trashed')
              conflict('Permanent deletion requires an explicitly trashed item');
            this.assertUnreferencedLeaf(input.itemId);
            if (!assertQuiescent)
              conflict('Verified host quiescence required for permanent deletion');
            const result: unknown = assertQuiescent(input.itemId);
            if (result !== undefined) {
              void Promise.resolve(result).catch(() => {});
              conflict('Synchronous host quiescence required for permanent deletion');
            }
            this.db
              .prepare('UPDATE telos_work_lifecycle SET purging=1 WHERE item_id=?')
              .run(input.itemId);
            this.db.prepare('DELETE FROM telos_work_lifecycle WHERE item_id=?').run(input.itemId);
            // Only canonical item-owned status history is removable. Every other
            // relationship was checked; no child/file/artifact cascade is allowed.
            if (
              this.db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history'")
                .get()
            )
              this.db.prepare('DELETE FROM history WHERE item_id=?').run(input.itemId);
            this.db.prepare('DELETE FROM items WHERE id=?').run(input.itemId);
            break;
          }
        }
        if (input.operation !== 'delete_permanently') {
          state.generation++;
          this.db
            .prepare(
              'INSERT INTO telos_work_lifecycle(item_id,data) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET data=excluded.data',
            )
            .run(input.itemId, JSON.stringify(state));
        }
        this.db.prepare('INSERT INTO telos_work_lifecycle_history(item_id,data) VALUES(?,?)').run(
          input.itemId,
          JSON.stringify({
            requestId: input.requestId,
            operation: input.operation,
            actorId,
            at: new Date().toISOString(),
          }),
        );
        const receipt = TelosWorkLifecycleReceiptSchema.parse({
          requestId: input.requestId,
          itemId: input.itemId,
          operation: input.operation,
          lifecycle:
            input.operation === 'delete_permanently' ? null : this.read(input.itemId, actor),
        });
        this.db
          .prepare('INSERT INTO telos_work_lifecycle_commands VALUES(?,?,?,?)')
          .run(actorId, input.requestId, fingerprint, JSON.stringify(receipt));
        beforeCommit?.();
        return receipt;
      })
      .immediate();
  }
  private assertUnreferencedLeaf(itemId: string) {
    if (this.db.prepare('SELECT 1 FROM items WHERE parent_id=? LIMIT 1').get(itemId))
      conflict('Permanent deletion refuses child items; no cascade is permitted');
    const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(itemId) as Record<
      string,
      unknown
    >;
    if ((item.context_hints && item.context_hints !== '{}') || item.goal_id || item.idempotency_key)
      conflict('Permanent deletion refuses retained source or work references');
    // Respect every actual schema FK, including extensions added by another
    // owner. Unknown references stay retained rather than guessed disposable.
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (deletionOwnedTables.has(name)) continue;
      const fks = this.db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as {
        table: string;
        from: string;
      }[];
      for (const fk of fks)
        if (
          fk.table === 'items' &&
          this.db
            .prepare(`SELECT 1 FROM ${quote(name)} WHERE ${quote(fk.from)}=? LIMIT 1`)
            .get(itemId)
        )
          conflict('Permanent deletion refuses retained item references');
      // SQLite storage is dynamic: declared JSON/empty/numeric affinities may
      // hold text references. Include generated/hidden columns as well, and
      // exempt only the exact metadata tables owned by this deletion protocol.
      const columns = this.db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all() as {
        name: string;
      }[];
      for (const column of columns) {
        if (
          ['item_id', 'child_item_id', 'coordinator_item_id'].includes(column.name) &&
          this.db
            .prepare(`SELECT 1 FROM ${quote(name)} WHERE ${quote(column.name)}=? LIMIT 1`)
            .get(itemId)
        )
          conflict('Permanent deletion refuses retained item references');
        if (
          this.db
            .prepare(
              `SELECT 1 FROM ${quote(name)} WHERE instr(CAST(${quote(column.name)} AS TEXT),?)>0 LIMIT 1`,
            )
            .get(itemId)
        )
          conflict('Permanent deletion refuses retained source, work or receipt references');
        const rows = this.db
          .prepare(`SELECT CAST(${quote(column.name)} AS TEXT) AS raw FROM ${quote(name)}`)
          .iterate() as Iterable<{ raw: string | null }>;
        for (const row of rows)
          if (typeof row.raw === 'string' && decodedJsonReferences(row.raw, itemId))
            conflict('Permanent deletion refuses retained decoded JSON references');
      }
    }
    const rows = this.db.prepare('SELECT * FROM items WHERE id<>?').all(itemId);
    if (
      rows.some((row) =>
        Object.values(row as Record<string, unknown>).some(
          (v) => typeof v === 'string' && (v.includes(itemId) || decodedJsonReferences(v, itemId)),
        ),
      )
    )
      conflict('Permanent deletion refuses retained graph references');
  }
}
