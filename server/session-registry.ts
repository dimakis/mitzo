import type { WebSocket } from 'ws';
import { DETACHED_TTL_MS, MAX_OBSERVERS_PER_SESSION } from './constants.js';
import { createLogger } from './logger.js';
import type { RawToolInput } from './tool-summary.js';

const log = createLogger('session-registry');

export type MitzoMode = 'ask' | 'agent' | 'auto';

export interface SnapshotBlock {
  blockId: string;
  blockType: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';
  content: string;
  done: boolean;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  rawInput?: RawToolInput;
}

export interface MessageSnapshot {
  messageId: string;
  blocks: SnapshotBlock[];
}

export interface ManagedSession {
  ws: WebSocket;
  abortController: AbortController;
  sessionId?: string;
  sessionAllowList: Set<string>;
  mode: MitzoMode;
  cwd?: string;
  /** Session-scoped worktree identifier, shared across all repos. */
  wtId?: string;
  worktreePath?: string;
  /** All worktrees created for this session, keyed by repo name. */
  worktreePaths: Map<string, { path: string; wtId: string }>;
  queryInstance?: { interrupt: () => Promise<void>; close: () => void };
  inputQueue?: { push: (msg: unknown) => void; close: () => void };
  currentSnapshot: MessageSnapshot | null;
  activeSkillPolicy: Set<string> | null;
  observers: Set<WebSocket>;
  /** Accumulates token totals across multiple query() calls in a session */
  cumulativeSessionTokens: number;
  cumulativeCostUsd: number;
  taskContext: { currentTaskId: string; goalId: string } | null;
}

export class SessionRegistry {
  private sessions = new Map<string, ManagedSession>();
  private attached = new Set<string>();
  private detachTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /**
   * Add an observer WebSocket to the session identified by sessionId.
   * Returns the clientId of the driver if successful, null otherwise.
   * Deduplicates (same ws is a no-op) and caps at MAX_OBSERVERS_PER_SESSION.
   */
  addObserver(sessionId: string, ws: WebSocket): string | null {
    const found = this.findBySessionId(sessionId);
    if (!found) return null;
    // Already observing — idempotent no-op
    if (found.session.observers.has(ws)) return found.clientId;
    if (found.session.observers.size >= MAX_OBSERVERS_PER_SESSION) {
      log.warn('observer cap reached', { sessionId, max: MAX_OBSERVERS_PER_SESSION });
      return null;
    }
    found.session.observers.add(ws);
    log.info('observer added', { sessionId, observers: found.session.observers.size });
    return found.clientId;
  }

  /**
   * Remove a WebSocket from all observer sets (cleanup on disconnect).
   */
  removeObserver(ws: WebSocket): void {
    for (const session of this.sessions.values()) {
      session.observers.delete(ws);
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
    session.abortController.abort();
    session.observers.clear();
    this.sessions.delete(clientId);
    this.attached.delete(clientId);
  }

  /**
   * Remove a session from the registry without aborting.
   * Used when the SDK query finishes naturally.
   */
  remove(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (session) session.observers.clear();
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
