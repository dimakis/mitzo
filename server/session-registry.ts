import type { WebSocket } from 'ws';
import { DETACHED_TTL_MS } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('session-registry');

export type MitzoMode = 'ask' | 'agent' | 'auto';

export interface ManagedSession {
  ws: WebSocket;
  abortController: AbortController;
  sessionId?: string;
  sessionAllowList: Set<string>;
  mode: MitzoMode;
  worktreePath?: string;
  queryInstance?: any;
}

export class SessionRegistry {
  private sessions = new Map<string, ManagedSession>();
  private attached = new Set<string>();
  private detachTimers = new Map<string, ReturnType<typeof setTimeout>>();

  register(
    clientId: string,
    init: Omit<ManagedSession, 'queryInstance'> & { sessionId?: string },
  ): void {
    this.sessions.set(clientId, { ...init });
    this.attached.add(clientId);
  }

  get(clientId: string): ManagedSession | undefined {
    return this.sessions.get(clientId);
  }

  isActive(clientId: string): boolean {
    return this.sessions.has(clientId);
  }

  isAttached(clientId: string): boolean {
    return this.attached.has(clientId);
  }

  /**
   * Detach the WebSocket from a session without killing the SDK query.
   * Starts a TTL timer — if no reattach arrives, the session is aborted.
   */
  detach(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this.attached.delete(clientId);

    this.clearDetachTimer(clientId);

    const timer = setTimeout(() => {
      this.detachTimers.delete(clientId);
      if (this.sessions.has(clientId) && !this.attached.has(clientId)) {
        log.info(`detach TTL expired for ${clientId}, aborting`);
        this.abort(clientId);
      }
    }, DETACHED_TTL_MS);

    this.detachTimers.set(clientId, timer);
  }

  /**
   * Reattach a new WebSocket to an existing session.
   * Returns true if the session was found and reattached.
   */
  reattach(clientId: string, ws: WebSocket): boolean {
    const session = this.sessions.get(clientId);
    if (!session) return false;

    session.ws = ws;
    this.attached.add(clientId);
    this.clearDetachTimer(clientId);
    return true;
  }

  /**
   * Re-key a session from oldId to newId. Moves all state (session data,
   * attached flag, detach timer) atomically. Used after WS reattach so that
   * the new connection's clientId becomes the canonical key, preventing
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
    session.abortController.abort();
    this.sessions.delete(clientId);
    this.attached.delete(clientId);
  }

  /**
   * Remove a session from the registry without aborting.
   * Used when the SDK query finishes naturally.
   */
  remove(clientId: string): void {
    this.clearDetachTimer(clientId);
    this.sessions.delete(clientId);
    this.attached.delete(clientId);
  }

  /**
   * Clean up all sessions and timers. Used for graceful shutdown.
   */
  dispose(): void {
    for (const timer of this.detachTimers.values()) {
      clearTimeout(timer);
    }
    this.detachTimers.clear();

    for (const [clientId] of this.sessions) {
      this.abort(clientId);
    }
  }

  private clearDetachTimer(clientId: string): void {
    const existing = this.detachTimers.get(clientId);
    if (existing) {
      clearTimeout(existing);
      this.detachTimers.delete(clientId);
    }
  }
}
