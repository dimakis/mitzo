import { useReducer, useRef, useEffect, useCallback } from 'react';
import { CHAT_CACHE_KEY_PREFIX } from '../lib/constants';
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

export interface ChatMessagesState {
  messages: FinishedMessage[];
  current: StreamingMessage | null; // in-flight assistant turn
  running: boolean;
  permission: PermissionRequest | null;
  branch: string | null;
  isWorktree: boolean;
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
  | { type: 'USER_SEND'; text: string; images?: string[] }
  | { type: 'SET_RUNNING'; running: boolean }
  | { type: 'CONNECTION_LOST' }
  | { type: 'PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'PERMISSION_TIMEOUT'; permId: string }
  | { type: 'RESTORE'; messages: FinishedMessage[] };

const INITIAL_STATE: ChatMessagesState = {
  messages: [],
  current: null,
  running: false,
  permission: null,
  branch: null,
  isWorktree: false,
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
      const block = new Map<string, StreamingBlock>();
      return {
        ...state,
        current: { messageId: action.messageId, blocks: block, blockOrder: [] },
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

    case 'RESTORE': {
      const valid = action.messages.filter(
        (m) => m && typeof m.messageId === 'string' && Array.isArray(m.blocks),
      );
      return { ...state, messages: valid };
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
) {
  const [state, dispatch] = useReducer(chatMessagesReducer, INITIAL_STATE);
  const pendingSend = useRef<Record<string, unknown> | null>(null);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  useEffect(() => {
    const id = currentSessionIdRef.current;
    if (!id || state.messages.length === 0) return;
    try {
      localStorage.setItem(`${CHAT_CACHE_KEY_PREFIX}${id}`, JSON.stringify(state.messages));
    } catch {
      // localStorage quota exceeded — non-fatal
    }
  }, [state.messages, currentSessionId]);

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
          if (currentSessionIdRef.current) {
            fetch(`/api/sessions/${currentSessionIdRef.current}/messages`, {
              credentials: 'include',
            })
              .then((r) => r.json())
              .then((data: { messages?: FinishedMessage[] }) => {
                if (data.messages?.length) dispatch({ type: 'RESTORE', messages: data.messages });
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

        case 'session_id':
          onSessionAssigned(msg.sessionId as string);
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
    [poolKey, onSessionAssigned, onSessionExpired],
  );

  return { state, dispatch, pendingSend, handleWsMessage };
}
