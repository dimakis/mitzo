import Database from 'better-sqlite3';
import type {
  MitzoMode,
  StoredEvent,
  SessionMeta,
  SessionSearchResult,
  SessionState,
  ClientSessionState,
  EventStoreLogger,
  AccountBinding,
} from './types.js';
import { AccountBindingSchema } from './account-binding.js';
import { SymposiumConfigSchema, SymposiumProvenanceSchema } from './symposium.js';
import type {
  SymposiumAdmissionRecord,
  SymposiumConfig,
  SymposiumDeliveryRecord,
  SymposiumDeliveryRecipient,
  SymposiumRecipientAttemptRecord,
  SymposiumIntervention,
  SymposiumInterventionRecord,
  SymposiumProvenance,
  SymposiumSeatThreadRecord,
} from './symposium.js';

// Re-export types for consumer convenience
export type {
  StoredEvent,
  SessionMeta,
  SessionSearchResult,
  SessionState,
  ClientSessionState,
  EventStoreLogger,
};

/**
 * Map internal 7-state lifecycle to client-facing 3-state.
 * Note: 'requires_action' is never returned here — it is emitted separately
 * by the permission_request handler (Phase 1), not from lifecycle transitions.
 */
export function toClientState(state: SessionState): ClientSessionState {
  switch (state) {
    case 'STARTING':
    case 'ACTIVE':
      return 'running';
    case 'CREATED':
    case 'CLOSING':
    case 'ENDED':
    case 'DETACHED':
    case 'SUSPENDED':
      return 'idle';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

const noopLogger: EventStoreLogger = { info() {} };

interface EventRow {
  seat_id: string | null;
  symposium_provenance: string | null;
  seq: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: number;
}

interface SessionRow {
  session_type: string;
  symposium_config: string | null;
  symposium_revision: number;
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
  state: string | null;
  last_state_change: number | null;
  agent_name: string | null;
  boot_context: string | null;
  account_binding: string | null;
  created_at: number;
  updated_at: number;
}

export interface SendCommandReceipt {
  clientMsgId: string;
  sessionId: string | null;
  payload: Record<string, unknown>;
  error: string | null;
}

type SessionUpsert = Partial<
  Omit<SessionMeta, 'sessionType' | 'symposiumConfig' | 'symposiumRevision'>
> & { sessionId: string };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS send_commands (
    client_msg_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
  );

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

const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ['STARTING', 'ENDED'],
  STARTING: ['ACTIVE', 'ENDED'],
  ACTIVE: ['DETACHED', 'SUSPENDED', 'CLOSING', 'ENDED'],
  DETACHED: ['ACTIVE', 'SUSPENDED', 'CLOSING', 'ENDED'],
  SUSPENDED: ['ACTIVE', 'ENDED'],
  CLOSING: ['ENDED'],
  ENDED: ['CREATED'],
};

export class EventStore {
  private db: Database.Database | null;
  private log: EventStoreLogger;
  private stmts: {
    append: Database.Statement;
    hasUserMessage: Database.Statement;
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
    setSessionState: Database.Statement;
    getSessionState: Database.Statement;
  };

  getSendCommand(clientMsgId: string): SendCommandReceipt | undefined {
    const row = this.db!.prepare('SELECT * FROM send_commands WHERE client_msg_id = ?').get(
      clientMsgId,
    ) as
      | { client_msg_id: string; session_id: string; payload: string; error: string | null }
      | undefined;
    return (
      row && {
        clientMsgId: row.client_msg_id,
        sessionId: row.session_id || null,
        payload: JSON.parse(row.payload),
        error: row.error,
      }
    );
  }

  hasRecentSendCommandForSession(sessionId: string, since: number): boolean {
    return !!this.db!.prepare(
      `SELECT 1 FROM send_commands
         WHERE session_id = ? AND error IS NULL AND created_at >= ?
         LIMIT 1`,
    ).get(sessionId, since);
  }

  /** Synchronous insert before dispatch: retries can never allocate another session. */
  insertSendCommand(
    clientMsgId: string,
    sessionId: string,
    payload: Record<string, unknown>,
  ): void {
    this.db!.prepare(
      'INSERT INTO send_commands (client_msg_id, session_id, payload) VALUES (?, ?, ?)',
    ).run(clientMsgId, sessionId, JSON.stringify(payload));
  }

  completeNativeSendCommand(clientMsgId: string): void {
    this.db!.prepare("UPDATE send_commands SET session_id = '' WHERE client_msg_id = ?").run(
      clientMsgId,
    );
  }

  /** A crash may happen between acceptance and dispatch. Never silently discard
   * that receipt or re-execute a possibly side-effecting command after restart. */
  recoverPendingSendCommands(): void {
    const rows = this.db!.prepare(
      `SELECT client_msg_id, session_id, payload FROM send_commands c
      WHERE error IS NULL AND session_id != '' AND NOT EXISTS (
        SELECT 1 FROM events e WHERE e.session_id = c.session_id AND e.type = 'user_message'
        AND json_extract(e.payload, '$.messageId') = c.client_msg_id
      )`,
    ).all() as Array<{ client_msg_id: string; session_id: string; payload: string }>;
    for (const row of rows) {
      const error =
        'Server restarted before message execution was confirmed. Please check the conversation and retry.';
      this.failSendCommand(row.client_msg_id, error);
      if (!this.getSession(row.session_id)) {
        const payload = JSON.parse(row.payload);
        this.upsertSession({ sessionId: row.session_id, initialPrompt: payload.prompt });
      }
      this.append(row.session_id, 'error', {
        type: 'error',
        v: 2,
        sessionId: row.session_id,
        error,
      });
      this.setSessionState(row.session_id, 'ENDED', { force: true, reason: 'server_restart' });
    }
  }

  failSendCommand(clientMsgId: string, error: string): void {
    this.db!.prepare('UPDATE send_commands SET error = ? WHERE client_msg_id = ?').run(
      error,
      clientMsgId,
    );
  }

  constructor(dbPath: string, logger?: EventStoreLogger) {
    this.log = logger ?? noopLogger;
    const db = new Database(dbPath);
    this.db = db;

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);

    this.migratePromptTracking(db);
    this.migrateUsageTracking(db);
    this.migrateWorktreeTracking(db);
    this.migrateCloseTracking(db);
    this.migrateAttentionTracking(db);
    this.migrateSessionState(db);
    this.migrateBootContext(db);
    this.migrateSymposium(db);
    this.migrateUserMessageIndex(db);

    this.log.info('EventStore initialized', { dbPath });

    this.stmts = {
      append: db.prepare(
        'INSERT INTO events (session_id, type, payload, seat_id, symposium_provenance) VALUES (?, ?, ?, ?, ?)',
      ),
      hasUserMessage: db.prepare(
        `SELECT 1 FROM events
         WHERE session_id = ? AND type = 'user_message'
           AND json_extract(payload, '$.messageId') = ?
         LIMIT 1`,
      ),
      eventsAfter: db.prepare(
        'SELECT seq, session_id, type, payload, created_at, seat_id, symposium_provenance FROM events WHERE session_id = ? AND seq > ? ORDER BY seq',
      ),
      eventsAfterLimited: db.prepare(
        'SELECT seq, session_id, type, payload, created_at, seat_id, symposium_provenance FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      ),
      sessionEvents: db.prepare(
        'SELECT seq, session_id, type, payload, created_at, seat_id, symposium_provenance FROM events WHERE session_id = ? ORDER BY seq',
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
         ORDER BY last_speaker_at DESC
         LIMIT 10`,
      ),
      setSessionState: db.prepare(
        `UPDATE sessions SET
          state = ?,
          last_state_change = ?,
          is_active = ?,
          updated_at = unixepoch('now', 'subsec') * 1000
        WHERE session_id = ?`,
      ),
      getSessionState: db.prepare('SELECT state FROM sessions WHERE session_id = ?'),
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

  /** Scaffolding — column + mapping wired up, callers added when session lifecycle overhaul lands. */
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

  private migrateSessionState(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('state')) {
      db.exec("ALTER TABLE sessions ADD COLUMN state TEXT DEFAULT 'ENDED'");
      this.log.info('migrated sessions table: added state');
    }
    if (!columnNames.has('last_state_change')) {
      db.exec('ALTER TABLE sessions ADD COLUMN last_state_change INTEGER');
      this.log.info('migrated sessions table: added last_state_change');
    }
  }

  private migrateBootContext(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('agent_name')) {
      db.exec('ALTER TABLE sessions ADD COLUMN agent_name TEXT');
      this.log.info('migrated sessions table: added agent_name');
    }
    if (!columnNames.has('account_binding')) {
      db.exec('ALTER TABLE sessions ADD COLUMN account_binding TEXT');
      this.log.info('migrated sessions table: added account_binding');
    }
    if (!columnNames.has('boot_context')) {
      db.exec('ALTER TABLE sessions ADD COLUMN boot_context TEXT');
      this.log.info('migrated sessions table: added boot_context');
    }
  }

  private migrateSymposium(db: Database.Database): void {
    db.transaction(() => {
      const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      if (!names.has('session_type')) {
        db.exec("ALTER TABLE sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'chat'");
      }
      if (!names.has('symposium_config')) {
        db.exec('ALTER TABLE sessions ADD COLUMN symposium_config TEXT');
      }
      if (!names.has('symposium_revision')) {
        db.exec('ALTER TABLE sessions ADD COLUMN symposium_revision INTEGER NOT NULL DEFAULT 0');
      }
      const events = db.prepare("PRAGMA table_info('events')").all() as Array<{ name: string }>;
      if (!events.some((column) => column.name === 'seat_id')) {
        db.exec('ALTER TABLE events ADD COLUMN seat_id TEXT');
      }
      if (!events.some((column) => column.name === 'symposium_provenance')) {
        db.exec('ALTER TABLE events ADD COLUMN symposium_provenance TEXT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS symposium_admissions (
          admission_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seat_id TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('admitted', 'refused')),
          reason TEXT,
          idempotency_key TEXT NOT NULL,
          config_revision INTEGER NOT NULL,
          provider TEXT NOT NULL,
          account_id TEXT NOT NULL,
          model TEXT NOT NULL,
          account_profile_revision TEXT NOT NULL,
          isolation_domain_id TEXT NOT NULL,
          isolation_domain_revision INTEGER NOT NULL,
          decided_at INTEGER NOT NULL,
          UNIQUE (session_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_symposium_admissions_seat
          ON symposium_admissions (session_id, seat_id, config_revision, decided_at);

        CREATE TABLE IF NOT EXISTS symposium_deliveries (
          delivery_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          source_seat_id TEXT,
          recipient_seat_ids TEXT NOT NULL,
          original_content TEXT NOT NULL,
          delivered_content TEXT,
          status TEXT NOT NULL CHECK (status IN (
            'awaiting_intervention', 'ready', 'delivering', 'delivered',
            'dropped', 'failed', 'cancelled', 'recovery_required'
          )),
          intervention TEXT CHECK (intervention IS NULL OR intervention IN (
            'approve', 'edit', 'replace', 'drop', 'retry'
          )),
          intervention_reason TEXT,
          idempotency_key TEXT NOT NULL,
          config_revision INTEGER NOT NULL,
          source_provenance TEXT,
          cancellation_reason TEXT,
          cancellation_idempotency_key TEXT,
          cancelled_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (session_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_symposium_deliveries_session
          ON symposium_deliveries (session_id, created_at, delivery_id);

        CREATE TABLE IF NOT EXISTS symposium_delivery_recipients (
          delivery_id TEXT NOT NULL,
          seat_id TEXT NOT NULL,
          recipient_order INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'pending', 'executing', 'delivered', 'failed', 'cancelled', 'recovery_required'
          )),
          idempotency_key TEXT NOT NULL UNIQUE,
          config_revision INTEGER NOT NULL,
          account_profile_revision TEXT NOT NULL,
          seat_profile_revision TEXT NOT NULL,
          context_grant_id TEXT NOT NULL,
          context_grant_revision INTEGER NOT NULL,
          authority_grant_id TEXT NOT NULL,
          authority_grant_revision INTEGER NOT NULL,
          isolation_domain_id TEXT NOT NULL,
          isolation_domain_revision INTEGER NOT NULL,
          provider_thread_id TEXT,
          result_content TEXT,
          cost_usd REAL NOT NULL DEFAULT 0,
          error TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (delivery_id, seat_id),
          FOREIGN KEY (delivery_id) REFERENCES symposium_deliveries(delivery_id)
        );

        CREATE TABLE IF NOT EXISTS symposium_interventions (
          intervention_id INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('approve', 'edit', 'replace', 'drop', 'retry')),
          content TEXT,
          reason TEXT,
          idempotency_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (delivery_id, idempotency_key),
          FOREIGN KEY (delivery_id) REFERENCES symposium_deliveries(delivery_id)
        );

        CREATE TABLE IF NOT EXISTS symposium_seat_threads (
          session_id TEXT NOT NULL,
          seat_id TEXT NOT NULL,
          binding_key TEXT NOT NULL,
          provider_thread_id TEXT NOT NULL,
          config_revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, seat_id, binding_key)
        );

        CREATE TABLE IF NOT EXISTS symposium_seat_execution_claims (
          session_id TEXT NOT NULL,
          seat_id TEXT NOT NULL,
          binding_key TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          recipient_idempotency_key TEXT NOT NULL,
          claim_token TEXT NOT NULL UNIQUE,
          claimed_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, seat_id, binding_key),
          FOREIGN KEY (delivery_id) REFERENCES symposium_deliveries(delivery_id)
        );
        CREATE INDEX IF NOT EXISTS idx_symposium_seat_execution_claims_delivery
          ON symposium_seat_execution_claims (delivery_id);

        CREATE TABLE IF NOT EXISTS symposium_recipient_attempts (
          attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL,
          seat_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'executing', 'delivered', 'failed', 'cancelled', 'recovery_required'
          )),
          provider_thread_id TEXT,
          result_content TEXT,
          cost_usd REAL NOT NULL DEFAULT 0,
          error TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL,
          UNIQUE (delivery_id, seat_id, attempt_number),
          FOREIGN KEY (delivery_id) REFERENCES symposium_deliveries(delivery_id)
        );
        CREATE INDEX IF NOT EXISTS idx_symposium_recipient_attempts_delivery
          ON symposium_recipient_attempts (delivery_id, seat_id, attempt_number);
      `);
    })();
  }

  private migrateUserMessageIndex(db: Database.Database): void {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_user_msg_dedup
       ON events (session_id, type, json_extract(payload, '$.messageId'))`,
    );
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  append(sessionId: string, type: string, payload: Record<string, unknown>): number {
    const result = this.stmts.append.run(sessionId, type, JSON.stringify(payload), null, null);
    return Number(result.lastInsertRowid);
  }

  /** Persist a seat-attributed event only when its provenance matches the active config. */
  appendSymposium(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
    input: unknown,
  ): number {
    const provenance = SymposiumProvenanceSchema.parse(input);
    return this.db!.transaction(() => {
      const session = this.getSession(sessionId);
      if (session?.sessionType !== 'symposium' || !session.symposiumConfig) {
        throw new Error('Cannot append a Symposium event to an inactive session');
      }
      const config = SymposiumConfigSchema.parse(JSON.parse(session.symposiumConfig));
      if (config.state !== 'active') {
        throw new Error('Cannot append a Symposium event from a draft configuration');
      }
      const seat = config.seats.find((candidate) => candidate.id === provenance.seatId);
      if (!seat) throw new Error('Symposium provenance references an unknown seat');
      if (
        provenance.configRevision !== config.revision ||
        provenance.accountProfileRevision !== seat.accountBinding?.profileRevision ||
        provenance.seatProfileRevision !== seat.profileBinding?.profileRevision ||
        provenance.contextGrantRevision !== seat.contextGrant?.revision ||
        provenance.authorityGrantRevision !== seat.authorityGrant?.revision ||
        provenance.isolationDomainId !== seat.isolationRequest?.trustDomainId ||
        provenance.isolationDomainRevision !== seat.isolationRequest?.revision
      ) {
        throw new Error('Symposium provenance does not match the active seat configuration');
      }
      const result = this.stmts.append.run(
        sessionId,
        type,
        JSON.stringify(payload),
        provenance.seatId,
        JSON.stringify(provenance),
      );
      return Number(result.lastInsertRowid);
    }).immediate();
  }

  /** Check if a user_message with the given messageId already exists for this session. */
  hasUserMessage(sessionId: string, messageId: string): boolean {
    return this.stmts.hasUserMessage.get(sessionId, messageId) != null;
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

  /** Persist a validated draft or activate Symposium on an existing session.
   * Activation is fail-closed: Seat 1 must retain the session's durable account
   * binding and configuration revisions must move forward.
   */
  setSymposiumConfig(sessionId: string, input: unknown): SymposiumConfig {
    const config = SymposiumConfigSchema.parse(input);
    return this.db!.transaction(() => {
      const session = this.getSession(sessionId);
      if (!session) throw new Error('Cannot configure Symposium for an unknown session');

      if (config.state === 'active') {
        const sessionBinding = AccountBindingSchema.safeParse(session.accountBinding);
        const primaryBinding = config.seats[0].accountBinding;
        if (
          !sessionBinding.success ||
          !primaryBinding ||
          !sameBinding(sessionBinding.data, primaryBinding)
        ) {
          throw new Error('Seat 1 must retain the existing session account binding');
        }
      }

      const result = this.db!.prepare(
        `UPDATE sessions SET
          session_type = 'symposium', symposium_config = ?, symposium_revision = ?,
          updated_at = unixepoch('now', 'subsec') * 1000
         WHERE session_id = ? AND symposium_revision < ?`,
      ).run(JSON.stringify(config), config.revision, sessionId, config.revision);
      if (result.changes !== 1) {
        throw new Error('Symposium configuration revision must increase');
      }
      return config;
    }).immediate();
  }

  deactivateSymposium(sessionId: string, expectedRevision: number): void {
    const result = this.db!.prepare(
      `UPDATE sessions SET
          session_type = 'chat', symposium_config = NULL,
          updated_at = unixepoch('now', 'subsec') * 1000
         WHERE session_id = ? AND session_type = 'symposium' AND symposium_revision = ?`,
    ).run(sessionId, expectedRevision);
    if (result.changes !== 1) {
      throw new Error('Symposium deactivation revision conflict');
    }
  }

  getActiveSymposiumConfig(sessionId: string): SymposiumConfig {
    const session = this.getSession(sessionId);
    if (session?.sessionType !== 'symposium' || !session.symposiumConfig) {
      throw new Error('Symposium is not active for this session');
    }
    const config = SymposiumConfigSchema.parse(JSON.parse(session.symposiumConfig));
    if (config.state !== 'active') throw new Error('Symposium configuration is not active');
    return config;
  }

  recordSymposiumAdmission(record: SymposiumAdmissionRecord): SymposiumAdmissionRecord {
    return this.db!.transaction(() => {
      const prior = this.db!.prepare(
        'SELECT * FROM symposium_admissions WHERE session_id = ? AND idempotency_key = ?',
      ).get(record.sessionId, record.idempotencyKey) as Record<string, unknown> | undefined;
      if (prior) {
        const existing = rowToSymposiumAdmission(prior);
        if (
          existing.seatId !== record.seatId ||
          existing.decision !== record.decision ||
          existing.reason !== record.reason ||
          existing.configRevision !== record.configRevision ||
          existing.provider !== record.provider ||
          existing.accountId !== record.accountId ||
          existing.model !== record.model ||
          existing.accountProfileRevision !== record.accountProfileRevision ||
          existing.isolationDomainId !== record.isolationDomainId ||
          existing.isolationDomainRevision !== record.isolationDomainRevision
        ) {
          throw new Error('Symposium admission idempotency key was reused with different input');
        }
        return existing;
      }
      const config = this.getActiveSymposiumConfig(record.sessionId);
      const seat = config.seats.find((candidate) => candidate.id === record.seatId);
      if (
        config.revision !== record.configRevision ||
        !seat?.accountBinding ||
        !seat.isolationRequest ||
        seat.accountBinding.provider !== record.provider ||
        seat.accountBinding.accountId !== record.accountId ||
        seat.accountBinding.model !== record.model ||
        seat.accountBinding.profileRevision !== record.accountProfileRevision ||
        seat.isolationRequest.trustDomainId !== record.isolationDomainId ||
        seat.isolationRequest.revision !== record.isolationDomainRevision
      ) {
        throw new Error('Symposium admission does not match the active seat configuration');
      }
      this.db!.prepare(
        `INSERT INTO symposium_admissions (
          admission_id, session_id, seat_id, decision, reason, idempotency_key,
          config_revision, provider, account_id, model, account_profile_revision,
          isolation_domain_id, isolation_domain_revision, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.admissionId,
        record.sessionId,
        record.seatId,
        record.decision,
        record.reason,
        record.idempotencyKey,
        record.configRevision,
        record.provider,
        record.accountId,
        record.model,
        record.accountProfileRevision,
        record.isolationDomainId,
        record.isolationDomainRevision,
        record.decidedAt,
      );
      return record;
    }).immediate();
  }

  getSymposiumAdmissions(sessionId: string): SymposiumAdmissionRecord[] {
    const rows = this.db!.prepare(
      `SELECT * FROM symposium_admissions
       WHERE session_id = ? ORDER BY decided_at, rowid`,
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToSymposiumAdmission);
  }

  getSymposiumAdmissionByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string,
  ): SymposiumAdmissionRecord | undefined {
    const row = this.db!.prepare(
      `SELECT * FROM symposium_admissions WHERE session_id = ? AND idempotency_key = ?`,
    ).get(sessionId, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? rowToSymposiumAdmission(row) : undefined;
  }

  getLatestSymposiumAdmission(
    sessionId: string,
    seatId: string,
    configRevision: number,
  ): SymposiumAdmissionRecord | undefined {
    const row = this.db!.prepare(
      `SELECT * FROM symposium_admissions
       WHERE session_id = ? AND seat_id = ? AND config_revision = ?
       ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId, seatId, configRevision) as Record<string, unknown> | undefined;
    return row ? rowToSymposiumAdmission(row) : undefined;
  }

  createSymposiumDelivery(record: SymposiumDeliveryRecord): SymposiumDeliveryRecord {
    return this.db!.transaction(() => {
      const prior = this.db!.prepare(
        'SELECT delivery_id FROM symposium_deliveries WHERE session_id = ? AND idempotency_key = ?',
      ).get(record.sessionId, record.idempotencyKey) as { delivery_id: string } | undefined;
      if (prior) {
        const existing = this.getSymposiumDelivery(prior.delivery_id)!;
        if (
          existing.sourceSeatId !== record.sourceSeatId ||
          existing.originalContent !== record.originalContent ||
          JSON.stringify(existing.recipientSeatIds) !== JSON.stringify(record.recipientSeatIds) ||
          existing.configRevision !== record.configRevision ||
          JSON.stringify(existing.sourceProvenance) !== JSON.stringify(record.sourceProvenance) ||
          existing.recipients.some((recipient, index) =>
            recipientSnapshotChanged(recipient, record.recipients[index]),
          )
        ) {
          throw new Error('Symposium delivery idempotency key was reused with different input');
        }
        return existing;
      }
      const config = this.getActiveSymposiumConfig(record.sessionId);
      if (
        config.revision !== record.configRevision ||
        config.turnRules.mode !== 'directed' ||
        config.interceptMode !== 'manual' ||
        record.status !== 'awaiting_intervention' ||
        record.deliveredContent !== null ||
        record.intervention !== null ||
        record.recipientSeatIds.length === 0 ||
        record.recipientSeatIds.length !== record.recipients.length
      ) {
        throw new Error(
          'Symposium delivery does not match the active directed/manual configuration',
        );
      }
      const expectedRecipients = config.seats.filter((seat) =>
        record.recipientSeatIds.includes(seat.id),
      );
      if (
        expectedRecipients.length !== record.recipientSeatIds.length ||
        expectedRecipients.some((seat, index) => seat.id !== record.recipientSeatIds[index])
      ) {
        throw new Error(
          'Symposium delivery recipients are invalid or nondeterministically ordered',
        );
      }
      if (record.sourceSeatId === null) {
        if (record.sourceProvenance !== null) {
          throw new Error('Director-authored delivery cannot claim seat provenance');
        }
      } else {
        const source = config.seats.find((seat) => seat.id === record.sourceSeatId);
        if (
          !source ||
          !record.sourceProvenance ||
          !matchesSeatProvenance(config, source, record.sourceProvenance)
        ) {
          throw new Error('Symposium delivery source provenance does not match its seat');
        }
      }
      record.recipients.forEach((recipient, index) => {
        const seat = expectedRecipients[index];
        if (
          recipient.deliveryId !== record.deliveryId ||
          recipient.seatId !== seat.id ||
          recipient.status !== 'pending' ||
          recipient.idempotencyKey !== `delivery:${record.deliveryId}:seat:${seat.id}` ||
          recipient.configRevision !== config.revision ||
          recipient.accountProfileRevision !== seat.accountBinding?.profileRevision ||
          recipient.seatProfileRevision !== seat.profileBinding?.profileRevision ||
          recipient.contextGrantId !== seat.contextGrant?.grantId ||
          recipient.contextGrantRevision !== seat.contextGrant?.revision ||
          recipient.authorityGrantId !== seat.authorityGrant?.grantId ||
          recipient.authorityGrantRevision !== seat.authorityGrant?.revision ||
          recipient.isolationDomainId !== seat.isolationRequest?.trustDomainId ||
          recipient.isolationDomainRevision !== seat.isolationRequest?.revision
        ) {
          throw new Error('Symposium recipient ledger snapshot does not match its active seat');
        }
      });
      this.db!.prepare(
        `INSERT INTO symposium_deliveries (
          delivery_id, session_id, source_seat_id, recipient_seat_ids, original_content,
          delivered_content, status, intervention, intervention_reason, idempotency_key,
          config_revision, source_provenance, cancellation_reason, cancelled_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.deliveryId,
        record.sessionId,
        record.sourceSeatId,
        JSON.stringify(record.recipientSeatIds),
        record.originalContent,
        record.deliveredContent,
        record.status,
        record.intervention,
        record.interventionReason,
        record.idempotencyKey,
        record.configRevision,
        record.sourceProvenance ? JSON.stringify(record.sourceProvenance) : null,
        record.cancellationReason,
        record.cancelledAt,
        record.createdAt,
        record.updatedAt,
      );
      const insertRecipient = this.db!.prepare(
        `INSERT INTO symposium_delivery_recipients (
          delivery_id, seat_id, recipient_order, status, idempotency_key,
          config_revision, account_profile_revision, seat_profile_revision,
          context_grant_id, context_grant_revision, authority_grant_id,
          authority_grant_revision, isolation_domain_id, isolation_domain_revision,
          provider_thread_id, result_content, cost_usd, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      record.recipients.forEach((recipient, index) =>
        insertRecipient.run(
          record.deliveryId,
          recipient.seatId,
          index,
          recipient.status,
          recipient.idempotencyKey,
          recipient.configRevision,
          recipient.accountProfileRevision,
          recipient.seatProfileRevision,
          recipient.contextGrantId,
          recipient.contextGrantRevision,
          recipient.authorityGrantId,
          recipient.authorityGrantRevision,
          recipient.isolationDomainId,
          recipient.isolationDomainRevision,
          recipient.providerThreadId,
          recipient.resultContent,
          recipient.costUsd,
          recipient.error,
          recipient.updatedAt,
        ),
      );
      return this.getSymposiumDelivery(record.deliveryId)!;
    }).immediate();
  }

  getSymposiumDelivery(deliveryId: string): SymposiumDeliveryRecord | undefined {
    const row = this.db!.prepare('SELECT * FROM symposium_deliveries WHERE delivery_id = ?').get(
      deliveryId,
    ) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const recipients = this.db!.prepare(
      `SELECT * FROM symposium_delivery_recipients
       WHERE delivery_id = ? ORDER BY recipient_order`,
    ).all(deliveryId) as Record<string, unknown>[];
    return rowToSymposiumDelivery(row, recipients.map(rowToSymposiumRecipient));
  }

  getSymposiumDeliveryByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string,
  ): SymposiumDeliveryRecord | undefined {
    const row = this.db!.prepare(
      `SELECT delivery_id FROM symposium_deliveries
       WHERE session_id = ? AND idempotency_key = ?`,
    ).get(sessionId, idempotencyKey) as { delivery_id: string } | undefined;
    return row ? this.getSymposiumDelivery(row.delivery_id) : undefined;
  }

  getSymposiumDeliveries(sessionId: string): SymposiumDeliveryRecord[] {
    const rows = this.db!.prepare(
      `SELECT delivery_id FROM symposium_deliveries
       WHERE session_id = ? ORDER BY created_at, delivery_id`,
    ).all(sessionId) as Array<{ delivery_id: string }>;
    return rows.map((row) => this.getSymposiumDelivery(row.delivery_id)!);
  }

  recordSymposiumIntervention(input: {
    deliveryId: string;
    action: SymposiumIntervention;
    content: string | null;
    reason: string | null;
    idempotencyKey: string;
    createdAt: number;
  }): SymposiumDeliveryRecord {
    return this.db!.transaction(() => {
      const duplicate = this.db!.prepare(
        `SELECT * FROM symposium_interventions
         WHERE delivery_id = ? AND idempotency_key = ?`,
      ).get(input.deliveryId, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (duplicate) {
        const prior = rowToSymposiumIntervention(duplicate);
        if (
          prior.action !== input.action ||
          prior.content !== input.content ||
          prior.reason !== input.reason
        ) {
          throw new Error('Symposium intervention idempotency key was reused with different input');
        }
        return this.getSymposiumDelivery(input.deliveryId)!;
      }
      const delivery = this.getSymposiumDelivery(input.deliveryId);
      if (!delivery) throw new Error('Unknown Symposium delivery');
      let status = delivery.status;
      let deliveredContent = delivery.deliveredContent;
      if (input.action === 'retry') {
        if (status !== 'failed' && status !== 'recovery_required') {
          throw new Error('Only failed or recovery-required deliveries can be retried');
        }
        status = 'ready';
        this.db!.prepare(
          `UPDATE symposium_delivery_recipients
           SET status = 'pending', error = NULL, updated_at = ?
           WHERE delivery_id = ? AND status IN ('failed', 'recovery_required')`,
        ).run(input.createdAt, input.deliveryId);
      } else {
        if (status !== 'awaiting_intervention') {
          throw new Error('Delivery is not awaiting intervention');
        }
        if (input.action === 'drop') {
          status = 'dropped';
        } else {
          status = 'ready';
          deliveredContent = input.action === 'approve' ? delivery.originalContent : input.content;
          if (deliveredContent == null || deliveredContent.length === 0) {
            throw new Error(`${input.action} requires delivered content`);
          }
        }
      }
      this.db!.prepare(
        `INSERT INTO symposium_interventions
          (delivery_id, action, content, reason, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.deliveryId,
        input.action,
        input.content,
        input.reason,
        input.idempotencyKey,
        input.createdAt,
      );
      this.db!.prepare(
        `UPDATE symposium_deliveries SET status = ?, delivered_content = ?,
          intervention = ?, intervention_reason = ?, updated_at = ? WHERE delivery_id = ?`,
      ).run(
        status,
        deliveredContent,
        input.action,
        input.reason,
        input.createdAt,
        input.deliveryId,
      );
      return this.getSymposiumDelivery(input.deliveryId)!;
    }).immediate();
  }

  getSymposiumInterventions(deliveryId: string): SymposiumInterventionRecord[] {
    const rows = this.db!.prepare(
      `SELECT * FROM symposium_interventions
       WHERE delivery_id = ? ORDER BY intervention_id`,
    ).all(deliveryId) as Record<string, unknown>[];
    return rows.map(rowToSymposiumIntervention);
  }

  claimSymposiumDelivery(deliveryId: string, maxTurns?: number): boolean {
    return this.db!.transaction(() => {
      const delivery = this.getSymposiumDelivery(deliveryId);
      if (!delivery) throw new Error('Unknown Symposium delivery');
      if (delivery.status !== 'ready') return false;
      if (maxTurns !== undefined) {
        const reserved = this.db!.prepare(
          `SELECT
             (SELECT count(*) FROM symposium_recipient_attempts a
              JOIN symposium_deliveries attempted ON attempted.delivery_id = a.delivery_id
              WHERE attempted.session_id = ?) +
             (SELECT count(*) FROM symposium_delivery_recipients r
              JOIN symposium_deliveries active ON active.delivery_id = r.delivery_id
              WHERE active.session_id = ? AND active.status = 'delivering'
                AND r.status = 'pending') AS count`,
        ).get(delivery.sessionId, delivery.sessionId) as { count: number };
        const requested = delivery.recipients.filter(
          (recipient) => recipient.status === 'pending',
        ).length;
        if (reserved.count + requested > maxTurns) {
          throw new Error('Symposium turn limit would be exceeded');
        }
      }
      const result = this.db!.prepare(
        `UPDATE symposium_deliveries SET status = 'delivering',
          updated_at = unixepoch('now', 'subsec') * 1000
         WHERE delivery_id = ? AND status = 'ready'`,
      ).run(deliveryId);
      return result.changes === 1;
    }).immediate();
  }

  failSymposiumDeliveryBeforeDispatch(input: {
    deliveryId: string;
    error: string;
    updatedAt: number;
  }): SymposiumDeliveryRecord {
    return this.db!.transaction(() => {
      const failed = this.db!.prepare(
        `UPDATE symposium_deliveries SET status = 'failed', updated_at = ?
         WHERE delivery_id = ? AND status = 'ready'`,
      ).run(input.updatedAt, input.deliveryId);
      if (failed.changes === 1) {
        this.db!.prepare(
          `UPDATE symposium_delivery_recipients SET status = 'failed', error = ?, updated_at = ?
           WHERE delivery_id = ? AND status = 'pending'`,
        ).run(input.error, input.updatedAt, input.deliveryId);
      }
      const delivery = this.getSymposiumDelivery(input.deliveryId);
      if (!delivery) throw new Error('Unknown Symposium delivery');
      return delivery;
    }).immediate();
  }

  claimSymposiumRecipientExecution(input: {
    sessionId: string;
    deliveryId: string;
    seatId: string;
    expectedConfigRevision: number;
    bindingKey: string;
    recipientIdempotencyKey: string;
    claimToken: string;
    claimedAt: number;
  }): { claimToken: string; thread: SymposiumSeatThreadRecord | undefined } | undefined {
    return this.db!.transaction(() => {
      const recipient = this.db!.prepare(
        `SELECT r.status AS recipient_status, r.idempotency_key, d.status AS delivery_status,
          d.session_id
         FROM symposium_delivery_recipients r
         JOIN symposium_deliveries d ON d.delivery_id = r.delivery_id
         WHERE r.delivery_id = ? AND r.seat_id = ?`,
      ).get(input.deliveryId, input.seatId) as
        | {
            recipient_status: string;
            idempotency_key: string;
            delivery_status: string;
            session_id: string;
          }
        | undefined;
      if (
        !recipient ||
        recipient.session_id !== input.sessionId ||
        recipient.delivery_status !== 'delivering' ||
        recipient.recipient_status !== 'pending' ||
        recipient.idempotency_key !== input.recipientIdempotencyKey
      ) {
        return undefined;
      }

      let boundaryError: string | undefined;
      try {
        const config = this.getActiveSymposiumConfig(input.sessionId);
        if (config.revision !== input.expectedConfigRevision) {
          boundaryError = 'Delivery configuration revision is stale';
        } else {
          const admission = this.getLatestSymposiumAdmission(
            input.sessionId,
            input.seatId,
            input.expectedConfigRevision,
          );
          if (admission?.decision !== 'admitted') {
            boundaryError = `Provider for Symposium seat ${input.seatId} is not admitted`;
          }
        }
      } catch (error) {
        boundaryError = error instanceof Error ? error.message : String(error);
      }
      if (boundaryError) {
        this.db!.prepare(
          `UPDATE symposium_delivery_recipients SET status = 'failed', error = ?, updated_at = ?
           WHERE delivery_id = ? AND seat_id = ? AND status = 'pending'`,
        ).run(boundaryError, input.claimedAt, input.deliveryId, input.seatId);
        this.db!.prepare(
          `UPDATE symposium_deliveries SET status = 'failed', updated_at = ?
           WHERE delivery_id = ? AND status = 'delivering'`,
        ).run(input.claimedAt, input.deliveryId);
        return undefined;
      }

      const inserted = this.db!.prepare(
        `INSERT OR IGNORE INTO symposium_seat_execution_claims (
          session_id, seat_id, binding_key, delivery_id,
          recipient_idempotency_key, claim_token, claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId,
        input.seatId,
        input.bindingKey,
        input.deliveryId,
        input.recipientIdempotencyKey,
        input.claimToken,
        input.claimedAt,
      );
      if (inserted.changes !== 1) {
        this.db!.prepare(
          `UPDATE symposium_deliveries SET status = 'ready', updated_at = ?
           WHERE delivery_id = ? AND status = 'delivering'
             AND NOT EXISTS (
               SELECT 1 FROM symposium_delivery_recipients
               WHERE delivery_id = ? AND status = 'executing'
             )`,
        ).run(input.claimedAt, input.deliveryId, input.deliveryId);
        return undefined;
      }

      const thread = this.getSymposiumSeatThread(input.sessionId, input.seatId, input.bindingKey);
      const claimed = this.db!.prepare(
        `UPDATE symposium_delivery_recipients
         SET status = 'executing', provider_thread_id = ?, updated_at = ?
         WHERE delivery_id = ? AND seat_id = ? AND status = 'pending'
           AND idempotency_key = ?`,
      ).run(
        thread?.providerThreadId ?? null,
        input.claimedAt,
        input.deliveryId,
        input.seatId,
        input.recipientIdempotencyKey,
      );
      if (claimed.changes !== 1) {
        this.db!.prepare(`DELETE FROM symposium_seat_execution_claims WHERE claim_token = ?`).run(
          input.claimToken,
        );
        return undefined;
      }
      this.db!.prepare(
        `INSERT INTO symposium_recipient_attempts (
          delivery_id, seat_id, attempt_number, idempotency_key, status,
          provider_thread_id, started_at, updated_at
        )
        SELECT ?, ?, COALESCE(MAX(attempt_number), 0) + 1, ?, 'executing', ?, ?, ?
        FROM symposium_recipient_attempts WHERE delivery_id = ? AND seat_id = ?`,
      ).run(
        input.deliveryId,
        input.seatId,
        input.recipientIdempotencyKey,
        thread?.providerThreadId ?? null,
        input.claimedAt,
        input.claimedAt,
        input.deliveryId,
        input.seatId,
      );
      return {
        claimToken: input.claimToken,
        thread,
      };
    }).immediate();
  }

  completeSymposiumRecipient(input: {
    sessionId: string;
    deliveryId: string;
    seatId: string;
    bindingKey: string;
    providerThreadId: string;
    configRevision: number;
    threadCreatedAt: number;
    resultContent: string;
    costUsd: number;
    updatedAt: number;
    claimToken: string;
  }): SymposiumDeliveryRecord {
    return this.db!.transaction(() => {
      const delivery = this.db!.prepare(
        `SELECT session_id, config_revision FROM symposium_deliveries WHERE delivery_id = ?`,
      ).get(input.deliveryId) as { session_id: string; config_revision: number } | undefined;
      if (
        !delivery ||
        delivery.session_id !== input.sessionId ||
        delivery.config_revision !== input.configRevision
      ) {
        throw new Error('Symposium completion does not match its delivery configuration');
      }
      const claim = this.db!.prepare(
        `SELECT 1 FROM symposium_seat_execution_claims
         WHERE session_id = ? AND seat_id = ? AND binding_key = ?
           AND delivery_id = ? AND claim_token = ?`,
      ).get(input.sessionId, input.seatId, input.bindingKey, input.deliveryId, input.claimToken);
      if (!claim) return this.getSymposiumDelivery(input.deliveryId)!;
      const result = this.db!.prepare(
        `UPDATE symposium_delivery_recipients SET status = 'delivered',
          provider_thread_id = ?, result_content = ?, cost_usd = ?, error = NULL, updated_at = ?
         WHERE delivery_id = ? AND seat_id = ? AND status = 'executing'`,
      ).run(
        input.providerThreadId,
        input.resultContent,
        input.costUsd,
        input.updatedAt,
        input.deliveryId,
        input.seatId,
      );
      if (result.changes === 1) {
        const attempt = this.db!.prepare(
          `UPDATE symposium_recipient_attempts SET status = 'delivered',
            provider_thread_id = ?, result_content = ?, cost_usd = ?, error = NULL,
            completed_at = ?, updated_at = ?
           WHERE delivery_id = ? AND seat_id = ? AND status = 'executing'`,
        ).run(
          input.providerThreadId,
          input.resultContent,
          input.costUsd,
          input.updatedAt,
          input.updatedAt,
          input.deliveryId,
          input.seatId,
        );
        if (attempt.changes !== 1) {
          throw new Error('Symposium recipient execution attempt is missing');
        }
        const existingThread = this.getSymposiumSeatThread(
          input.sessionId,
          input.seatId,
          input.bindingKey,
        );
        if (existingThread && existingThread.providerThreadId !== input.providerThreadId) {
          throw new Error('Symposium provider thread changed for an existing seat binding');
        }
        if (existingThread) {
          this.db!.prepare(
            `UPDATE symposium_seat_threads SET updated_at = ?
             WHERE session_id = ? AND seat_id = ? AND binding_key = ?`,
          ).run(input.updatedAt, input.sessionId, input.seatId, input.bindingKey);
        } else {
          this.db!.prepare(
            `INSERT INTO symposium_seat_threads (
              session_id, seat_id, binding_key, provider_thread_id,
              config_revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.sessionId,
            input.seatId,
            input.bindingKey,
            input.providerThreadId,
            input.configRevision,
            input.threadCreatedAt,
            input.updatedAt,
          );
        }
        this.db!.prepare(`DELETE FROM symposium_seat_execution_claims WHERE claim_token = ?`).run(
          input.claimToken,
        );
        const remaining = this.db!.prepare(
          `SELECT 1 FROM symposium_delivery_recipients
           WHERE delivery_id = ? AND status != 'delivered' LIMIT 1`,
        ).get(input.deliveryId);
        if (!remaining) {
          this.db!.prepare(
            `UPDATE symposium_deliveries SET status = 'delivered', updated_at = ?
             WHERE delivery_id = ? AND status = 'delivering'`,
          ).run(input.updatedAt, input.deliveryId);
        }
      }
      return this.getSymposiumDelivery(input.deliveryId)!;
    }).immediate();
  }

  failSymposiumRecipient(input: {
    deliveryId: string;
    seatId: string;
    error: string;
    updatedAt: number;
    claimToken?: string;
  }): SymposiumDeliveryRecord {
    return this.db!.transaction(() => {
      if (input.claimToken) {
        const claim = this.db!.prepare(
          `SELECT 1 FROM symposium_seat_execution_claims
           WHERE delivery_id = ? AND seat_id = ? AND claim_token = ?`,
        ).get(input.deliveryId, input.seatId, input.claimToken);
        if (!claim) return this.getSymposiumDelivery(input.deliveryId)!;
      }
      const result = this.db!.prepare(
        `UPDATE symposium_delivery_recipients SET status = 'failed', error = ?, updated_at = ?
         WHERE delivery_id = ? AND seat_id = ? AND status = ?`,
      ).run(
        input.error,
        input.updatedAt,
        input.deliveryId,
        input.seatId,
        input.claimToken ? 'executing' : 'pending',
      );
      if (result.changes === 1) {
        if (input.claimToken) {
          this.db!.prepare(
            `UPDATE symposium_recipient_attempts SET status = 'failed', error = ?,
              completed_at = ?, updated_at = ?
             WHERE delivery_id = ? AND seat_id = ? AND status = 'executing'`,
          ).run(input.error, input.updatedAt, input.updatedAt, input.deliveryId, input.seatId);
          this.db!.prepare(`DELETE FROM symposium_seat_execution_claims WHERE claim_token = ?`).run(
            input.claimToken,
          );
        }
        this.db!.prepare(
          `UPDATE symposium_deliveries SET status = 'failed', updated_at = ?
           WHERE delivery_id = ? AND status = 'delivering'`,
        ).run(input.updatedAt, input.deliveryId);
      }
      return this.getSymposiumDelivery(input.deliveryId)!;
    }).immediate();
  }

  cancelSymposiumDelivery(input: {
    deliveryId: string;
    reason: string | null;
    idempotencyKey: string;
    cancelledAt: number;
  }): SymposiumDeliveryRecord {
    return this.db!.transaction(() => {
      const row = this.db!.prepare(
        `SELECT status, cancellation_reason, cancellation_idempotency_key
         FROM symposium_deliveries WHERE delivery_id = ?`,
      ).get(input.deliveryId) as
        | {
            status: string;
            cancellation_reason: string | null;
            cancellation_idempotency_key: string | null;
          }
        | undefined;
      if (!row) throw new Error('Unknown Symposium delivery');
      if (row.cancellation_idempotency_key) {
        if (row.cancellation_idempotency_key !== input.idempotencyKey) {
          throw new Error('Symposium delivery was already cancelled with another request');
        }
        if (row.cancellation_reason !== input.reason) {
          throw new Error(
            'Symposium cancellation idempotency key was reused with a different reason',
          );
        }
        return this.getSymposiumDelivery(input.deliveryId)!;
      }
      if (row.status === 'delivered' || row.status === 'dropped') {
        throw new Error(`Cannot cancel a ${row.status} Symposium delivery`);
      }
      this.db!.prepare(
        `UPDATE symposium_deliveries SET status = 'cancelled', cancellation_reason = ?,
          cancellation_idempotency_key = ?, cancelled_at = ?, updated_at = ?
         WHERE delivery_id = ? AND status NOT IN ('delivered', 'dropped')`,
      ).run(
        input.reason,
        input.idempotencyKey,
        input.cancelledAt,
        input.cancelledAt,
        input.deliveryId,
      );
      this.db!.prepare(
        `UPDATE symposium_recipient_attempts SET status = 'cancelled', completed_at = ?,
          updated_at = ?
         WHERE delivery_id = ? AND status = 'executing'`,
      ).run(input.cancelledAt, input.cancelledAt, input.deliveryId);
      this.db!.prepare(
        `UPDATE symposium_delivery_recipients SET status = 'cancelled', updated_at = ?
         WHERE delivery_id = ? AND status != 'delivered'`,
      ).run(input.cancelledAt, input.deliveryId);
      this.db!.prepare(`DELETE FROM symposium_seat_execution_claims WHERE delivery_id = ?`).run(
        input.deliveryId,
      );
      return this.getSymposiumDelivery(input.deliveryId)!;
    }).immediate();
  }

  recoverSymposiumDeliveries(recoveredAt: number): SymposiumDeliveryRecord[] {
    return this.db!.transaction(() => {
      const rows = this.db!.prepare(
        `SELECT delivery_id FROM symposium_deliveries WHERE status = 'delivering'
         ORDER BY created_at, delivery_id`,
      ).all() as Array<{ delivery_id: string }>;
      for (const row of rows) {
        this.db!.prepare(
          `UPDATE symposium_recipient_attempts SET status = 'recovery_required',
            completed_at = ?, updated_at = ?
           WHERE delivery_id = ? AND status = 'executing'`,
        ).run(recoveredAt, recoveredAt, row.delivery_id);
        this.db!.prepare(
          `UPDATE symposium_delivery_recipients SET status = 'recovery_required', updated_at = ?
           WHERE delivery_id = ? AND status = 'executing'`,
        ).run(recoveredAt, row.delivery_id);
        this.db!.prepare(
          `UPDATE symposium_deliveries SET status = 'recovery_required', updated_at = ?
           WHERE delivery_id = ? AND status = 'delivering'`,
        ).run(recoveredAt, row.delivery_id);
        this.db!.prepare(`DELETE FROM symposium_seat_execution_claims WHERE delivery_id = ?`).run(
          row.delivery_id,
        );
      }
      return rows.map((row) => this.getSymposiumDelivery(row.delivery_id)!);
    }).immediate();
  }

  getSymposiumRecipientAttempts(
    deliveryId: string,
    seatId?: string,
  ): SymposiumRecipientAttemptRecord[] {
    const rows = seatId
      ? (this.db!.prepare(
          `SELECT * FROM symposium_recipient_attempts
           WHERE delivery_id = ? AND seat_id = ? ORDER BY attempt_number`,
        ).all(deliveryId, seatId) as Record<string, unknown>[])
      : (this.db!.prepare(
          `SELECT * FROM symposium_recipient_attempts
           WHERE delivery_id = ? ORDER BY seat_id, attempt_number`,
        ).all(deliveryId) as Record<string, unknown>[]);
    return rows.map(rowToSymposiumRecipientAttempt);
  }

  getSymposiumSeatThread(
    sessionId: string,
    seatId: string,
    bindingKey: string,
  ): SymposiumSeatThreadRecord | undefined {
    const row = this.db!.prepare(
      `SELECT * FROM symposium_seat_threads
       WHERE session_id = ? AND seat_id = ? AND binding_key = ?`,
    ).get(sessionId, seatId, bindingKey) as Record<string, unknown> | undefined;
    return row ? rowToSymposiumSeatThread(row) : undefined;
  }

  bindSymposiumSeatThread(record: SymposiumSeatThreadRecord): SymposiumSeatThreadRecord {
    return this.db!.transaction(() => {
      const existing = this.getSymposiumSeatThread(
        record.sessionId,
        record.seatId,
        record.bindingKey,
      );
      if (existing) {
        if (existing.providerThreadId !== record.providerThreadId) {
          throw new Error('Symposium provider thread changed for an existing seat binding');
        }
        this.db!.prepare(
          `UPDATE symposium_seat_threads SET updated_at = ?
           WHERE session_id = ? AND seat_id = ? AND binding_key = ?`,
        ).run(record.updatedAt, record.sessionId, record.seatId, record.bindingKey);
        return { ...existing, updatedAt: record.updatedAt };
      }
      this.db!.prepare(
        `INSERT INTO symposium_seat_threads (
          session_id, seat_id, binding_key, provider_thread_id,
          config_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.sessionId,
        record.seatId,
        record.bindingKey,
        record.providerThreadId,
        record.configRevision,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    }).immediate();
  }

  getSymposiumSeatThreads(sessionId: string): SymposiumSeatThreadRecord[] {
    const rows = this.db!.prepare(
      `SELECT * FROM symposium_seat_threads
       WHERE session_id = ? ORDER BY created_at, seat_id, binding_key`,
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToSymposiumSeatThread);
  }

  countDeliveredSymposiumTurns(sessionId: string): number {
    const row = this.db!.prepare(
      `SELECT count(*) AS count FROM symposium_delivery_recipients r
       JOIN symposium_deliveries d ON d.delivery_id = r.delivery_id
       WHERE d.session_id = ? AND r.status = 'delivered'`,
    ).get(sessionId) as { count: number };
    return row.count;
  }

  upsertSession(meta: SessionUpsert): void {
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
      if (meta.agentName !== undefined) {
        fields.push('agent_name = ?');
        values.push(meta.agentName);
      }
      if (meta.accountBinding !== undefined) {
        fields.push('account_binding = ?');
        values.push(meta.accountBinding ? JSON.stringify(meta.accountBinding) : null);
      }
      if (meta.bootContext !== undefined) {
        fields.push('boot_context = ?');
        values.push(meta.bootContext);
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
        'agent_name',
        'boot_context',
        'account_binding',
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
        meta.agentName ?? null,
        meta.bootContext ?? null,
        meta.accountBinding ? JSON.stringify(meta.accountBinding) : null,
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

  /** Set session lifecycle state. Warns on invalid transitions but does not block (Phase 1). */
  setSessionState(
    sessionId: string,
    newState: SessionState,
    opts?: { clientId?: string; reason?: string; force?: boolean },
  ): void {
    const current = this.getSession(sessionId);
    const fromState = (current?.state as SessionState) ?? null;
    const now = Date.now();

    if (fromState && !opts?.force) {
      const allowed = VALID_TRANSITIONS[fromState];
      if (!allowed?.includes(newState)) {
        this.log.info('invalid session state transition (warn-only)', {
          sessionId,
          fromState,
          toState: newState,
          clientId: opts?.clientId,
          reason: opts?.reason,
        });
      }
    }

    // Sync is_active from state (backwards-compatible, P0).
    // Only ENDED/CLOSING are inactive. CREATED is transient — see recoverStaleSessions().
    const isActive = newState !== 'ENDED' && newState !== 'CLOSING' ? 1 : 0;
    this.stmts.setSessionState.run(newState, now, isActive, sessionId);

    // Emit session_state_changed event for client consumption (P0)
    const clientState = toClientState(newState);
    this.append(sessionId, 'session_state_changed', {
      sessionId,
      state: clientState,
      internalState: newState,
      timestamp: now,
    });

    this.log.info('session state transition', {
      sessionId,
      fromState,
      toState: newState,
      clientState,
      clientId: opts?.clientId,
      reason: opts?.reason,
    });
  }

  getSessionState(sessionId: string): SessionState | null {
    const row = this.stmts.getSessionState.get(sessionId) as { state: string | null } | undefined;
    return (row?.state as SessionState) ?? null;
  }

  /**
   * Recover sessions left in incomplete states after a server crash/restart.
   * Any session in ACTIVE, STARTING, DETACHED, SUSPENDED, or CLOSING is transitioned to ENDED.
   * CLOSING is included because the process performing graceful shutdown is gone after a crash.
   * Returns the number of sessions recovered.
   */
  recoverStaleSessions(): number {
    // CREATED excluded: transient state, moves to STARTING synchronously in startChat().
    // The crash window between CREATED and STARTING is negligible.
    const staleStates = ['ACTIVE', 'STARTING', 'DETACHED', 'SUSPENDED', 'CLOSING'];
    const placeholders = staleStates.map(() => '?').join(', ');
    // Inline prepare is intentional — this runs once at startup, not worth caching.
    const rows = this.db!.prepare(
      `SELECT session_id FROM sessions WHERE state IN (${placeholders})`,
    ).all(...staleStates) as Array<{ session_id: string }>;

    for (const row of rows) {
      this.setSessionState(row.session_id, 'ENDED', {
        reason: 'server_restart',
        force: true,
      });
    }

    if (rows.length > 0) {
      this.log.info('recovered stale sessions on startup', {
        count: rows.length,
        sessionIds: rows.map((r) => r.session_id),
      });
    }

    return rows.length;
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

function rowToSymposiumAdmission(row: Record<string, unknown>): SymposiumAdmissionRecord {
  return {
    admissionId: row.admission_id as string,
    sessionId: row.session_id as string,
    seatId: row.seat_id as string,
    decision: row.decision as SymposiumAdmissionRecord['decision'],
    reason: (row.reason as string | null) ?? null,
    idempotencyKey: row.idempotency_key as string,
    configRevision: row.config_revision as number,
    provider: row.provider as string,
    accountId: row.account_id as string,
    model: row.model as string,
    accountProfileRevision: row.account_profile_revision as string,
    isolationDomainId: row.isolation_domain_id as string,
    isolationDomainRevision: row.isolation_domain_revision as number,
    decidedAt: row.decided_at as number,
  };
}

function rowToSymposiumRecipient(row: Record<string, unknown>): SymposiumDeliveryRecipient {
  return {
    deliveryId: row.delivery_id as string,
    seatId: row.seat_id as string,
    status: row.status as SymposiumDeliveryRecipient['status'],
    idempotencyKey: row.idempotency_key as string,
    configRevision: row.config_revision as number,
    accountProfileRevision: row.account_profile_revision as string,
    seatProfileRevision: row.seat_profile_revision as string,
    contextGrantId: row.context_grant_id as string,
    contextGrantRevision: row.context_grant_revision as number,
    authorityGrantId: row.authority_grant_id as string,
    authorityGrantRevision: row.authority_grant_revision as number,
    isolationDomainId: row.isolation_domain_id as string,
    isolationDomainRevision: row.isolation_domain_revision as number,
    providerThreadId: (row.provider_thread_id as string | null) ?? null,
    resultContent: (row.result_content as string | null) ?? null,
    costUsd: (row.cost_usd as number) ?? 0,
    error: (row.error as string | null) ?? null,
    updatedAt: row.updated_at as number,
  };
}

function rowToSymposiumRecipientAttempt(
  row: Record<string, unknown>,
): SymposiumRecipientAttemptRecord {
  return {
    attemptId: row.attempt_id as number,
    deliveryId: row.delivery_id as string,
    seatId: row.seat_id as string,
    attemptNumber: row.attempt_number as number,
    idempotencyKey: row.idempotency_key as string,
    status: row.status as SymposiumRecipientAttemptRecord['status'],
    providerThreadId: (row.provider_thread_id as string | null) ?? null,
    resultContent: (row.result_content as string | null) ?? null,
    costUsd: row.cost_usd as number,
    error: (row.error as string | null) ?? null,
    startedAt: row.started_at as number,
    completedAt: (row.completed_at as number | null) ?? null,
    updatedAt: row.updated_at as number,
  };
}

function recipientSnapshotChanged(
  existing: SymposiumDeliveryRecipient,
  requested: SymposiumDeliveryRecipient | undefined,
): boolean {
  return (
    !requested ||
    existing.seatId !== requested.seatId ||
    existing.configRevision !== requested.configRevision ||
    existing.accountProfileRevision !== requested.accountProfileRevision ||
    existing.seatProfileRevision !== requested.seatProfileRevision ||
    existing.contextGrantId !== requested.contextGrantId ||
    existing.contextGrantRevision !== requested.contextGrantRevision ||
    existing.authorityGrantId !== requested.authorityGrantId ||
    existing.authorityGrantRevision !== requested.authorityGrantRevision ||
    existing.isolationDomainId !== requested.isolationDomainId ||
    existing.isolationDomainRevision !== requested.isolationDomainRevision
  );
}

function rowToSymposiumDelivery(
  row: Record<string, unknown>,
  recipients: SymposiumDeliveryRecipient[],
): SymposiumDeliveryRecord {
  let sourceProvenance: SymposiumProvenance | null = null;
  if (row.source_provenance) {
    const parsed = SymposiumProvenanceSchema.safeParse(JSON.parse(row.source_provenance as string));
    if (parsed.success) sourceProvenance = parsed.data;
  }
  return {
    deliveryId: row.delivery_id as string,
    sessionId: row.session_id as string,
    sourceSeatId: (row.source_seat_id as string | null) ?? null,
    recipientSeatIds: JSON.parse(row.recipient_seat_ids as string) as string[],
    originalContent: row.original_content as string,
    deliveredContent: (row.delivered_content as string | null) ?? null,
    status: row.status as SymposiumDeliveryRecord['status'],
    intervention: (row.intervention as SymposiumIntervention | null) ?? null,
    interventionReason: (row.intervention_reason as string | null) ?? null,
    idempotencyKey: row.idempotency_key as string,
    configRevision: row.config_revision as number,
    sourceProvenance,
    cancellationReason: (row.cancellation_reason as string | null) ?? null,
    cancellationIdempotencyKey: (row.cancellation_idempotency_key as string | null) ?? null,
    cancelledAt: (row.cancelled_at as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    recipients,
  };
}

function rowToSymposiumIntervention(row: Record<string, unknown>): SymposiumInterventionRecord {
  return {
    interventionId: row.intervention_id as number,
    deliveryId: row.delivery_id as string,
    action: row.action as SymposiumIntervention,
    content: (row.content as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    idempotencyKey: row.idempotency_key as string,
    createdAt: row.created_at as number,
  };
}

function rowToSymposiumSeatThread(row: Record<string, unknown>): SymposiumSeatThreadRecord {
  return {
    sessionId: row.session_id as string,
    seatId: row.seat_id as string,
    bindingKey: row.binding_key as string,
    providerThreadId: row.provider_thread_id as string,
    configRevision: row.config_revision as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToEvent(row: EventRow): StoredEvent {
  const symposiumProvenance = parseSymposiumProvenance(row.symposium_provenance);
  return {
    seq: row.seq,
    ...(row.seat_id ? { seatId: row.seat_id } : {}),
    ...(symposiumProvenance ? { symposiumProvenance } : {}),
    sessionId: row.session_id,
    type: row.type,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

function parseSymposiumProvenance(raw: string | null): SymposiumProvenance | undefined {
  if (!raw) return undefined;
  try {
    const result = SymposiumProvenanceSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
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
    state: (row.state as SessionMeta['state']) ?? null,
    lastStateChange: row.last_state_change ?? null,
    agentName: row.agent_name ?? null,
    bootContext: row.boot_context ?? null,
    accountBinding: parseAccountBinding(row.account_binding),
    sessionType: row.session_type === 'symposium' ? 'symposium' : 'chat',
    symposiumConfig: row.symposium_config ?? null,
    symposiumRevision: row.symposium_revision ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAccountBinding(raw: string | null): AccountBinding | null {
  if (raw === null || raw === undefined) return null;
  try {
    const binding = AccountBindingSchema.safeParse(JSON.parse(raw));
    if (binding.success) return binding.data;
  } catch {
    /* Preserve a failed binding, never silently downgrade to the legacy route. */
  }
  return {
    accountId: 'unavailable',
    accountLabel: 'Unavailable account binding',
    provider: 'unavailable',
    model: 'unavailable',
    profileRevision: 'invalid',
  };
}

function sameBinding(left: AccountBinding, right: AccountBinding): boolean {
  return (
    left.accountId === right.accountId &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.profileRevision === right.profileRevision
  );
}

function matchesSeatProvenance(
  config: SymposiumConfig,
  seat: SymposiumConfig['seats'][number],
  provenance: SymposiumProvenance,
): boolean {
  return (
    provenance.seatId === seat.id &&
    provenance.configRevision === config.revision &&
    provenance.accountProfileRevision === seat.accountBinding?.profileRevision &&
    provenance.seatProfileRevision === seat.profileBinding?.profileRevision &&
    provenance.contextGrantRevision === seat.contextGrant?.revision &&
    provenance.authorityGrantRevision === seat.authorityGrant?.revision &&
    provenance.isolationDomainId === seat.isolationRequest?.trustDomainId &&
    provenance.isolationDomainRevision === seat.isolationRequest?.revision
  );
}
