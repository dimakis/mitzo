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
  fetchMessages?(sessionId: string, signal: AbortSignal): Promise<FinishedMessage[]>;

  /** Called to mark the WS pool entry as running/not-running. */
  setWsRunning?(poolKey: string, running: boolean): void;

  /** Called to send a queued message after session_end. */
  sendQueued?(poolKey: string, msg: unknown): void;
}

// ─── Parser state ────────────────────────────────────────────────────────────

export interface ProtocolParserState {
  /** Currently tracked session ID (used for expiry detection). */
  currentSessionId: string | undefined;

  /** Queued message to send after current session ends. */
  pendingSend: Record<string, unknown> | null;
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
    case '_close':
      break;

    case 'reattached':
      result.messagesActions.push({ type: 'SET_RUNNING', running: true });
      callbacks.setWsRunning?.(poolKey, true);
      if (msg.sessionId) callbacks.onSessionAssigned(msg.sessionId as string);
      break;

    case 'reattach_failed':
      result.messagesActions.push({ type: 'SET_RUNNING', running: false });
      callbacks.setWsRunning?.(poolKey, false);
      if (state.currentSessionId && callbacks.fetchMessages) {
        const sessionId = state.currentSessionId;
        const controller = new AbortController();
        callbacks
          .fetchMessages(sessionId, controller.signal)
          .then((msgs) => {
            if (controller.signal.aborted) return;
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
      const pending = state.pendingSend;
      if (pending) {
        state.pendingSend = null;
        result.messagesActions.push({ type: 'SET_RUNNING', running: true });
        callbacks.setWsRunning?.(poolKey, true);
        callbacks.sendQueued?.(poolKey, pending);
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
      state.pendingSend = null;
      if (errorMsg?.includes('No conversation found')) {
        if (state.currentSessionId) {
          callbacks.onSessionExpired(state.currentSessionId);
        }
        result.messagesActions.push({
          type: 'ERROR',
          error: 'Session expired. Send your message again to start fresh.',
        });
      } else {
        result.messagesActions.push({
          type: 'ERROR',
          error: errorMsg || 'Unknown error',
        });
      }
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

    case 'inbox_updated':
      result.inboxRefresh = true;
      break;
  }

  return result;
}
