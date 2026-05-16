/**
 * Protocol parser — maps ServerMessage → store actions.
 *
 * Extracted from frontend/src/hooks/useChatMessages.ts handleWsMessage.
 * Framework-agnostic: no React, no hooks, no DOM.
 *
 * The parser receives a WsMsg and calls the appropriate store dispatch.
 * Side-effect callbacks (session assignment, reattach recovery) are injected
 * via the Callbacks interface so the store factory can wire them.
 */

import type {
  FinishedMessage,
  FinishedBlock,
  BlockType,
  ToolTier,
  RawToolInput,
} from '@mitzo/protocol';
import type { MessagesAction } from './slices/messages.js';
import type { WsMsg } from './server-messages.js';
import type { Task, LoopStatus } from './slices/tasks.js';
import type { TokensState } from './slices/tokens.js';
import type { ProgressUpdate } from './slices/progress.js';
import type { ProgressItem, ProgressItemStatus } from '@mitzo/protocol';

// ─── Callback interface ──────────────────────────────────────────────────────

export interface ProtocolCallbacks {
  /** Called when the server assigns or confirms a session ID. */
  onSessionAssigned(sessionId: string): void;

  /** Called when the server reports "No conversation found". */
  onSessionExpired(sessionId: string): void;

  /** Called after reattach_failed recovery restores messages from API. */
  onMessagesRestored?(messages: FinishedMessage[]): void;

  /** Called when the server renames a session. */
  onSessionRenamed?(name: string): void;

  /** Called to fetch messages from REST API for reattach recovery. */
  fetchMessages?(sessionId: string): Promise<FinishedMessage[]>;

  /** @deprecated v1 only — called to mark the WS pool entry as running/not-running. */
  setWsRunning?(poolKey: string, running: boolean): void;

  /** @deprecated v1 only — called to send a queued message after session_end. */
  sendQueued?(poolKey: string, msg: unknown): void;

  /** v2: Called when a queued message should be sent after session_end. */
  onSendQueued?(msg: Record<string, unknown>): void;

  /** v2: Called with token data from session_switched response. */
  onTokensHydrated?(tokens: Record<string, unknown>): void;

  /** v2: Called after WS reconnect completes — triggers message re-fetch. */
  onReconnected?(): void;
}

// ─── Parser state ────────────────────────────────────────────────────────────

export interface ProtocolParserState {
  /** Currently tracked session ID (used for expiry detection). */
  currentSessionId: string | undefined;

  /** Queued messages to send after current session ends (FIFO). */
  pendingSend: Record<string, unknown>[];
}

// ─── Parser result ───────────────────────────────────────────────────────────

export interface ParseResult {
  /** Messages actions to dispatch to the messages slice. */
  messagesActions: MessagesAction[];

  /** Tasks state update, if any. */
  tasksUpdate?:
    | { type: 'task_state'; tasks: Task[] }
    | { type: 'task_updated'; task: Task }
    | { type: 'task_deleted'; taskId: string }
    | { type: 'loop_status'; status: LoopStatus };

  /** Connection state update, if any. */
  connectionUpdate?: { status: 'connected' | 'disconnected' | 'reconnecting' };

  /** Token usage update, if any. */
  tokensUpdate?: Partial<TokensState>;

  /** Progress tracking update, if any. */
  progressUpdate?: ProgressUpdate;

  /** Inbox refresh signal. */
  inboxRefresh?: boolean;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export function parseServerMessage(
  msg: WsMsg,
  state: ProtocolParserState,
  callbacks: ProtocolCallbacks,
  poolKey: string,
): ParseResult {
  const result: ParseResult = { messagesActions: [] };

  switch (msg.type) {
    case '_open':
      result.connectionUpdate = { status: 'connected' };
      break;
    case '_close':
      result.connectionUpdate = { status: 'disconnected' };
      break;

    // ── v2 handshake events ────────────────────────────────────────────────

    case 'reconnected': {
      result.connectionUpdate = { status: 'connected' };
      // Apply authoritative running state from the server for the active session.
      // Validate runtime shape: sessions must be an array, and each entry must have
      // sessionId (string) and running (boolean). Explicit running === false check
      // guards against undefined/missing field.
      const sessions = msg.sessions as unknown;
      if (
        Array.isArray(sessions) &&
        state.currentSessionId &&
        sessions.every(
          (s): s is { sessionId: string; running: boolean } =>
            typeof s === 'object' &&
            s !== null &&
            typeof s.sessionId === 'string' &&
            typeof s.running === 'boolean',
        )
      ) {
        const active = sessions.find((s) => s.sessionId === state.currentSessionId);
        if (active && active.running === false) {
          result.messagesActions.push({ type: 'SET_RUNNING', running: false });
        }
      }
      callbacks.onReconnected?.();
      break;
    }

    case 'session_takeover':
      result.messagesActions.push({ type: 'SET_RUNNING', running: false });
      result.messagesActions.push({
        type: 'ERROR',
        error: 'Session resumed on another device.',
      });
      break;

    case 'session_switched': {
      const tokens = msg.tokens as Record<string, unknown> | undefined;
      if (tokens) {
        callbacks.onTokensHydrated?.(tokens);
      }
      break;
    }

    case 'session_cleared':
      break;

    // ── v1 handshake events (kept for backward compat) ─────────────────────

    case 'reattached':
      result.messagesActions.push({ type: 'SET_RUNNING', running: true });
      callbacks.setWsRunning?.(poolKey, true);
      result.connectionUpdate = { status: 'connected' };
      if (msg.sessionId) callbacks.onSessionAssigned(msg.sessionId as string);
      break;

    case 'reattach_failed':
      result.messagesActions.push({ type: 'SET_RUNNING', running: false });
      callbacks.setWsRunning?.(poolKey, false);
      result.connectionUpdate = { status: 'connected' };
      if (state.currentSessionId && callbacks.fetchMessages) {
        const sessionId = state.currentSessionId;
        callbacks
          .fetchMessages(sessionId)
          .then((msgs) => {
            if (Array.isArray(msgs) && msgs.length > 0) {
              callbacks.onMessagesRestored?.(msgs);
            }
          })
          .catch(() => {});
      }
      break;

    case 'session_info':
      result.messagesActions.push({
        type: 'SESSION_INFO',
        branch: msg.branch as string,
        isWorktree: msg.worktree as boolean,
        wtId: msg.wtId as string | undefined,
      });
      break;

    case 'boot_context': {
      const source = msg.source === 'contexgin' ? 'contexgin' : 'local-fallback';
      const sourceCount = typeof msg.sourceCount === 'number' ? msg.sourceCount : 0;
      const tokenCount = typeof msg.tokenCount === 'number' ? msg.tokenCount : 0;
      const tokenBudget = typeof msg.tokenBudget === 'number' ? msg.tokenBudget : 0;

      // Parse rich source metadata — accept objects with path+kind, fall back to string-only
      const rawSources = Array.isArray(msg.sources) ? msg.sources : [];
      const sources: Array<{ path: string; kind: string }> = [];
      for (const s of rawSources) {
        if (s && typeof s === 'object' && typeof (s as Record<string, unknown>).path === 'string') {
          const obj = s as Record<string, unknown>;
          sources.push({
            path: obj.path as string,
            kind: typeof obj.kind === 'string' ? obj.kind : 'reference',
          });
        } else if (typeof s === 'string') {
          sources.push({ path: s, kind: 'reference' });
        }
      }

      // Parse section metadata (shared shape for included + trimmed)
      const parseSections = (
        raw: unknown[],
      ): Array<{ source: string; heading: string; tokens: number; content: string }> => {
        const sections: Array<{
          source: string;
          heading: string;
          tokens: number;
          content: string;
        }> = [];
        for (const t of raw) {
          if (t && typeof t === 'object') {
            const obj = t as Record<string, unknown>;
            sections.push({
              source: typeof obj.source === 'string' ? obj.source : '',
              heading: typeof obj.heading === 'string' ? obj.heading : '',
              tokens: typeof obj.tokens === 'number' ? obj.tokens : 0,
              content: typeof obj.content === 'string' ? obj.content : '',
            });
          }
        }
        return sections;
      };

      const included = parseSections(Array.isArray(msg.included) ? msg.included : []);
      const trimmed = parseSections(Array.isArray(msg.trimmed) ? msg.trimmed : []);

      result.messagesActions.push({
        type: 'SET_BOOT_CONTEXT',
        bootContext: { source, sourceCount, tokenCount, tokenBudget, sources, included, trimmed },
      });
      break;
    }

    case 'worktree_opened':
      result.messagesActions.push({
        type: 'WORKTREE_OPENED',
        repoName: msg.repoName as string,
        path: msg.path as string,
      });
      break;

    case 'session_id':
      callbacks.onSessionAssigned(msg.sessionId as string);
      break;

    case 'session_renamed':
      callbacks.onSessionRenamed?.(msg.name as string);
      break;

    case 'message_start':
      result.messagesActions.push({
        type: 'MESSAGE_START',
        messageId: msg.messageId as string,
      });
      break;

    case 'block_start':
      result.messagesActions.push({
        type: 'BLOCK_START',
        messageId: msg.messageId as string,
        blockId: msg.blockId as string,
        blockType: msg.blockType as BlockType,
        toolName: msg.toolName as string | undefined,
      });
      break;

    case 'block_delta':
      result.messagesActions.push({
        type: 'BLOCK_DELTA',
        messageId: msg.messageId as string,
        blockId: msg.blockId as string,
        blockType: msg.blockType as BlockType,
        delta: msg.delta as string,
      });
      break;

    case 'block_end':
      result.messagesActions.push({
        type: 'BLOCK_END',
        messageId: msg.messageId as string,
        blockId: msg.blockId as string,
        blockType: msg.blockType as BlockType,
        toolName: msg.toolName as string | undefined,
        toolId: msg.toolId as string | undefined,
        input: msg.input as string | undefined,
        rawInput: msg.rawInput as RawToolInput | undefined,
      });
      break;

    case 'tool_result':
      result.messagesActions.push({
        type: 'TOOL_RESULT',
        toolId: msg.toolId as string,
        result: msg.result as string,
        isError: (msg.isError as boolean) ?? false,
      });
      break;

    case 'message_end':
      result.messagesActions.push({
        type: 'MESSAGE_END',
        messageId: msg.messageId as string,
        sessionId: msg.sessionId as string | undefined,
      });
      if (msg.sessionId && !state.currentSessionId) {
        callbacks.onSessionAssigned(msg.sessionId as string);
      }
      break;

    case 'message_snapshot':
      if (Array.isArray(msg.blocks)) {
        result.messagesActions.push({
          type: 'MESSAGE_SNAPSHOT',
          messageId: msg.messageId as string,
          blocks: msg.blocks as FinishedBlock[],
        });
      }
      break;

    case 'session_end': {
      result.messagesActions.push({
        type: 'SESSION_END',
        sessionId: msg.sessionId as string | undefined,
      });
      callbacks.setWsRunning?.(poolKey, false);
      if (msg.sessionId && !state.currentSessionId) {
        callbacks.onSessionAssigned(msg.sessionId as string);
      }
      const pending = state.pendingSend.shift();
      if (pending) {
        result.messagesActions.push({ type: 'SET_RUNNING', running: true });
        // v2 path: use onSendQueued callback (no pool key needed)
        if (callbacks.onSendQueued) {
          callbacks.onSendQueued(pending);
        } else {
          // v1 fallback
          callbacks.setWsRunning?.(poolKey, true);
          callbacks.sendQueued?.(poolKey, pending);
        }
      }
      break;
    }

    case 'permission_request':
      result.messagesActions.push({
        type: 'PERMISSION_REQUEST',
        payload: {
          permId: msg.permId as string,
          toolName: msg.toolName as string,
          toolInput: msg.toolInput as string,
          title: msg.title as string | undefined,
          description: msg.description as string | undefined,
          displayName: msg.displayName as string | undefined,
          tier: msg.tier as ToolTier | undefined,
        },
      });
      break;

    case 'permission_timeout':
      result.messagesActions.push({
        type: 'PERMISSION_TIMEOUT',
        permId: msg.permId as string,
      });
      break;

    case 'native_command_result':
      result.messagesActions.push({
        type: 'NATIVE_COMMAND_RESULT',
        command: msg.command as string,
        content: msg.content as string,
      });
      break;

    case 'session_close_ack':
      if (msg.accepted) {
        result.messagesActions.push({
          type: 'NATIVE_COMMAND_RESULT',
          command: 'close',
          content: 'Session closing... The agent will commit work and write a summary.',
        });
        result.messagesActions.push({ type: 'SET_RUNNING', running: false });
      }
      break;

    case 'skill_invoked':
      break;

    case 'subscribed':
      if (msg.running) {
        result.messagesActions.push({ type: 'SET_RUNNING', running: true });
        callbacks.setWsRunning?.(poolKey, true);
      }
      break;

    case 'user_message':
      result.messagesActions.push({
        type: 'USER_MESSAGE_RECEIVED',
        messageId: msg.messageId as string,
        text: msg.text as string,
      });
      break;

    case 'error': {
      const errorMsg = msg.error as string;

      callbacks.setWsRunning?.(poolKey, false);
      state.pendingSend = [];
      result.messagesActions.push({
        type: 'ERROR',
        error: errorMsg || 'Unknown error',
      });
      break;
    }

    // Task system messages
    case 'task_state':
      result.tasksUpdate = { type: 'task_state', tasks: msg.tasks as Task[] };
      break;

    case 'task_updated':
      result.tasksUpdate = { type: 'task_updated', task: msg.task as Task };
      break;

    case 'task_deleted':
      result.tasksUpdate = { type: 'task_deleted', taskId: msg.taskId as string };
      break;

    case 'loop_status':
      result.tasksUpdate = {
        type: 'loop_status',
        status: {
          state: msg.state as LoopStatus['state'],
          goalId: (msg.goalId as string | null) ?? null,
          activeTaskId: (msg.activeTaskId as string | null) ?? null,
          progress: (msg.progress as LoopStatus['progress']) ?? null,
          specMode: (msg.specMode as boolean) ?? false,
          awaitingApproval: (msg.awaitingApproval as boolean) ?? false,
        },
      };
      break;

    case 'token_update': {
      // Build partial update, omitting undefined fields so the store spread
      // does not clobber existing values (mid-turn updates lack sessionTotal).
      const tu: Partial<TokensState> = {
        agentContext: msg.agentContext as number,
        turnIndex: msg.turnIndex as number,
      };
      if (msg.contextCeiling != null) tu.contextCeiling = msg.contextCeiling as number;
      if (msg.sessionTotal != null) tu.sessionTotal = msg.sessionTotal as number;
      if (msg.numTurns != null) tu.numTurns = msg.numTurns as number;
      if (msg.numCompactions != null) tu.numCompactions = msg.numCompactions as number;
      result.tokensUpdate = tu;
      break;
    }

    // Progress tracking messages
    case 'progress_start':
      result.progressUpdate = {
        type: 'start',
        progressId: msg.progressId as string,
        messageId: msg.messageId as string,
        sourceToolId: msg.sourceToolId as string | undefined,
        items: msg.items as ProgressItem[],
      };
      break;

    case 'progress_update':
      result.progressUpdate = {
        type: 'update',
        progressId: msg.progressId as string,
        itemId: msg.itemId as string,
        status: msg.status as ProgressItemStatus,
      };
      break;

    case 'progress_replace':
      result.progressUpdate = {
        type: 'replace',
        progressId: msg.progressId as string,
        sourceToolId: msg.sourceToolId as string | undefined,
        items: msg.items as ProgressItem[],
      };
      break;

    case 'inbox_updated':
      result.inboxRefresh = true;
      break;

    // Subagent lifecycle messages
    case 'subagent_start':
      result.messagesActions.push({
        type: 'SUBAGENT_START',
        parentBlockId: msg.parentBlockId as string,
        subagentMessageId: msg.subagentMessageId as string,
      });
      break;

    case 'subagent_block_start':
      result.messagesActions.push({
        type: 'SUBAGENT_BLOCK_START',
        parentBlockId: msg.parentBlockId as string,
        blockId: msg.blockId as string,
        blockType: msg.blockType as BlockType,
        toolName: msg.toolName as string | undefined,
      });
      break;

    case 'subagent_block_delta':
      result.messagesActions.push({
        type: 'SUBAGENT_BLOCK_DELTA',
        parentBlockId: msg.parentBlockId as string,
        blockId: msg.blockId as string,
        delta: msg.delta as string,
      });
      break;

    case 'subagent_block_end':
      result.messagesActions.push({
        type: 'SUBAGENT_BLOCK_END',
        parentBlockId: msg.parentBlockId as string,
        blockId: msg.blockId as string,
        toolName: msg.toolName as string | undefined,
        toolId: msg.toolId as string | undefined,
        input: msg.input as string | undefined,
        rawInput: msg.rawInput as RawToolInput | undefined,
      });
      break;

    case 'subagent_tool_result':
      result.messagesActions.push({
        type: 'SUBAGENT_TOOL_RESULT',
        parentBlockId: msg.parentBlockId as string,
        toolId: msg.toolId as string,
        result: msg.result as string,
        isError: (msg.isError as boolean) ?? false,
      });
      break;

    case 'subagent_end':
      result.messagesActions.push({
        type: 'SUBAGENT_END',
        parentBlockId: msg.parentBlockId as string,
        summary: msg.summary as string | undefined,
        usage: msg.usage as
          | {
              inputTokens: number;
              outputTokens: number;
              cacheReadTokens: number;
              cacheCreationTokens: number;
            }
          | undefined,
      });
      break;

    case 'subagent_cancelled':
      result.messagesActions.push({
        type: 'SUBAGENT_END',
        parentBlockId: msg.parentBlockId as string,
        summary: 'Cancelled',
      });
      break;
  }

  return result;
}
