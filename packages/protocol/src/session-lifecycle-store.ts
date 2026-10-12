import type Database from 'better-sqlite3';
import type { SessionState, SessionMeta, ClientSessionState, EventStoreLogger } from './types.js';

/** EventStore retains connection, schema, prepared statements and close ownership.
 * Public hooks are resolved at call time so overrides and recovery share its boundary. */
export interface SessionLifecycleOwner {
  database(): Database.Database | null;
  statements: { setSessionState: Database.Statement; getSessionState: Database.Statement };
  logger: EventStoreLogger;
  getSession(id: string): SessionMeta | null;
  getSessionClientState(id: string): ClientSessionState | null;
  append(id: string, type: string, payload: Record<string, unknown>): number;
  setSessionState(
    id: string,
    state: SessionState,
    opts?: { clientId?: string; reason?: string; force?: boolean },
  ): void;
  toClientState(state: SessionState): ClientSessionState;
}

const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ['STARTING', 'ENDED'],
  STARTING: ['ACTIVE', 'ENDED'],
  ACTIVE: ['DETACHED', 'SUSPENDED', 'CLOSING', 'ENDED'],
  DETACHED: ['ACTIVE', 'SUSPENDED', 'CLOSING', 'ENDED'],
  SUSPENDED: ['ACTIVE', 'ENDED'],
  CLOSING: ['ENDED'],
  ENDED: ['CREATED'],
};

/** Lifecycle writes and restart recovery preserve the caller's transaction scope.
 * No new transaction is introduced: per-session partial failure remains observable. */
export class SessionLifecycleStore {
  constructor(private readonly owner: SessionLifecycleOwner) {}
  private get db() {
    return this.owner.database();
  }
  private get stmts() {
    return this.owner.statements;
  }
  private get log() {
    return this.owner.logger;
  }
  /** Set session lifecycle state. Warns on invalid transitions but does not block (Phase 1). */
  setSessionState(
    sessionId: string,
    newState: SessionState,
    opts?: { clientId?: string; reason?: string; force?: boolean },
  ): void {
    const current = this.owner.getSession(sessionId);
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
    const clientState =
      this.owner.getSessionClientState(sessionId) ?? this.owner.toClientState(newState);
    this.owner.append(sessionId, 'session_state_changed', {
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
  recoverStaleSessions(options: { excludeSymposium?: boolean } = {}): number {
    // CREATED excluded: transient state, moves to STARTING synchronously in startChat().
    // The crash window between CREATED and STARTING is negligible.
    const staleStates = ['ACTIVE', 'STARTING', 'DETACHED', 'SUSPENDED', 'CLOSING'];
    const placeholders = staleStates.map(() => '?').join(', ');
    // Inline prepare is intentional — this runs once at startup, not worth caching.
    const rows = this.db!.prepare(
      `SELECT session_id FROM sessions WHERE state IN (${placeholders})
       AND (? = 0 OR (COALESCE(session_type,'') != 'symposium' AND symposium_config IS NULL))`,
    ).all(...staleStates, options.excludeSymposium ? 1 : 0) as Array<{ session_id: string }>;

    for (const row of rows) {
      this.owner.setSessionState(row.session_id, 'ENDED', {
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
}
