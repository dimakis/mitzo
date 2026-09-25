import Database from 'better-sqlite3';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { AccountBinding } from '@mitzo/protocol';
import { z } from 'zod';
import type { PersistedWebSearchGrant, WebSearchGrant } from './web-search-policy.js';

const CommandInput = z
  .object({
    id: z.string().min(1).max(200),
    prompt: z.string().min(1).max(1_000_000),
    // Raw user-authored intent is retained separately from the provider prompt,
    // which may contain context files or rendered skill instructions.
    intent: z.string().max(1_000_000).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).max(32).nullable().optional(),
    images: z
      .array(
        z
          .object({
            data: z
              .string()
              .min(1)
              .max(14_000_000)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
            mediaType: z
              .string()
              .refine(
                (value) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value),
                'Unsupported image type',
              ),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    allowedTools: z.array(z.string()).optional(),
  })
  .strict();
const WebSearchGrantSchema = z.enum(['unresolved', 'denied', 'allowed']);
export type CodexCommandInput = z.infer<typeof CommandInput>;
export type CodexCommand = CodexCommandInput & {
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled';
  attempt: number;
};

/**
 * `intent` was added after command rows were already durable. Compare it for
 * modern rows, but omit it from both sides when a historical row truly lacks
 * the field. Its old provider prompt may be rendered/context-expanded, so it
 * cannot reconstruct raw intent safely. Do not rewrite the row: a missing
 * historical intent must still remain conservative at turn preflight.
 */
function idempotencyInput(input: CodexCommandInput, includeIntent: boolean): string {
  return JSON.stringify({
    id: input.id,
    prompt: input.prompt,
    ...(includeIntent ? { intent: input.intent } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.images !== undefined ? { images: input.images } : {}),
    ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
  });
}

interface Conversation {
  conversationId: string;
  cwd: string;
  threadId: string | null;
  threadGeneration: number;
  lastCompletedTurnId: string | null;
  recovery: number;
  recoveryStrategy: 'resume' | 'fork';
  webSearchGrant: WebSearchGrant;
  webSearchGrantRevision: number;
  webSearchGrantUpdatedAt: number | null;
  toolSurfaceRevision: string | null;
  rolloverContext: string | null;
}
/** Private server-owned database. A single owning server calls recoverAtStartup before accepting work. */
export class CodexConversationStore {
  private db: Database.Database;
  constructor(path: string) {
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_conversations (
      id TEXT PRIMARY KEY, binding TEXT NOT NULL, cwd TEXT NOT NULL, thread_id TEXT,
      thread_generation INTEGER NOT NULL DEFAULT 0,
      recovery INTEGER NOT NULL DEFAULT 0,
      recovery_strategy TEXT NOT NULL DEFAULT 'resume',
      web_search_grant TEXT NOT NULL DEFAULT 'unresolved',
      web_search_grant_revision INTEGER NOT NULL DEFAULT 0,
      web_search_grant_updated_at INTEGER,
      tool_surface_revision TEXT,
      rollover_context TEXT);
      CREATE TABLE IF NOT EXISTS codex_commands (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),
        id TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
        recovery_acknowledged INTEGER NOT NULL DEFAULT 0, retry_not_before INTEGER,
        retryable INTEGER, ambiguous INTEGER, attempt INTEGER NOT NULL DEFAULT 1,
        UNIQUE(conversation_id,id));
      CREATE TABLE IF NOT EXISTS codex_tools (
        conversation_id TEXT NOT NULL, command_id TEXT NOT NULL, call_id TEXT NOT NULL,
        PRIMARY KEY(conversation_id,call_id),
        FOREIGN KEY(conversation_id,command_id) REFERENCES codex_commands(conversation_id,id));
      CREATE INDEX IF NOT EXISTS codex_commands_queue_status ON codex_commands(conversation_id,status,sequence);`);
    this.db.transaction(() => {
      const conversationColumns = this.db
        .prepare('PRAGMA table_info(codex_conversations)')
        .all() as Array<{ name: string }>;
      if (!conversationColumns.some((column) => column.name === 'thread_generation'))
        this.db.exec(
          'ALTER TABLE codex_conversations ADD COLUMN thread_generation INTEGER NOT NULL DEFAULT 0',
        );
      const addsRecoveryStrategy = !conversationColumns.some(
        (column) => column.name === 'recovery_strategy',
      );
      if (addsRecoveryStrategy)
        this.db.exec(
          "ALTER TABLE codex_conversations ADD COLUMN recovery_strategy TEXT NOT NULL DEFAULT 'resume'",
        );
      if (!conversationColumns.some((column) => column.name === 'web_search_grant'))
        this.db.exec(
          "ALTER TABLE codex_conversations ADD COLUMN web_search_grant TEXT NOT NULL DEFAULT 'unresolved'",
        );
      if (!conversationColumns.some((column) => column.name === 'web_search_grant_revision'))
        this.db.exec(
          'ALTER TABLE codex_conversations ADD COLUMN web_search_grant_revision INTEGER NOT NULL DEFAULT 0',
        );
      if (!conversationColumns.some((column) => column.name === 'web_search_grant_updated_at'))
        this.db.exec(
          'ALTER TABLE codex_conversations ADD COLUMN web_search_grant_updated_at INTEGER',
        );
      if (!conversationColumns.some((column) => column.name === 'tool_surface_revision'))
        this.db.exec('ALTER TABLE codex_conversations ADD COLUMN tool_surface_revision TEXT');
      if (!conversationColumns.some((column) => column.name === 'rollover_context'))
        this.db.exec('ALTER TABLE codex_conversations ADD COLUMN rollover_context TEXT');
      this.db.exec(`CREATE TABLE IF NOT EXISTS codex_thread_generations (
        conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),
        generation INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        parent_thread_id TEXT,
        reason TEXT NOT NULL,
        last_completed_turn_id TEXT,
        created_at INTEGER NOT NULL,
        retired_at INTEGER,
        PRIMARY KEY(conversation_id,generation),
        UNIQUE(conversation_id,thread_id));
        INSERT OR IGNORE INTO codex_thread_generations(
          conversation_id,generation,thread_id,parent_thread_id,reason,created_at)
        SELECT id,thread_generation,thread_id,NULL,'legacy',unixepoch('now') * 1000
        FROM codex_conversations WHERE thread_id IS NOT NULL;`);
      const columns = this.db.prepare('PRAGMA table_info(codex_commands)').all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'recovery_acknowledged')) {
        this.db.exec(
          'ALTER TABLE codex_commands ADD COLUMN recovery_acknowledged INTEGER NOT NULL DEFAULT 0',
        );
        // Before this column existed, a cleared conversation recovery flag was
        // the only durable evidence that its interrupted work was acknowledged.
        // Keep recovery=1 rows conservative because their individual history is
        // ambiguous until the user acknowledges it after this upgrade.
        this.db.exec(`UPDATE codex_commands
          SET recovery_acknowledged=1
          WHERE status IN ('interrupted','failed')
            AND conversation_id IN (SELECT id FROM codex_conversations WHERE recovery=0)`);
      }
      if (!columns.some((column) => column.name === 'retry_not_before'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN retry_not_before INTEGER');
      if (!columns.some((column) => column.name === 'retryable'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN retryable INTEGER');
      if (!columns.some((column) => column.name === 'ambiguous'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN ambiguous INTEGER');
      if (!columns.some((column) => column.name === 'attempt'))
        this.db.exec('ALTER TABLE codex_commands ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1');
      // Legacy recovery rows could not persist a failure class. A failed (not
      // merely interrupted) active command is the conservative signal that the
      // provider thread, rather than only its process transport, needs a new
      // generation before more user intent is admitted.
      if (addsRecoveryStrategy)
        this.db.exec(`UPDATE codex_conversations SET recovery_strategy='fork'
          WHERE recovery=1 AND id IN (
            SELECT conversation_id FROM codex_commands
            WHERE status='failed' AND recovery_acknowledged=0
          )`);
    })();
  }
  private key(b: AccountBinding) {
    return JSON.stringify([b.accountId, b.provider, b.model, b.profileRevision]);
  }
  read(id: string, b: AccountBinding): Conversation {
    const row = this.db
      .prepare(
        `SELECT c.id AS conversationId,c.binding,c.cwd,c.thread_id AS threadId,
          c.thread_generation AS threadGeneration,c.recovery,
          c.recovery_strategy AS recoveryStrategy,
          c.web_search_grant AS webSearchGrant,
          c.web_search_grant_revision AS webSearchGrantRevision,
          c.web_search_grant_updated_at AS webSearchGrantUpdatedAt,
          c.tool_surface_revision AS toolSurfaceRevision,
          c.rollover_context AS rolloverContext,
          g.last_completed_turn_id AS lastCompletedTurnId
        FROM codex_conversations c
        LEFT JOIN codex_thread_generations g
          ON g.conversation_id=c.id AND g.generation=c.thread_generation
        WHERE c.id=?`,
      )
      .get(id) as (Conversation & { binding: string }) | undefined;
    if (!row || row.binding !== this.key(b))
      throw new Error('Codex conversation binding unavailable or changed');
    return {
      conversationId: row.conversationId,
      cwd: row.cwd,
      threadId: row.threadId,
      threadGeneration: row.threadGeneration,
      lastCompletedTurnId: row.lastCompletedTurnId,
      recovery: row.recovery,
      recoveryStrategy: row.recoveryStrategy,
      webSearchGrant: WebSearchGrantSchema.parse(row.webSearchGrant),
      webSearchGrantRevision: row.webSearchGrantRevision,
      webSearchGrantUpdatedAt: row.webSearchGrantUpdatedAt,
      toolSurfaceRevision: row.toolSurfaceRevision,
      rolloverContext: row.rolloverContext,
    };
  }
  readWebSearchGrant(id: string, b: AccountBinding): PersistedWebSearchGrant {
    const row = this.read(id, b);
    return {
      grant: row.webSearchGrant,
      revision: row.webSearchGrantRevision,
      updatedAt: row.webSearchGrantUpdatedAt,
    };
  }
  setWebSearchGrant(
    id: string,
    b: AccountBinding,
    expectedRevision: number,
    grant: Exclude<WebSearchGrant, 'unresolved'>,
    updatedAt = Date.now(),
  ): PersistedWebSearchGrant {
    this.read(id, b);
    const result = this.db
      .prepare(
        `UPDATE codex_conversations
        SET web_search_grant=?,web_search_grant_revision=web_search_grant_revision+1,
          web_search_grant_updated_at=?
        WHERE id=? AND web_search_grant_revision=?`,
      )
      .run(grant, updatedAt, id, expectedRevision);
    if (result.changes !== 1) throw new Error('Web search grant changed concurrently');
    return this.readWebSearchGrant(id, b);
  }
  create(id: string, b: AccountBinding, cwd: string, toolSurfaceRevision: string | null = null) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO codex_conversations(id,binding,cwd,tool_surface_revision) VALUES (?,?,?,?)',
      )
      .run(id, this.key(b), cwd, toolSurfaceRevision);
    if (this.read(id, b).cwd !== cwd) throw new Error('Codex conversation workspace changed');
  }
  bindThread(id: string, b: AccountBinding, threadId: string, toolSurfaceRevision?: string) {
    this.db.transaction(() => {
      const current = this.read(id, b);
      if (!threadId || (current.threadId && current.threadId !== threadId))
        throw new Error('Codex provider thread changed');
      this.db
        .prepare(
          'UPDATE codex_conversations SET thread_id=?,tool_surface_revision=COALESCE(?,tool_surface_revision) WHERE id=?',
        )
        .run(threadId, toolSurfaceRevision ?? null, id);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO codex_thread_generations(
            conversation_id,generation,thread_id,parent_thread_id,reason,created_at)
          VALUES (?,?,?,?,?,?)`,
        )
        .run(id, current.threadGeneration, threadId, null, 'initial', Date.now());
    })();
  }
  replaceThread(
    id: string,
    b: AccountBinding,
    expectedThreadId: string,
    threadId: string,
    reason: 'provider_transport_failure' | 'tool_surface_change',
    lastCompletedTurnId?: string,
    toolSurfaceRevision?: string,
    rolloverContext?: string,
  ) {
    return this.db.transaction(() => {
      const current = this.read(id, b);
      if (!threadId || threadId === expectedThreadId || current.threadId !== expectedThreadId)
        throw new Error('Codex provider thread generation changed');
      const generation = current.threadGeneration + 1;
      const now = Date.now();
      this.db
        .prepare(
          'UPDATE codex_thread_generations SET retired_at=? WHERE conversation_id=? AND generation=?',
        )
        .run(now, id, current.threadGeneration);
      this.db
        .prepare(
          `INSERT INTO codex_thread_generations(
            conversation_id,generation,thread_id,parent_thread_id,reason,
            last_completed_turn_id,created_at)
          VALUES (?,?,?,?,?,?,?)`,
        )
        .run(id, generation, threadId, expectedThreadId, reason, lastCompletedTurnId ?? null, now);
      this.db
        .prepare(
          `UPDATE codex_conversations
          SET thread_id=?,thread_generation=?,tool_surface_revision=COALESCE(?,tool_surface_revision),
            rollover_context=COALESCE(?,rollover_context)
          WHERE id=?`,
        )
        .run(threadId, generation, toolSurfaceRevision ?? null, rolloverContext ?? null, id);
      return generation;
    })();
  }
  clearRolloverContext(id: string, b: AccountBinding, expectedThreadId: string) {
    this.read(id, b);
    this.db
      .prepare('UPDATE codex_conversations SET rollover_context=NULL WHERE id=? AND thread_id=?')
      .run(id, expectedThreadId);
  }
  enqueue(id: string, b: AccountBinding, input: CodexCommandInput): boolean {
    this.read(id, b);
    const data = CommandInput.parse(input);
    const json = JSON.stringify(data);
    const old = this.db
      .prepare('SELECT input FROM codex_commands WHERE conversation_id=? AND id=?')
      .get(id, data.id) as { input: string } | undefined;
    if (old) {
      const stored = JSON.parse(old.input) as Record<string, unknown>;
      const oldInput = CommandInput.parse(stored);
      const includesIntent = Object.hasOwn(stored, 'intent');
      if (idempotencyInput(oldInput, includesIntent) !== idempotencyInput(data, includesIntent))
        throw new Error('Codex message ID reused with different input');
      return false;
    }
    this.db
      .prepare(
        "INSERT INTO codex_commands(conversation_id,id,input,status) VALUES (?,?,?,'queued')",
      )
      .run(id, data.id, json);
    return true;
  }
  commands(id: string, b: AccountBinding): CodexCommand[] {
    this.read(id, b);
    return (
      this.db
        .prepare(
          'SELECT input,status,attempt FROM codex_commands WHERE conversation_id=? ORDER BY sequence',
        )
        .all(id) as { input: string; status: CodexCommand['status']; attempt: number }[]
    ).map((row) => ({
      ...CommandInput.parse(JSON.parse(row.input)),
      status: row.status,
      attempt: row.attempt,
    }));
  }
  /** Polling must not deserialize historical prompts, images, or tool inputs. */
  queueOverview(id: string, b: AccountBinding) {
    this.read(id, b);
    const limit = 100;
    const queued = this.db
      .prepare(
        "SELECT id, substr(json_extract(input, '$.prompt'), 1, 160) AS preview FROM codex_commands WHERE conversation_id=? AND status='queued' ORDER BY sequence LIMIT ?",
      )
      .all(id, limit + 1) as Array<{ id: string; preview: string }>;
    const cancelled = this.db
      .prepare(
        "SELECT id FROM codex_commands WHERE conversation_id=? AND status='cancelled' ORDER BY sequence DESC LIMIT ?",
      )
      .all(id, limit + 1) as Array<{ id: string }>;
    return {
      queued: queued.slice(0, limit),
      cancelledIds: cancelled.slice(0, limit).map((c) => c.id),
      hasMore: queued.length > limit,
    };
  }
  /** Lightweight status for the frequent session metadata poll. It deliberately
   * leaves command JSON in SQLite: full command deserialization can include
   * historical prompts and image payloads. */
  queueSummary(id: string, b: AccountBinding) {
    this.read(id, b);
    const counts = this.db
      .prepare(
        "SELECT SUM(status='queued') AS queued, SUM(status='interrupted' AND recovery_acknowledged=0) AS interrupted, SUM(status='failed' AND recovery_acknowledged=0) AS failed FROM codex_commands WHERE conversation_id=?",
      )
      .get(id) as { queued: number | null; interrupted: number | null; failed: number | null };
    const latest = this.db
      .prepare(
        "SELECT json_extract(input, '$.model') AS model, json_extract(input, '$.reasoningEffort') AS reasoning_effort, json_type(input, '$.reasoningEffort') AS reasoning_effort_type FROM codex_commands WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(id) as
      | {
          model: string | null;
          reasoning_effort: string | null;
          reasoning_effort_type: string | null;
        }
      | undefined;
    const failed = this.db
      .prepare(
        `SELECT retry_not_before,retryable,ambiguous
        FROM codex_commands
        WHERE conversation_id=? AND status='failed' AND recovery_acknowledged=0
        ORDER BY sequence DESC LIMIT 1`,
      )
      .get(id) as
      | {
          retry_not_before: number | null;
          retryable: number | null;
          ambiguous: number | null;
        }
      | undefined;
    return {
      queued: counts.queued ?? 0,
      interrupted: counts.interrupted ?? 0,
      failed: counts.failed ?? 0,
      model: latest?.model ?? b.model,
      // SQLite's json_extract returns null for either an omitted property or
      // an explicit JSON null. json_type keeps the user's explicit reset.
      reasoningEffort:
        latest?.reasoning_effort_type === null ? undefined : latest?.reasoning_effort,
      ...(failed?.retry_not_before ? { retryAvailableAt: failed.retry_not_before } : {}),
      ...(failed ? { retryable: failed.retryable === 1 } : {}),
      ...(failed ? { requiresRetryConfirmation: failed.ambiguous === 1 } : {}),
    };
  }
  /** Lifecycle callers must use this raw snapshot rather than the UI-oriented
   * queue summary, which intentionally degrades errors to an empty result. */
  lifecycleQueue(id: string, b: AccountBinding) {
    const conversation = this.read(id, b);
    const counts = this.db
      .prepare(
        "SELECT SUM(status='queued') AS queued, SUM(status='running') AS running FROM codex_commands WHERE conversation_id=?",
      )
      .get(id) as { queued: number | null; running: number | null };
    return {
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      recovery: !!conversation.recovery,
    };
  }
  /** Retain the command ID so a retried send cannot resurrect cancelled work. */
  cancelQueued(
    id: string,
    b: AccountBinding,
    commandId: string,
  ): 'cancelled' | 'not_queued' | 'not_found' {
    return this.db.transaction(() => {
      this.read(id, b);
      const update = this.db
        .prepare(
          "UPDATE codex_commands SET status='cancelled' WHERE conversation_id=? AND id=? AND status='queued'",
        )
        .run(id, commandId);
      const row = this.db
        .prepare('SELECT status FROM codex_commands WHERE conversation_id=? AND id=?')
        .get(id, commandId) as { status: string } | undefined;
      if (!row) return 'not_found';
      if (row.status !== 'cancelled') return 'not_queued';
      // A retry against an existing cancellation is idempotent, but it must not
      // clear a recovery fence that was retained for another uncertain action.
      if (update.changes === 0) return 'cancelled';
      // Cancellation resolves a recovery fence only when it removes all work
      // and all *unacknowledged* interrupted/failed uncertainty. An earlier
      // recovery acknowledgement is durable per command, so old history does
      // not block cancellation after a later restart.
      const unresolved = this.db
        .prepare(
          "SELECT 1 FROM codex_commands WHERE conversation_id=? AND (status IN ('queued','running') OR (status IN ('interrupted','failed') AND recovery_acknowledged=0)) LIMIT 1",
        )
        .get(id);
      if (!unresolved)
        this.db.prepare('UPDATE codex_conversations SET recovery=0 WHERE id=?').run(id);
      return 'cancelled';
    })();
  }
  /** Provider call IDs do not provide semantic side-effect deduplication. Some
   * provider-native tools also execute outside claimTool(), so every ambiguous
   * turn requires explicit confirmation rather than guessing that it was safe. */
  retryLatestFailed(
    id: string,
    b: AccountBinding,
    now = Date.now(),
    confirmAmbiguous = false,
  ): 'queued' | 'not_found' | 'too_early' | 'not_retryable' | 'confirmation_required' {
    return this.db.transaction(() => {
      this.read(id, b);
      const row = this.db
        .prepare(
          `SELECT id,retry_not_before,retryable,ambiguous
          FROM codex_commands
          WHERE conversation_id=? AND status='failed' AND recovery_acknowledged=0
          ORDER BY sequence DESC LIMIT 1`,
        )
        .get(id) as
        | {
            id: string;
            retry_not_before: number | null;
            retryable: number | null;
            ambiguous: number | null;
          }
        | undefined;
      if (!row) return 'not_found';
      if (row.retryable !== 1) return 'not_retryable';
      if (row.retry_not_before && now < row.retry_not_before) return 'too_early';
      if (row.ambiguous === 1 && !confirmAmbiguous) return 'confirmation_required';
      this.db
        .prepare(
          "UPDATE codex_commands SET status='queued', recovery_acknowledged=1, retry_not_before=NULL, attempt=attempt+1 WHERE conversation_id=? AND id=? AND status='failed'",
        )
        .run(id, row.id);
      return 'queued';
    })();
  }
  claimNext(id: string, b: AccountBinding): CodexCommand | undefined {
    return this.db.transaction(() => {
      if (this.read(id, b).recovery)
        throw new Error('Codex recovery requires explicit acknowledgement');
      const commands = this.commands(id, b);
      if (commands.some((c) => c.status === 'running'))
        throw new Error('Codex conversation already running');
      const next = commands.find((c) => c.status === 'queued');
      if (!next) return;
      this.db
        .prepare("UPDATE codex_commands SET status='running' WHERE conversation_id=? AND id=?")
        .run(id, next.id);
      return { ...next, status: 'running' as const };
    })();
  }
  finish(
    id: string,
    b: AccountBinding,
    commandId: string,
    status: 'completed' | 'interrupted' | 'failed',
    providerTurnId?: string,
  ) {
    this.db.transaction(() => {
      const current = this.read(id, b);
      const updated = this.db
        .prepare(
          "UPDATE codex_commands SET status=?, recovery_acknowledged=0 WHERE conversation_id=? AND id=? AND status='running'",
        )
        .run(status, id, commandId);
      if (updated.changes === 1 && status === 'completed' && providerTurnId)
        this.db
          .prepare(
            `UPDATE codex_thread_generations SET last_completed_turn_id=?
            WHERE conversation_id=? AND generation=?`,
          )
          .run(providerTurnId, id, current.threadGeneration);
      // A started turn can still fail before it establishes context on the
      // replacement thread. Retire the handoff only with a durable completion.
      if (updated.changes === 1 && status === 'completed' && current.threadId)
        this.db
          .prepare(
            'UPDATE codex_conversations SET rollover_context=NULL WHERE id=? AND thread_id=?',
          )
          .run(id, current.threadId);
    })();
  }
  pauseForRecovery(
    id: string,
    b: AccountBinding,
    commandId?: string,
    status: 'interrupted' | 'failed' = 'interrupted',
    recoveryStrategy: 'resume' | 'fork' = 'resume',
    retryNotBefore?: number,
    retryable = true,
    ambiguous = false,
  ) {
    this.db.transaction(() => {
      this.read(id, b);
      const pending = !!this.db
        .prepare(
          "SELECT 1 FROM codex_commands WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1",
        )
        .get(id);
      if (commandId)
        this.db
          .prepare(
            "UPDATE codex_commands SET status=?, recovery_acknowledged=0, retry_not_before=?, retryable=?, ambiguous=? WHERE conversation_id=? AND id=? AND status='running'",
          )
          .run(status, retryNotBefore ?? null, retryable ? 1 : 0, ambiguous ? 1 : 0, id, commandId);
      if (pending)
        this.db
          .prepare(
            `UPDATE codex_conversations SET recovery=1,
              recovery_strategy=CASE
                WHEN recovery_strategy='fork' OR ?='fork' THEN 'fork'
                ELSE 'resume'
              END
            WHERE id=?`,
          )
          .run(recoveryStrategy, id);
    })();
  }
  claimTool(id: string, b: AccountBinding, commandId: string, callId: string): boolean {
    return this.db.transaction(() => {
      this.read(id, b);
      if (
        this.db
          .prepare('SELECT 1 FROM codex_tools WHERE conversation_id=? AND call_id=?')
          .get(id, callId)
      )
        return false;
      if (!this.commands(id, b).some((c) => c.id === commandId && c.status === 'running'))
        throw new Error('Codex command is not running');
      this.db.prepare('INSERT INTO codex_tools VALUES (?,?,?)').run(id, commandId, callId);
      return true;
    })();
  }
  recoverAtStartup() {
    this.db.transaction(() => {
      this.db.exec(
        "UPDATE codex_conversations SET recovery=1 WHERE id IN (SELECT conversation_id FROM codex_commands WHERE status IN ('running','queued'))",
      );
      this.db.exec(
        "UPDATE codex_commands SET status='interrupted', recovery_acknowledged=0 WHERE status='running'",
      );
    })();
  }
  acknowledgeRecovery(id: string, b: AccountBinding) {
    this.db.transaction(() => {
      this.read(id, b);
      this.db
        .prepare(
          "UPDATE codex_commands SET recovery_acknowledged=1 WHERE conversation_id=? AND status IN ('interrupted','failed')",
        )
        .run(id);
      this.db
        .prepare("UPDATE codex_conversations SET recovery=0,recovery_strategy='resume' WHERE id=?")
        .run(id);
    })();
  }
  close() {
    this.db.close();
  }
}
