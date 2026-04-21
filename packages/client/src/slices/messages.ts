/**
 * Messages slice — pure state management for chat messages.
 *
 * Extracted from frontend/src/hooks/useChatMessages.ts.
 * Framework-agnostic: no React, no hooks, no DOM.
 */

import type {
  FinishedMessage,
  FinishedBlock,
  StreamingMessage,
  StreamingBlock,
  PermissionRequest,
  RawToolInput,
  BlockType,
} from '@mitzo/protocol';

// ─── State ───────────────────────────────────────────────────────────────────

export interface ActiveWorktree {
  repoName: string;
  path: string;
}

export interface MessagesState {
  messages: FinishedMessage[];
  current: StreamingMessage | null;
  running: boolean;
  permission: PermissionRequest | null;
  branch: string | null;
  isWorktree: boolean;
  wtId: string | null;
  activeWorktrees: ActiveWorktree[];
  sessionContext: string | null;
}

export const INITIAL_MESSAGES_STATE: MessagesState = {
  messages: [],
  current: null,
  running: false,
  permission: null,
  branch: null,
  isWorktree: false,
  wtId: null,
  activeWorktrees: [],
  sessionContext: null,
};

// ─── Actions ─────────────────────────────────────────────────────────────────

export type MessagesAction =
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
  | { type: 'SESSION_INFO'; branch: string; isWorktree: boolean; wtId?: string }
  | {
      type: 'USER_SEND';
      text: string;
      clientMsgId: string;
      images?: string[];
      contextBlocks?: string[];
    }
  | { type: 'SET_RUNNING'; running: boolean }
  | { type: 'CONNECTION_LOST' }
  | { type: 'PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'PERMISSION_TIMEOUT'; permId: string }
  | { type: 'RESTORE'; messages: FinishedMessage[]; interrupted?: boolean }
  | { type: 'USER_MESSAGE_RECEIVED'; messageId: string; text: string }
  | { type: 'WORKTREE_OPENED'; repoName: string; path: string }
  | { type: 'NATIVE_COMMAND_RESULT'; command: string; content: string }
  | { type: 'SET_SESSION_CONTEXT'; context: string }
  | { type: 'CLEAR' };

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function finishCurrent(current: StreamingMessage): FinishedMessage {
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
  return { messageId: current.messageId, role: 'assistant', blocks, timestamp: Date.now() };
}

export function patchToolResult(
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

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function messagesReducer(state: MessagesState, action: MessagesAction): MessagesState {
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
            timestamp: Date.now(),
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
      return {
        ...state,
        branch: action.branch,
        isWorktree: action.isWorktree,
        wtId: action.isWorktree ? (action.wtId ?? state.wtId) : null,
      };

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
      const cmdMsg: FinishedMessage = {
        messageId: `native-${Date.now()}`,
        role: 'assistant',
        timestamp: Date.now(),
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

    case 'SET_SESSION_CONTEXT':
      return { ...state, sessionContext: action.context };

    case 'CLEAR':
      return { ...INITIAL_MESSAGES_STATE };

    case 'RESTORE': {
      const valid = action.messages.filter(
        (m) => m && typeof m.messageId === 'string' && Array.isArray(m.blocks),
      );
      if (!action.interrupted) {
        const existingIds = new Set(state.messages.map((m) => m.messageId));
        const hasNewMessages = valid.some((m) => !existingIds.has(m.messageId));
        if (!hasNewMessages && state.messages.length > 0) {
          return state;
        }
      }
      if (action.interrupted) {
        const restoredIds = new Set(valid.map((m) => m.messageId));
        const optimisticUserMsgs = state.messages.filter(
          (m) =>
            m.role === 'user' && m.messageId.startsWith('user-') && !restoredIds.has(m.messageId),
        );
        const notice: FinishedMessage = {
          messageId: `notice-${Date.now()}`,
          role: 'assistant',
          timestamp: Date.now(),
          blocks: [
            {
              blockId: `notice-text-${Date.now()}`,
              blockType: 'text',
              content:
                '**Session interrupted.** Messages above were restored from history — some recent content may be missing.',
            },
          ],
        };
        const merged: FinishedMessage[] = [...valid];
        for (const opt of optimisticUserMsgs) {
          const localIdx = state.messages.indexOf(opt);
          let insertAfter = -1;
          for (let i = localIdx - 1; i >= 0; i--) {
            const precedingId = state.messages[i].messageId;
            const restoredIdx = merged.findIndex((m) => m.messageId === precedingId);
            if (restoredIdx !== -1) {
              insertAfter = restoredIdx;
              break;
            }
          }
          merged.splice(insertAfter + 1, 0, opt);
        }
        merged.push(notice);
        return { ...state, messages: merged };
      }
      return { ...state, messages: valid };
    }

    case 'USER_MESSAGE_RECEIVED': {
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
            timestamp: Date.now(),
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
            messageId: action.clientMsgId,
            role: 'user',
            timestamp: Date.now(),
            blocks: [],
            images: action.images,
            contextBlocks: action.contextBlocks,
            ...(action.text
              ? {
                  blocks: [
                    {
                      blockId: `user-text-${action.clientMsgId}`,
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
            timestamp: Date.now(),
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
