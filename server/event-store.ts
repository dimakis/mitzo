import Database from 'better-sqlite3';
import { createLogger } from './logger.js';

const log = createLogger('event-store');

export interface StoredEvent {
  seq: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface SessionMeta {
  sessionId: string;
  summary: string | null;
  branch: string | null;
  cwd: string | null;
  mode: string;
  isActive: boolean;
  isHidden: boolean;
  promptCount: number;
  manuallyRenamed: boolean;
  initialPrompt: string | null;
  wtId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  goalId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EventRow {
  seq: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: number;
}

interface SessionRow {
  session_id: string;
  summary: string | null;
  branch: string | null;
  cwd: string | null;
  mode: string;
  is_active: number;
  is_hidden: number;
  prompt_count: number;
  manually_renamed: number;
  initial_prompt: string | null;
  wt_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  goal_id: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq);

  CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    summary     TEXT,
    branch      TEXT,
    cwd         TEXT,
    mode        TEXT NOT NULL DEFAULT 'agent',
    is_active   INTEGER NOT NULL DEFAULT 1,
    is_hidden   INTEGER NOT NULL DEFAULT 0,
    prompt_count     INTEGER NOT NULL DEFAULT 0,
    manually_renamed INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
  );
`;

export class EventStore {
  private db: Database.Database | null;
  private stmts: {
    append: Database.Statement;
    eventsAfter: Database.Statement;
    eventsAfterLimited: Database.Statement;
    sessionEvents: Database.Statement;
    getSession: Database.Statement;
    listSessions: Database.Statement;
    listSessionsLimited: Database.Statement;
    markInactive: Database.Statement;
    hide: Database.Statement;
    recordUsage: Database.Statement;
  };

  constructor(dbPath: string) {
    const db = new Database(dbPath);
    this.db = db;

    // WAL mode for concurrent reads during writes
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);

    // Migrate existing databases that lack the new columns
    this.migratePromptTracking(db);
    this.migrateUsageTracking(db);
    this.migrateWorktreeTracking(db);

    this.stmts = {
      append: db.prepare('INSERT INTO events (session_id, type, payload) VALUES (?, ?, ?)'),
      eventsAfter: db.prepare(
        'SELECT seq, session_id, type, payload, created_at FROM events WHERE session_id = ? AND seq > ? ORDER BY seq',
      ),
      eventsAfterLimited: db.prepare(
        'SELECT seq, session_id, type, payload, created_at FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      ),
      sessionEvents: db.prepare(
        'SELECT seq, session_id, type, payload, created_at FROM events WHERE session_id = ? ORDER BY seq',
      ),
      getSession: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
      listSessions: db.prepare(
        'SELECT * FROM sessions WHERE is_hidden = 0 ORDER BY updated_at DESC',
      ),
      listSessionsLimited: db.prepare(
        'SELECT * FROM sessions WHERE is_hidden = 0 ORDER BY updated_at DESC LIMIT ?',
      ),
      markInactive: db.prepare(
        "UPDATE sessions SET is_active = 0, updated_at = unixepoch('now', 'subsec') * 1000 WHERE session_id = ?",
      ),
      hide: db.prepare(
        "UPDATE sessions SET is_hidden = 1, updated_at = unixepoch('now', 'subsec') * 1000 WHERE session_id = ?",
      ),
      recordUsage: db.prepare(
        `UPDATE sessions SET
          input_tokens = ?,
          output_tokens = ?,
          cache_read_tokens = ?,
          cache_creation_tokens = ?,
          total_cost_usd = ?,
          num_turns = ?,
          duration_ms = ?,
          duration_api_ms = ?,
          updated_at = unixepoch('now', 'subsec') * 1000
        WHERE session_id = ?`,
      ),
    };

    log.info('EventStore initialized', { dbPath });
  }

  /** Add prompt_count, manually_renamed, and initial_prompt columns if they don't exist yet. */
  private migratePromptTracking(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('prompt_count')) {
      db.exec('ALTER TABLE sessions ADD COLUMN prompt_count INTEGER NOT NULL DEFAULT 0');
      log.info('migrated sessions table: added prompt_count');
    }
    if (!columnNames.has('manually_renamed')) {
      db.exec('ALTER TABLE sessions ADD COLUMN manually_renamed INTEGER NOT NULL DEFAULT 0');
      log.info('migrated sessions table: added manually_renamed');
    }
    if (!columnNames.has('initial_prompt')) {
      db.exec('ALTER TABLE sessions ADD COLUMN initial_prompt TEXT');
      log.info('migrated sessions table: added initial_prompt');
    }
  }

  /** Add usage tracking columns if they don't exist yet. */
  private migrateUsageTracking(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    const migrations: Array<[string, string]> = [
      ['input_tokens', 'ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0'],
      ['output_tokens', 'ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0'],
      [
        'cache_read_tokens',
        'ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0',
      ],
      [
        'cache_creation_tokens',
        'ALTER TABLE sessions ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0',
      ],
      ['total_cost_usd', 'ALTER TABLE sessions ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0'],
      ['num_turns', 'ALTER TABLE sessions ADD COLUMN num_turns INTEGER NOT NULL DEFAULT 0'],
      ['duration_ms', 'ALTER TABLE sessions ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0'],
      [
        'duration_api_ms',
        'ALTER TABLE sessions ADD COLUMN duration_api_ms INTEGER NOT NULL DEFAULT 0',
      ],
      ['goal_id', 'ALTER TABLE sessions ADD COLUMN goal_id TEXT'],
    ];
    for (const [col, sql] of migrations) {
      if (!columnNames.has(col)) {
        db.exec(sql);
        log.info(`migrated sessions table: added ${col}`);
      }
    }
  }

  /** Add worktree tracking column if it doesn't exist yet. */
  private migrateWorktreeTracking(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('wt_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN wt_id TEXT');
      log.info('migrated sessions table: added wt_id');
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  append(sessionId: string, type: string, payload: Record<string, unknown>): number {
    const result = this.stmts.append.run(sessionId, type, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  getEventsAfter(sessionId: string, afterSeq: number, limit?: number): StoredEvent[] {
    const rows =
      limit != null
        ? this.stmts.eventsAfterLimited.all(sessionId, afterSeq, limit)
        : this.stmts.eventsAfter.all(sessionId, afterSeq);
    return (rows as EventRow[]).map(rowToEvent);
  }

  getSessionEvents(sessionId: string): StoredEvent[] {
    const rows = this.stmts.sessionEvents.all(sessionId);
    return (rows as EventRow[]).map(rowToEvent);
  }

  upsertSession(meta: Partial<SessionMeta> & { sessionId: string }): void {
    const existing = this.getSession(meta.sessionId);
    if (existing) {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (meta.summary !== undefined) {
        fields.push('summary = ?');
        values.push(meta.summary);
      }
      if (meta.branch !== undefined) {
        fields.push('branch = ?');
        values.push(meta.branch);
      }
      if (meta.cwd !== undefined) {
        fields.push('cwd = ?');
        values.push(meta.cwd);
      }
      if (meta.mode !== undefined) {
        fields.push('mode = ?');
        values.push(meta.mode);
      }
      if (meta.isActive !== undefined) {
        fields.push('is_active = ?');
        values.push(meta.isActive ? 1 : 0);
      }
      if (meta.initialPrompt !== undefined) {
        fields.push('initial_prompt = ?');
        values.push(meta.initialPrompt);
      }
      if (meta.goalId !== undefined) {
        fields.push('goal_id = ?');
        values.push(meta.goalId);
      }
      if (meta.wtId !== undefined) {
        fields.push('wt_id = ?');
        values.push(meta.wtId);
      }
      fields.push("updated_at = unixepoch('now', 'subsec') * 1000");
      values.push(meta.sessionId);
      this.db!.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE session_id = ?`).run(
        ...values,
      );
    } else {
      this.db!.prepare(
        'INSERT INTO sessions (session_id, summary, branch, cwd, mode, initial_prompt, wt_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        meta.sessionId,
        meta.summary ?? null,
        meta.branch ?? null,
        meta.cwd ?? null,
        meta.mode ?? 'agent',
        meta.initialPrompt ?? null,
        meta.wtId ?? null,
      );
    }
  }

  getSession(sessionId: string): SessionMeta | null {
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  listSessions(limit?: number): SessionMeta[] {
    const rows =
      limit != null ? this.stmts.listSessionsLimited.all(limit) : this.stmts.listSessions.all();
    return (rows as SessionRow[]).map(rowToSession);
  }

  markSessionInactive(sessionId: string): void {
    this.stmts.markInactive.run(sessionId);
  }

  hideSession(sessionId: string): void {
    this.stmts.hide.run(sessionId);
  }

  /**
   * Increment prompt_count for a session and return the new count.
   * Creates the session row if it doesn't exist.
   */
  incrementPromptCount(sessionId: string): number {
    const existing = this.getSession(sessionId);
    if (!existing) {
      this.db!.prepare('INSERT INTO sessions (session_id, prompt_count) VALUES (?, 1)').run(
        sessionId,
      );
      return 1;
    }
    this.db!.prepare(
      "UPDATE sessions SET prompt_count = prompt_count + 1, updated_at = unixepoch('now', 'subsec') * 1000 WHERE session_id = ?",
    ).run(sessionId);
    return existing.promptCount + 1;
  }

  /**
   * Mark a session as manually renamed (disables auto-rename).
   */
  markManuallyRenamed(sessionId: string): void {
    this.db!.prepare(
      "UPDATE sessions SET manually_renamed = 1, updated_at = unixepoch('now', 'subsec') * 1000 WHERE session_id = ?",
    ).run(sessionId);
  }

  /**
   * Record token usage and timing data for a session.
   * Overwrites any previous usage data (final totals from SDK result event).
   */
  recordUsage(
    sessionId: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      totalCostUsd: number;
      numTurns: number;
      durationMs: number;
      durationApiMs: number;
    },
  ): void {
    this.stmts.recordUsage.run(
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      usage.totalCostUsd,
      usage.numTurns,
      usage.durationMs,
      usage.durationApiMs,
      sessionId,
    );
  }
}

function rowToEvent(row: EventRow): StoredEvent {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    type: row.type,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

function rowToSession(row: SessionRow): SessionMeta {
  return {
    sessionId: row.session_id,
    summary: row.summary,
    branch: row.branch,
    cwd: row.cwd,
    mode: row.mode,
    isActive: row.is_active === 1,
    isHidden: row.is_hidden === 1,
    promptCount: row.prompt_count ?? 0,
    manuallyRenamed: (row.manually_renamed ?? 0) === 1,
    initialPrompt: row.initial_prompt ?? null,
    wtId: row.wt_id ?? null,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
    totalCostUsd: row.total_cost_usd ?? 0,
    numTurns: row.num_turns ?? 0,
    durationMs: row.duration_ms ?? 0,
    durationApiMs: row.duration_api_ms ?? 0,
    goalId: row.goal_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
