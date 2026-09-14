import Database from 'better-sqlite3';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { AccountBinding } from '@mitzo/protocol';
import { z } from 'zod';

const CommandInput = z
  .object({
    id: z.string().min(1).max(200),
    prompt: z.string().min(1).max(1_000_000),
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
export type CodexCommandInput = z.infer<typeof CommandInput>;
export type CodexCommand = CodexCommandInput & {
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled';
};
interface Conversation {
  conversationId: string;
  cwd: string;
  threadId: string | null;
  recovery: number;
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
      id TEXT PRIMARY KEY, binding TEXT NOT NULL, cwd TEXT NOT NULL, thread_id TEXT, recovery INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS codex_commands (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),
        id TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
        recovery_acknowledged INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation_id,id));
      CREATE TABLE IF NOT EXISTS codex_tools (
        conversation_id TEXT NOT NULL, command_id TEXT NOT NULL, call_id TEXT NOT NULL,
        PRIMARY KEY(conversation_id,call_id),
        FOREIGN KEY(conversation_id,command_id) REFERENCES codex_commands(conversation_id,id));
      CREATE INDEX IF NOT EXISTS codex_commands_queue_status ON codex_commands(conversation_id,status,sequence);`);
    this.db.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(codex_commands)').all() as Array<{
        name: string;
      }>;
      if (columns.some((column) => column.name === 'recovery_acknowledged')) return;
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
    })();
  }
  private key(b: AccountBinding) {
    return JSON.stringify([b.accountId, b.provider, b.model, b.profileRevision]);
  }
  read(id: string, b: AccountBinding): Conversation {
    const row = this.db
      .prepare(
        'SELECT id AS conversationId,binding,cwd,thread_id AS threadId,recovery FROM codex_conversations WHERE id=?',
      )
      .get(id) as (Conversation & { binding: string }) | undefined;
    if (!row || row.binding !== this.key(b))
      throw new Error('Codex conversation binding unavailable or changed');
    return {
      conversationId: row.conversationId,
      cwd: row.cwd,
      threadId: row.threadId,
      recovery: row.recovery,
    };
  }
  create(id: string, b: AccountBinding, cwd: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO codex_conversations(id,binding,cwd) VALUES (?,?,?)')
      .run(id, this.key(b), cwd);
    if (this.read(id, b).cwd !== cwd) throw new Error('Codex conversation workspace changed');
  }
  bindThread(id: string, b: AccountBinding, threadId: string) {
    const old = this.read(id, b).threadId;
    if (!threadId || (old && old !== threadId)) throw new Error('Codex provider thread changed');
    this.db.prepare('UPDATE codex_conversations SET thread_id=? WHERE id=?').run(threadId, id);
  }
  enqueue(id: string, b: AccountBinding, input: CodexCommandInput): boolean {
    this.read(id, b);
    const data = CommandInput.parse(input);
    const json = JSON.stringify(data);
    const old = this.db
      .prepare('SELECT input FROM codex_commands WHERE conversation_id=? AND id=?')
      .get(id, data.id) as { input: string } | undefined;
    if (old) {
      if (old.input !== json) throw new Error('Codex message ID reused with different input');
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
          'SELECT input,status FROM codex_commands WHERE conversation_id=? ORDER BY sequence',
        )
        .all(id) as { input: string; status: CodexCommand['status'] }[]
    ).map((row) => ({ ...CommandInput.parse(JSON.parse(row.input)), status: row.status }));
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
        "SELECT SUM(status='queued') AS queued, SUM(status IN ('interrupted','failed')) AS interrupted FROM codex_commands WHERE conversation_id=?",
      )
      .get(id) as { queued: number | null; interrupted: number | null };
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
    return {
      queued: counts.queued ?? 0,
      interrupted: counts.interrupted ?? 0,
      model: latest?.model ?? b.model,
      // SQLite's json_extract returns null for either an omitted property or
      // an explicit JSON null. json_type keeps the user's explicit reset.
      reasoningEffort:
        latest?.reasoning_effort_type === null ? undefined : latest?.reasoning_effort,
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
  ) {
    this.read(id, b);
    this.db
      .prepare(
        "UPDATE codex_commands SET status=?, recovery_acknowledged=0 WHERE conversation_id=? AND id=? AND status='running'",
      )
      .run(status, id, commandId);
  }
  pauseForRecovery(
    id: string,
    b: AccountBinding,
    commandId?: string,
    status: 'interrupted' | 'failed' = 'interrupted',
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
            "UPDATE codex_commands SET status=?, recovery_acknowledged=0 WHERE conversation_id=? AND id=? AND status='running'",
          )
          .run(status, id, commandId);
      if (pending) this.db.prepare('UPDATE codex_conversations SET recovery=1 WHERE id=?').run(id);
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
      this.db.prepare('UPDATE codex_conversations SET recovery=0 WHERE id=?').run(id);
    })();
  }
  close() {
    this.db.close();
  }
}
