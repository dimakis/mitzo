import { useReducer, useRef, useCallback } from 'react';
import type {
  FinishedMessage,
  FinishedBlock,
  StreamingMessage,
  StreamingBlock,
  PermissionRequest,
  ToolTier,
  RawToolInput,
  BlockType,
} from '../types/chat';
import type { WsMsg } from '../lib/ws-pool';
import { wsSetRunning, wsSend } from '../lib/ws-pool';

export interface ActiveWorktree {
  repoName: string;
  path: string;
}

export interface ChatMessagesState {
  messages: FinishedMessage[];
  current: StreamingMessage | null; // in-flight assistant turn
  running: boolean;
  permission: PermissionRequest | null;
  branch: string | null;
  isWorktree: boolean;
  activeWorktrees: ActiveWorktree[];
}

export type ChatMessagesAction =
  // v2 content events
  | { type: 'MESSAGE_START'; messageId: string }
  | {
      type: 'BLOCK_START';
      messageId: string;
      blockId: string;
      blockType: BlockType;
      toolName?: string;
    }
  | { type: 'BLOCK_DELTA'; messageId: string; blockId: string; blockType: BlockType; delta: string }
  | {
      type: 'BLOCK_END';
      messageId: string;
      blockId: string;
      blockType: BlockType;
      toolName?: string;
      toolId?: string;
      input?: string;
      rawInput?: RawToolInput;
    }
  | {
      type: 'TOOL_RESULT';
      toolId: string;
      result: string;
      isError: boolean;
    }
  | { type: 'MESSAGE_END'; messageId: string; sessionId?: string }
  | { type: 'SESSION_END'; sessionId?: string }
  // Reattach snapshot
  | { type: 'MESSAGE_SNAPSHOT'; messageId: string; blocks: FinishedBlock[] }
  // Session / UI lifecycle
  | { type: 'ERROR'; error: string }
  | { type: 'SESSION_INFO'; branch: string; isWorktree: boolean }
  | { type: 'USER_SEND'; text: string; images?: string[]; contextNames?: string[] }
  | { type: 'SET_RUNNING'; running: boolean }
  | { type: 'CONNECTION_LOST' }
  | { type: 'PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'PERMISSION_TIMEOUT'; permId: string }
  | { type: 'RESTORE'; messages: FinishedMessage[]; interrupted?: boolean }
  | { type: 'USER_MESSAGE_RECEIVED'; messageId: string; text: string }
  | { type: 'WORKTREE_OPENED'; repoName: string; path: string }
  | { type: 'NATIVE_COMMAND_RESULT'; command: string; content: string };

const INITIAL_STATE: ChatMessagesState = {
  messages: [],
  current: null,
  running: false,
  permission: null,
  branch: null,
  isWorktree: false,
  activeWorktrees: [],
};

function finishCurrent(current: StreamingMessage): FinishedMessage {
  const blocks: FinishedBlock[] = current.blockOrder.map((blockId) => {
    const b = current.blocks.get(blockId)!;
    return {
      blockId: b.blockId,
      blockType: b.blockType,
      content: b.content,
      toolName: b.toolName,
      toolId: b.toolId,
      toolInput: b.toolInput,
      rawInput: b.rawInput,
      toolResult: b.toolResult,
      toolError: b.toolError,
    };
  });
  return { messageId: current.messageId, role: 'assistant', blocks };
}

function patchToolResult(
  messages: FinishedMessage[],
  current: StreamingMessage | null,
  toolId: string,
  result: string,
  isError: boolean,
): { messages: FinishedMessage[]; current: StreamingMessage | null } {
  // Check current first (tool result may arrive before message_end in edge cases).
  if (current) {
    for (const block of current.blocks.values()) {
      if (block.toolId === toolId) {
        const newBlocks = new Map(current.blocks);
        newBlocks.set(block.blockId, { ...block, toolResult: result, toolError: isError });
        return { messages, current: { ...current, blocks: newBlocks } };
      }
    }
  }
  // Search finished messages.
  const newMessages = messages.map((msg) => {
    const idx = msg.blocks.findIndex((b) => b.toolId === toolId);
    if (idx === -1) return msg;
    const newBlocks = [...msg.blocks];
    newBlocks[idx] = { ...newBlocks[idx], toolResult: result, toolError: isError };
    return { ...msg, blocks: newBlocks };
  });
  return { messages: newMessages, current };
}

export function chatMessagesReducer(
  state: ChatMessagesState,
  action: ChatMessagesAction,
): ChatMessagesState {
  switch (action.type) {
    case 'MESSAGE_START': {
      const base = state.current
        ? { ...state, messages: [...state.messages, finishCurrent(state.current)] }
        : state;
      return {
        ...base,
        current: {
          messageId: action.messageId,
          blocks: new Map<string, StreamingBlock>(),
          blockOrder: [],
        },
      };
    }

    case 'BLOCK_START': {
      if (!state.current) return state;
      const newBlock: StreamingBlock = {
        blockId: action.blockId,
        blockType: action.blockType,
        content: '',
        done: false,
        ...(action.toolName ? { toolName: action.toolName } : {}),
      };
      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.blockId, newBlock);
      return {
        ...state,
        current: {
          ...state.current,
          blocks: newBlocks,
          blockOrder: [...state.current.blockOrder, action.blockId],
        },
      };
    }

    case 'BLOCK_DELTA': {
      if (!state.current) return state;
      const block = state.current.blocks.get(action.blockId);
      if (!block) return state;
      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.blockId, { ...block, content: block.content + action.delta });
      return { ...state, current: { ...state.current, blocks: newBlocks } };
    }

    case 'BLOCK_END': {
      if (!state.current) return state;
      const block = state.current.blocks.get(action.blockId);
      if (!block) return state;
      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.blockId, {
        ...block,
        done: true,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.toolId ? { toolId: action.toolId } : {}),
        ...(action.input ? { toolInput: action.input } : {}),
        ...(action.rawInput ? { rawInput: action.rawInput } : {}),
      });
      return { ...state, current: { ...state.current, blocks: newBlocks } };
    }

    case 'TOOL_RESULT': {
      const { messages, current } = patchToolResult(
        state.messages,
        state.current,
        action.toolId,
        action.result,
        action.isError,
      );
      return { ...state, messages, current };
    }

    case 'MESSAGE_END': {
      if (!state.current) return { ...state };
      const finished = finishCurrent(state.current);
      return { ...state, messages: [...state.messages, finished], current: null };
    }

    case 'SESSION_END': {
      if (state.current) {
        const finished = finishCurrent(state.current);
        return {
          ...state,
          running: false,
          messages: [...state.messages, finished],
          current: null,
        };
      }
      return { ...state, running: false };
    }

    case 'MESSAGE_SNAPSHOT': {
      // Reconstruct in-flight state from server snapshot on reattach.
      const snapshotBlocks = action.blocks ?? [];
      if (!Array.isArray(snapshotBlocks) || snapshotBlocks.length === 0) return state;
      const blocks = new Map<string, StreamingBlock>();
      const blockOrder: string[] = [];
      for (const b of snapshotBlocks) {
        blocks.set(b.blockId, {
          blockId: b.blockId,
          blockType: b.blockType as BlockType,
          content: b.content ?? '',
          done: (b as unknown as { done?: boolean }).done ?? false,
          toolName: b.toolName,
          toolId: b.toolId,
          toolInput: b.toolInput,
          rawInput: b.rawInput,
          toolResult: b.toolResult,
          toolError: b.toolError,
        });
        blockOrder.push(b.blockId);
      }
      return { ...state, current: { messageId: action.messageId, blocks, blockOrder } };
    }

    case 'PERMISSION_REQUEST':
      return { ...state, permission: action.payload };

    case 'PERMISSION_TIMEOUT':
      return {
        ...state,
        permission: state.permission?.permId === action.permId ? null : state.permission,
      };

    case 'ERROR':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            messageId: `err-${Date.now()}`,
            role: 'assistant',
            blocks: [
              {
                blockId: `err-${Date.now()}`,
                blockType: 'text',
                content: `**Error:** ${action.error}`,
              },
            ],
          },
        ],
        running: false,
        current: null,
      };

    case 'SESSION_INFO':
      return { ...state, branch: action.branch, isWorktree: action.isWorktree };

    case 'WORKTREE_OPENED': {
      const already = state.activeWorktrees.some((w) => w.repoName === action.repoName);
      if (already) return state;
      return {
        ...state,
        activeWorktrees: [
          ...state.activeWorktrees,
          { repoName: action.repoName, path: action.path },
        ],
      };
    }

    case 'NATIVE_COMMAND_RESULT': {
      // Render native command results as a system-style assistant message
      const cmdMsg: FinishedMessage = {
        messageId: `native-${Date.now()}`,
        role: 'assistant',
        blocks: [
          {
            blockId: `native-b-${Date.now()}`,
            blockType: 'text',
            content: action.content,
          },
        ],
      };
      return {
        ...state,
        messages: [...state.messages, cmdMsg],
      };
    }

    case 'RESTORE': {
      const valid = action.messages.filter(
        (m) => m && typeof m.messageId === 'string' && Array.isArray(m.blocks),
      );
      // Don't replace if state already has all the API messages (e.g. from
      // buffer drain that added messages the API hasn't persisted yet).
      // Use messageId-based comparison instead of array length — length
      // comparison silently rejects valid API data when stale pool state
      // happens to have more entries.
      if (!action.interrupted) {
        const existingIds = new Set(state.messages.map((m) => m.messageId));
        const hasNewMessages = valid.some((m) => !existingIds.has(m.messageId));
        if (!hasNewMessages && state.messages.length > 0) {
          return state;
        }
      }
      if (action.interrupted) {
        const notice: FinishedMessage = {
          messageId: `notice-${Date.now()}`,
          role: 'assistant',
          blocks: [
            {
              blockId: `notice-text-${Date.now()}`,
              blockType: 'text',
              content:
                '**Session interrupted.** Messages above were restored from history — some recent content may be missing.',
            },
          ],
        };
        return { ...state, messages: [...valid, notice] };
      }
      return { ...state, messages: valid };
    }

    case 'USER_MESSAGE_RECEIVED': {
      // Server-side user_message event (from reattach replay or live emit).
      // Deduplicate: USER_SEND already added this message client-side during
      // the live session, so skip if a message with this ID already exists.
      if (state.messages.some((m) => m.messageId === action.messageId)) {
        return state;
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            messageId: action.messageId,
            role: 'user',
            blocks: [
              {
                blockId: `user-text-${action.messageId}`,
                blockType: 'text' as BlockType,
                content: action.text,
              },
            ],
          },
        ],
      };
    }

    case 'USER_SEND':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            messageId: `user-${Date.now()}`,
            role: 'user',
            blocks: [],
            images: action.images,
            contextNames: action.contextNames,
            // Store text in a synthetic text block for rendering convenience.
            ...(action.text
              ? {
                  blocks: [
                    {
                      blockId: `user-text-${Date.now()}`,
                      blockType: 'text' as BlockType,
                      content: action.text,
                    },
                  ],
                }
              : {}),
          },
        ],
        running: true,
      };

    case 'SET_RUNNING':
      return { ...state, running: action.running };

    case 'CONNECTION_LOST':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            messageId: `conn-${Date.now()}`,
            role: 'assistant',
            blocks: [
              {
                blockId: `conn-text-${Date.now()}`,
                blockType: 'text',
                content: '**Connection lost.** Reconnecting — try again in a moment.',
              },
            ],
          },
        ],
      };

    default:
      return state;
  }
}

export function useChatMessages(
  poolKey: string,
  currentSessionId: string | undefined,
  onSessionAssigned: (id: string) => void,
  onSessionExpired: (sessionId: string | undefined) => void,
  onMessagesRestored?: () => void,
  onSessionRenamed?: (name: string) => void,
) {
  const [state, dispatch] = useReducer(chatMessagesReducer, INITIAL_STATE);
  const pendingSend = useRef<Record<string, unknown> | null>(null);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const reattachAbort = useRef<AbortController | null>(null);

  const handleWsMessage = useCallback(
    (msg: WsMsg) => {
      switch (msg.type) {
        case '_open':
        case '_close':
          break;

        case 'reattached':
          dispatch({ type: 'SET_RUNNING', running: true });
          wsSetRunning(poolKey, true);
          if (msg.sessionId) onSessionAssigned(msg.sessionId as string);
          break;

        case 'reattach_failed':
          dispatch({ type: 'SET_RUNNING', running: false });
          wsSetRunning(poolKey, false);
          // Session is gone — try to restore from the events API as a last resort.
          if (currentSessionIdRef.current) {
            reattachAbort.current?.abort();
            const controller = new AbortController();
            reattachAbort.current = controller;
            fetch(`/api/sessions/${currentSessionIdRef.current}/messages`, {
              credentials: 'include',
              signal: controller.signal,
            })
              .then((r) => r.json())
              .then((msgs: FinishedMessage[]) => {
                if (controller.signal.aborted) return;
                if (Array.isArray(msgs) && msgs.length > 0) {
                  dispatch({ type: 'RESTORE', messages: msgs, interrupted: true });
                  onMessagesRestored?.();
                }
              })
              .catch(() => {});
          }
          break;

        case 'session_info':
          dispatch({
            type: 'SESSION_INFO',
            branch: msg.branch as string,
            isWorktree: msg.worktree as boolean,
          });
          break;

        case 'worktree_opened':
          dispatch({
            type: 'WORKTREE_OPENED',
            repoName: msg.repoName as string,
            path: msg.path as string,
          });
          break;

        case 'session_id':
          onSessionAssigned(msg.sessionId as string);
          break;

        case 'session_renamed':
          onSessionRenamed?.(msg.name as string);
          break;

        // v2 events
        case 'message_start':
          dispatch({ type: 'MESSAGE_START', messageId: msg.messageId as string });
          break;

        case 'block_start':
          dispatch({
            type: 'BLOCK_START',
            messageId: msg.messageId as string,
            blockId: msg.blockId as string,
            blockType: msg.blockType as BlockType,
            toolName: msg.toolName as string | undefined,
          });
          break;

        case 'block_delta':
          dispatch({
            type: 'BLOCK_DELTA',
            messageId: msg.messageId as string,
            blockId: msg.blockId as string,
            blockType: msg.blockType as BlockType,
            delta: msg.delta as string,
          });
          break;

        case 'block_end':
          dispatch({
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
          dispatch({
            type: 'TOOL_RESULT',
            toolId: msg.toolId as string,
            result: msg.result as string,
            isError: (msg.isError as boolean) ?? false,
          });
          break;

        case 'message_end':
          dispatch({
            type: 'MESSAGE_END',
            messageId: msg.messageId as string,
            sessionId: msg.sessionId as string | undefined,
          });
          if (msg.sessionId && !currentSessionIdRef.current) {
            onSessionAssigned(msg.sessionId as string);
          }
          break;

        case 'message_snapshot':
          if (Array.isArray(msg.blocks)) {
            dispatch({
              type: 'MESSAGE_SNAPSHOT',
              messageId: msg.messageId as string,
              blocks: msg.blocks as FinishedBlock[],
            });
          }
          break;

        case 'session_end': {
          dispatch({ type: 'SESSION_END', sessionId: msg.sessionId as string | undefined });
          wsSetRunning(poolKey, false);
          if (msg.sessionId && !currentSessionIdRef.current) {
            onSessionAssigned(msg.sessionId as string);
          }
          const pending = pendingSend.current;
          if (pending) {
            pendingSend.current = null;
            dispatch({ type: 'SET_RUNNING', running: true });
            wsSetRunning(poolKey, true);
            wsSend(poolKey, pending);
          }
          break;
        }

        case 'permission_request':
          dispatch({
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
          dispatch({ type: 'PERMISSION_TIMEOUT', permId: msg.permId as string });
          break;

        case 'native_command_result':
          dispatch({
            type: 'NATIVE_COMMAND_RESULT',
            command: msg.command as string,
            content: msg.content as string,
          });
          break;

        case 'skill_invoked':
          // TODO: Implement skill badge rendering on the last user message
          break;

        case 'user_message':
          dispatch({
            type: 'USER_MESSAGE_RECEIVED',
            messageId: msg.messageId as string,
            text: msg.text as string,
          });
          break;

        case 'error': {
          const errorMsg = msg.error as string;
          wsSetRunning(poolKey, false);
          pendingSend.current = null;
          if (errorMsg?.includes('No conversation found')) {
            onSessionExpired(currentSessionIdRef.current);
            dispatch({
              type: 'ERROR',
              error: 'Session expired. Send your message again to start fresh.',
            });
          } else {
            dispatch({ type: 'ERROR', error: errorMsg || 'Unknown error' });
          }
          break;
        }
      }
    },
    [poolKey, onSessionAssigned, onSessionExpired, onMessagesRestored],
  );

  return {
    state,
    dispatch,
    pendingSend,
    handleWsMessage,
  };
}
