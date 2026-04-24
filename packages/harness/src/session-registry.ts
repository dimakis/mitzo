import type { SessionTransport } from './session-transport.js';
import {
  DETACHED_TTL_MS,
  CLOSEOUT_LEAD_MS,
  CLOSEOUT_TIMEOUT_MS,
  MAX_OBSERVERS_PER_SESSION,
  SUSPEND_GRACE_MS,
  SUSPEND_BUFFER_MAX,
} from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('session-registry');

export type { MitzoMode, SnapshotBlock, MessageSnapshot, RawToolInput } from '@mitzo/protocol';
import type { MitzoMode, MessageSnapshot } from '@mitzo/protocol';

export interface ManagedSession {
  transport: SessionTransport;
  abortController: AbortController;
  sessionId?: string;
  sessionAllowList: Set<string>;
  mode: MitzoMode;
  cwd?: string;
  /** Git branch at session start. */
  branch?: string;
  /** Session-scoped worktree identifier, shared across all repos. */
  wtId?: string;
  worktreePath?: string;
  /** All worktrees created for this session, keyed by repo name. */
  worktreePaths: Map<string, { path: string; wtId: string }>;
  queryInstance?: { interrupt: () => Promise<void>; close: () => void };
  inputQueue?: { push: (msg: unknown) => void; close: () => void };
  currentSnapshot: MessageSnapshot | null;
  activeSkillPolicy: Set<string> | null;
  observers: Set<SessionTransport>;
  /** Accumulates token totals across multiple query() calls in a session */
  cumulativeSessionTokens: number;
  cumulativeCostUsd: number;
  taskContext: { currentTaskId: string; goalId: string } | null;
}

export interface ActiveSessionInfo {
  clientId: string;
  sessionId: string | undefined;
  mode: MitzoMode;
  cwd: string | undefined;
  attached: boolean;
  cumulativeSessionTokens: number;
  cumulativeCostUsd: number;
  hasSnapshot: boolean;
  taskContext: { currentTaskId: string; goalId: string } | null;
  observerCount: number;
}

export type CloseoutHandler = (clientId: string) => void;

export class SessionRegistry {
  private sessions = new Map<string, ManagedSession>();
  private attached = new Set<string>();
  private detachTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closingOut = new Set<string>();
  private closeoutHandler: CloseoutHandler | null = null;
  private suspended = new Set<string>();
  private suspendBuffers = new Map<string, Record<string, unknown>[]>();
  private suspendTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Register a handler called when a session enters closeout. */
  setCloseoutHandler(handler: CloseoutHandler): void {
    this.closeoutHandler = handler;
  }

  /** Check if a session is currently in the closeout phase. */
  isClosingOut(clientId: string): boolean {
    return this.closingOut.has(clientId);
  }

  register(
    clientId: string,
    init: Omit<
      ManagedSession,
      | 'queryInstance'
      | 'inputQueue'
      | 'currentSnapshot'
      | 'worktreePaths'
      | 'activeSkillPolicy'
      | 'observers'
      | 'cumulativeSessionTokens'
      | 'cumulativeCostUsd'
      | 'taskContext'
    > & {
      sessionId?: string;
    },
  ): void {
    this.sessions.set(clientId, {
      ...init,
      worktreePaths: new Map(),
      currentSnapshot: null,
      activeSkillPolicy: null,
      observers: new Set(),
      cumulativeSessionTokens: 0,
      cumulativeCostUsd: 0,
      taskContext: null,
    });
    this.attached.add(clientId);
  }

  get(clientId: string): ManagedSession | undefined {
    return this.sessions.get(clientId);
  }

  entries(): IterableIterator<[string, ManagedSession]> {
    return this.sessions.entries();
  }

  isActive(clientId: string): boolean {
    return this.sessions.has(clientId);
  }

  isAttached(clientId: string): boolean {
    return this.attached.has(clientId);
  }

  /**
   * Detach the transport from a session without killing the SDK query.
   * Starts a two-phase timer:
   * 1. At TTL - CLOSEOUT_LEAD_MS: start graceful closeout (if handler set)
   * 2. At TTL (or CLOSEOUT_TIMEOUT_MS after closeout start): abort
   */
  detach(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (!session) return;

    // Suspend takes precedence — don't transition to detach while suspended.
    if (this.suspended.has(clientId)) return;

    this.attached.delete(clientId);
    this.clearDetachTimer(clientId);
    this.clearCloseoutTimer(clientId);

    if (this.closeoutHandler) {
      // Phase 1: fire closeout at TTL - CLOSEOUT_LEAD_MS
      const closeoutDelay = DETACHED_TTL_MS - CLOSEOUT_LEAD_MS;
      const timer = setTimeout(() => {
        this.detachTimers.delete(clientId);
        if (!this.sessions.has(clientId) || this.attached.has(clientId)) return;
        log.info(`detach closeout starting for ${clientId}`);
        this.closingOut.add(clientId);
        this.closeoutHandler!(clientId);
        // Phase 2: hard abort after CLOSEOUT_TIMEOUT_MS
        const abortTimer = setTimeout(() => {
          this.closeoutTimers.delete(clientId);
          // Don't delete closingOut here — abort() will do it AFTER
          // firing the abort signal, so listeners can check isClosingOut().
          if (this.sessions.has(clientId) && !this.attached.has(clientId)) {
            log.info(`closeout timeout for ${clientId}, aborting`);
            this.abort(clientId);
          }
        }, CLOSEOUT_TIMEOUT_MS);
        this.closeoutTimers.set(clientId, abortTimer);
      }, closeoutDelay);
      this.detachTimers.set(clientId, timer);
    } else {
      // No closeout handler — fall back to direct abort at full TTL
      const timer = setTimeout(() => {
        this.detachTimers.delete(clientId);
        if (this.sessions.has(clientId) && !this.attached.has(clientId)) {
          log.info(`detach TTL expired for ${clientId}, aborting`);
          this.abort(clientId);
        }
      }, DETACHED_TTL_MS);
      this.detachTimers.set(clientId, timer);
    }
  }

  /**
   * Reattach a new transport to an existing session.
   * Cancels any pending closeout. Returns true if reattached.
   */
  reattach(clientId: string, transport: SessionTransport): boolean {
    const session = this.sessions.get(clientId);
    if (!session) return false;

    session.transport = transport;
    this.attached.add(clientId);
    this.clearDetachTimer(clientId);
    this.clearCloseoutTimer(clientId);
    this.closingOut.delete(clientId);
    this.clearSuspendState(clientId);
    return true;
  }

  /**
   * Re-key a session from oldId to newId. Moves all state (session data,
   * attached flag, detach timer) atomically. Used after transport reattach so
   * that the new connection's clientId becomes the canonical key, preventing
   * split-brain where isActive/stop/send target a stale key.
   */
  rekey(oldId: string, newId: string): boolean {
    const session = this.sessions.get(oldId);
    if (!session) return false;

    this.sessions.delete(oldId);
    this.sessions.set(newId, session);

    if (this.attached.has(oldId)) {
      this.attached.delete(oldId);
      this.attached.add(newId);
    }

    const timer = this.detachTimers.get(oldId);
    if (timer) {
      this.detachTimers.delete(oldId);
      this.detachTimers.set(newId, timer);
    }

    return true;
  }

  /**
   * Find a session by its SDK session ID (for reconnection by session ID).
   */
  findBySessionId(sessionId: string): { clientId: string; session: ManagedSession } | null {
    for (const [clientId, session] of this.sessions) {
      if (session.sessionId === sessionId) {
        return { clientId, session };
      }
    }
    return null;
  }

  /**
   * Add an observer transport to the session identified by sessionId.
   * Returns the clientId of the driver if successful, null otherwise.
   * Deduplicates (same transport is a no-op) and caps at MAX_OBSERVERS_PER_SESSION.
   */
  addObserver(sessionId: string, transport: SessionTransport): string | null {
    const found = this.findBySessionId(sessionId);
    if (!found) return null;
    // Already observing — idempotent no-op
    if (found.session.observers.has(transport)) return found.clientId;
    if (found.session.observers.size >= MAX_OBSERVERS_PER_SESSION) {
      log.warn('observer cap reached', { sessionId, max: MAX_OBSERVERS_PER_SESSION });
      return null;
    }
    found.session.observers.add(transport);
    // An active observer means someone is listening — don't let the detach
    // TTL kill the session out from under them.
    this.clearDetachTimer(found.clientId);
    log.info('observer added', { sessionId, observers: found.session.observers.size });
    return found.clientId;
  }

  /**
   * Remove a transport from all observer sets (cleanup on disconnect).
   * If the last observer leaves a detached session, restart the detach timer
   * so the session doesn't leak indefinitely.
   */
  removeObserver(transport: SessionTransport): void {
    for (const [clientId, session] of this.sessions) {
      if (!session.observers.delete(transport)) continue;
      if (session.observers.size === 0 && !this.attached.has(clientId)) {
        log.info('last observer left detached session, restarting detach timer', { clientId });
        this.detach(clientId);
      }
    }
  }

  setSessionId(clientId: string, sessionId: string): void {
    const session = this.sessions.get(clientId);
    if (session) session.sessionId = sessionId;
  }

  setMode(clientId: string, mode: MitzoMode): void {
    const session = this.sessions.get(clientId);
    if (session) session.mode = mode;
  }

  /**
   * Abort the SDK query and remove the session entirely.
   */
  abort(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this.clearDetachTimer(clientId);
    this.clearCloseoutTimer(clientId);
    this.clearSuspendState(clientId);
    // Fire abort signal BEFORE clearing closingOut — abort listeners
    // check isClosingOut() to distinguish 'abandoned' vs 'closed' status.
    session.abortController.abort();
    session.observers.clear();
    this.sessions.delete(clientId);
    this.attached.delete(clientId);
    this.closingOut.delete(clientId);
  }

  /**
   * Remove a session from the registry without aborting.
   * Used when the SDK query finishes naturally.
   */
  remove(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (session) session.observers.clear();
    this.clearDetachTimer(clientId);
    this.clearCloseoutTimer(clientId);
    this.clearSuspendState(clientId);
    this.sessions.delete(clientId);
    this.attached.delete(clientId);
    this.closingOut.delete(clientId);
  }

  /**
   * Clean up all sessions and timers. Used for graceful shutdown.
   */
  dispose(): void {
    for (const timer of this.detachTimers.values()) {
      clearTimeout(timer);
    }
    this.detachTimers.clear();

    for (const timer of this.closeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.closeoutTimers.clear();
    this.closingOut.clear();

    for (const timer of this.suspendTimers.values()) {
      clearTimeout(timer);
    }
    this.suspendTimers.clear();
    this.suspended.clear();
    this.suspendBuffers.clear();

    for (const [clientId] of this.sessions) {
      this.abort(clientId);
    }
  }

  // ─── Suspend (proactive iOS backgrounding) ───────────────────────────────

  /**
   * Suspend a session. The client signals this BEFORE iOS kills the WebSocket,
   * enabling event buffering and instant resume. Starts a grace timer — if
   * the client doesn't resume within SUSPEND_GRACE_MS, the session transitions
   * to the normal detach flow.
   */
  suspend(clientId: string, _lastClientSeq: number): void {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this.suspended.add(clientId);
    this.suspendBuffers.set(clientId, []);
    this.clearDetachTimer(clientId);
    this.clearSuspendTimer(clientId);

    const timer = setTimeout(() => {
      this.suspendTimers.delete(clientId);
      if (!this.sessions.has(clientId) || !this.suspended.has(clientId)) return;
      log.info('suspend grace expired, transitioning to detach', { clientId });
      this.suspended.delete(clientId);
      this.suspendBuffers.delete(clientId);
      this.detach(clientId);
    }, SUSPEND_GRACE_MS);
    this.suspendTimers.set(clientId, timer);
  }

  isSuspended(clientId: string): boolean {
    return this.suspended.has(clientId);
  }

  /**
   * Buffer an event for a suspended session. Returns false if the buffer
   * is full or the session is not suspended.
   */
  bufferEvent(clientId: string, event: Record<string, unknown>): boolean {
    if (!this.suspended.has(clientId)) return false;
    const buffer = this.suspendBuffers.get(clientId);
    if (!buffer) return false;
    if (buffer.length >= SUSPEND_BUFFER_MAX) return false;
    buffer.push(event);
    return true;
  }

  /**
   * Resume a suspended session. Returns buffered events and clears suspend state.
   */
  resume(clientId: string): Record<string, unknown>[] {
    if (!this.suspended.has(clientId)) return [];
    const buffer = this.suspendBuffers.get(clientId) ?? [];
    this.clearSuspendState(clientId);
    return buffer;
  }

  /**
   * Return a serializable snapshot of all active sessions.
   */
  getActiveSessions(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = [];
    for (const [clientId, session] of this.sessions) {
      result.push({
        clientId,
        sessionId: session.sessionId,
        mode: session.mode,
        cwd: session.cwd,
        attached: this.attached.has(clientId),
        cumulativeSessionTokens: session.cumulativeSessionTokens,
        cumulativeCostUsd: session.cumulativeCostUsd,
        hasSnapshot: session.currentSnapshot !== null,
        taskContext: session.taskContext,
        observerCount: session.observers.size,
      });
    }
    return result;
  }

  private clearSuspendState(clientId: string): void {
    this.suspended.delete(clientId);
    this.suspendBuffers.delete(clientId);
    this.clearSuspendTimer(clientId);
  }

  private clearSuspendTimer(clientId: string): void {
    const existing = this.suspendTimers.get(clientId);
    if (existing) {
      clearTimeout(existing);
      this.suspendTimers.delete(clientId);
    }
  }

  private clearDetachTimer(clientId: string): void {
    const existing = this.detachTimers.get(clientId);
    if (existing) {
      clearTimeout(existing);
      this.detachTimers.delete(clientId);
    }
  }

  private clearCloseoutTimer(clientId: string): void {
    const existing = this.closeoutTimers.get(clientId);
    if (existing) {
      clearTimeout(existing);
      this.closeoutTimers.delete(clientId);
    }
  }
}
