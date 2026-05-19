import Database from 'better-sqlite3';
import type {
  MitzoMode,
  StoredEvent,
  SessionMeta,
  SessionSearchResult,
  EventStoreLogger,
} from './types.js';

// Re-export types for consumer convenience
export type { StoredEvent, SessionMeta, SessionSearchResult, EventStoreLogger };

const noopLogger: EventStoreLogger = { info() {} };

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
  telos_task_id: string | null;
  closed_by: string | null;
  last_speaker: string | null;
  last_speaker_at: number | null;
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
  private log: EventStoreLogger;
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
    updateLastSpeaker: Database.Statement;
    getAttentionSessions: Database.Statement;
  };

  constructor(dbPath: string, logger?: EventStoreLogger) {
    this.log = logger ?? noopLogger;
    const db = new Database(dbPath);
    this.db = db;

    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);

    this.migratePromptTracking(db);
    this.migrateUsageTracking(db);
    this.migrateWorktreeTracking(db);
    this.migrateCloseTracking(db);
    this.migrateAttentionTracking(db);

    this.log.info('EventStore initialized', { dbPath });

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
      updateLastSpeaker: db.prepare(
        `UPDATE sessions SET
          last_speaker = ?,
          last_speaker_at = unixepoch('now', 'subsec') * 1000,
          updated_at = unixepoch('now', 'subsec') * 1000
        WHERE session_id = ?`,
      ),
      getAttentionSessions: db.prepare(
        `SELECT * FROM sessions
         WHERE is_hidden = 0
           AND last_speaker = 'assistant'
           AND last_speaker_at > (unixepoch('now', 'subsec') * 1000 - 604800000)
         ORDER BY last_speaker_at DESC
         LIMIT 10`,
      ),
    };
  }

  private migratePromptTracking(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('prompt_count')) {
      db.exec('ALTER TABLE sessions ADD COLUMN prompt_count INTEGER NOT NULL DEFAULT 0');
      this.log.info('migrated sessions table: added prompt_count');
    }
    if (!columnNames.has('manually_renamed')) {
      db.exec('ALTER TABLE sessions ADD COLUMN manually_renamed INTEGER NOT NULL DEFAULT 0');
      this.log.info('migrated sessions table: added manually_renamed');
    }
    if (!columnNames.has('initial_prompt')) {
      db.exec('ALTER TABLE sessions ADD COLUMN initial_prompt TEXT');
      this.log.info('migrated sessions table: added initial_prompt');
    }
  }

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
      ['telos_task_id', 'ALTER TABLE sessions ADD COLUMN telos_task_id TEXT'],
    ];
    for (const [col, sql] of migrations) {
      if (!columnNames.has(col)) {
        db.exec(sql);
        this.log.info(`migrated sessions table: added ${col}`);
      }
    }
  }

  private migrateWorktreeTracking(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('wt_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN wt_id TEXT');
      this.log.info('migrated sessions table: added wt_id');
    }
  }

  /** Adds closed_by column for tracking how a session ended (user close, timeout, error, etc). */
  private migrateCloseTracking(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('closed_by')) {
      db.exec('ALTER TABLE sessions ADD COLUMN closed_by TEXT');
      this.log.info('migrated sessions table: added closed_by');
    }
  }

  private migrateAttentionTracking(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('last_speaker')) {
      db.exec('ALTER TABLE sessions ADD COLUMN last_speaker TEXT');
      this.log.info('migrated sessions table: added last_speaker');
    }
    if (!columnNames.has('last_speaker_at')) {
      db.exec('ALTER TABLE sessions ADD COLUMN last_speaker_at INTEGER');
      this.log.info('migrated sessions table: added last_speaker_at');
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
      if (meta.telosTaskId !== undefined) {
        fields.push('telos_task_id = ?');
        values.push(meta.telosTaskId);
      }
      if (meta.wtId !== undefined) {
        fields.push('wt_id = ?');
        values.push(meta.wtId);
      }
      if (meta.closedBy !== undefined) {
        fields.push('closed_by = ?');
        values.push(meta.closedBy);
      }
      if (meta.updatedAt !== undefined) {
        fields.push('updated_at = ?');
        values.push(meta.updatedAt);
      } else {
        fields.push("updated_at = unixepoch('now', 'subsec') * 1000");
      }
      values.push(meta.sessionId);
      this.db!.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE session_id = ?`).run(
        ...values,
      );
    } else {
      const cols = [
        'session_id',
        'summary',
        'branch',
        'cwd',
        'mode',
        'is_active',
        'initial_prompt',
        'wt_id',
        'goal_id',
        'telos_task_id',
        'closed_by',
      ];
      const vals: unknown[] = [
        meta.sessionId,
        meta.summary ?? null,
        meta.branch ?? null,
        meta.cwd ?? null,
        meta.mode ?? 'agent',
        meta.isActive === false ? 0 : 1,
        meta.initialPrompt ?? null,
        meta.wtId ?? null,
        meta.goalId ?? null,
        meta.telosTaskId ?? null,
        meta.closedBy ?? null,
      ];
      if (meta.updatedAt !== undefined) {
        cols.push('updated_at');
        vals.push(meta.updatedAt);
      }
      if (meta.createdAt !== undefined) {
        cols.push('created_at');
        vals.push(meta.createdAt);
      }
      const placeholders = cols.map(() => '?').join(', ');
      this.db!.prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${placeholders})`).run(
        ...vals,
      );
    }
  }

  getSession(sessionId: string): SessionMeta | null {
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Return the subset of `sessionIds` that already exist in the sessions table.
   * Batches into chunks of 500 to stay within SQLite's SQLITE_MAX_VARIABLE_NUMBER.
   */
  getKnownSessionIds(sessionIds: string[]): Set<string> {
    if (sessionIds.length === 0) return new Set();
    const CHUNK = 500;
    const result = new Set<string>();
    for (let i = 0; i < sessionIds.length; i += CHUNK) {
      const chunk = sessionIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db!.prepare(
        `SELECT session_id FROM sessions WHERE session_id IN (${placeholders})`,
      ).all(...chunk) as Array<{ session_id: string }>;
      for (const r of rows) result.add(r.session_id);
    }
    return result;
  }

  listSessions(limit?: number): SessionMeta[] {
    const rows =
      limit != null ? this.stmts.listSessionsLimited.all(limit) : this.stmts.listSessions.all();
    return (rows as SessionRow[]).map(rowToSession);
  }

  /**
   * Search session content for a query string.
   * Searches user messages and assistant text deltas, returns matching sessions
   * with a snippet of the matched content.
   */
  searchSessions(query: string, limit = 20): SessionSearchResult[] {
    if (!query.trim()) return [];
    const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    const rows = this.db!.prepare(
      `SELECT
        e.session_id,
        s.summary,
        e.payload,
        e.created_at AS matched_at,
        s.updated_at
      FROM events e
      JOIN sessions s ON s.session_id = e.session_id
      WHERE s.is_hidden = 0
        AND e.type IN ('user_message', 'block_delta')
        AND (
          json_extract(e.payload, '$.text') LIKE ? ESCAPE '\\'
          OR json_extract(e.payload, '$.delta') LIKE ? ESCAPE '\\'
        )
      ORDER BY e.created_at DESC
      LIMIT ?`,
    ).all(pattern, pattern, limit * 3) as Array<{
      session_id: string;
      summary: string | null;
      payload: string;
      matched_at: number;
      updated_at: number;
    }>;

    // Deduplicate by session, keep first (most recent) match per session
    const seen = new Set<string>();
    const results: SessionSearchResult[] = [];
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);

      // Extract snippet from payload
      const snippet = extractSnippet(row.payload, query);
      results.push({
        sessionId: row.session_id,
        summary: row.summary,
        snippet,
        matchedAt: row.matched_at,
        updatedAt: row.updated_at,
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  markSessionInactive(sessionId: string): void {
    this.stmts.markInactive.run(sessionId);
  }

  hideSession(sessionId: string): void {
    this.stmts.hide.run(sessionId);
  }

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

  markManuallyRenamed(sessionId: string): void {
    this.db!.prepare(
      "UPDATE sessions SET manually_renamed = 1, updated_at = unixepoch('now', 'subsec') * 1000 WHERE session_id = ?",
    ).run(sessionId);
  }

  updateLastSpeaker(sessionId: string, speaker: 'user' | 'assistant'): void {
    this.stmts.updateLastSpeaker.run(speaker, sessionId);
  }

  getAttentionSessions(): SessionMeta[] {
    const rows = this.stmts.getAttentionSessions.all();
    return (rows as SessionRow[]).map(rowToSession);
  }

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

/** Extract a text snippet around the query match from a JSON payload string. */
function extractSnippet(payloadStr: string, query: string, contextChars = 80): string {
  // Try to pull the text/delta field from the payload
  let text: string;
  try {
    const payload = JSON.parse(payloadStr);
    text = (payload.text ?? payload.delta ?? '') as string;
  } catch {
    text = payloadStr;
  }
  if (!text) return '';

  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, contextChars * 2);

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

function rowToSession(row: SessionRow): SessionMeta {
  return {
    sessionId: row.session_id,
    summary: row.summary,
    branch: row.branch,
    cwd: row.cwd,
    mode: row.mode as MitzoMode,
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
    telosTaskId: row.telos_task_id ?? null,
    closedBy: (row.closed_by as SessionMeta['closedBy']) ?? null,
    lastSpeaker: (row.last_speaker as SessionMeta['lastSpeaker']) ?? null,
    lastSpeakerAt: row.last_speaker_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
