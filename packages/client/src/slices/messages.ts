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
  StreamingSubagentState,
  FinishedSubagentState,
  ToolResultImage,
} from '@mitzo/protocol';

// ─── Context inventory ──────────────────────────────────────────────────────

export interface ContextEntry {
  type: 'file_read' | 'search' | 'web_search' | 'web_fetch';
  key: string;
  label: string;
  count: number;
}

function extractContextEntry(
  toolName?: string,
  input?: string,
): { type: ContextEntry['type']; key: string } | null {
  if (!toolName || !input) return null;
  switch (toolName) {
    case 'Read':
      return { type: 'file_read', key: input };
    case 'Grep':
    case 'Glob':
      return { type: 'search', key: input };
    case 'WebSearch':
      return { type: 'web_search', key: input };
    case 'WebFetch':
      return { type: 'web_fetch', key: input };
    default:
      return null;
  }
}

function accumulateContext(
  existing: ContextEntry[],
  toolName?: string,
  input?: string,
): ContextEntry[] {
  const entry = extractContextEntry(toolName, input);
  if (!entry) return existing;
  const dedupKey = `${entry.type}:${entry.key}`;
  const idx = existing.findIndex((e) => `${e.type}:${e.key}` === dedupKey);
  if (idx !== -1) {
    const updated = [...existing];
    updated[idx] = { ...updated[idx], count: updated[idx].count + 1 };
    return updated;
  }
  return [...existing, { type: entry.type, key: entry.key, label: entry.key, count: 1 }];
}

function rebuildContextFromMessages(messages: FinishedMessage[]): ContextEntry[] {
  let ctx: ContextEntry[] = [];
  for (const msg of messages) {
    for (const block of msg.blocks) {
      ctx = accumulateContext(ctx, block.toolName, block.toolInput);
      // Include subagent tool calls
      if (block.subagent && Array.isArray(block.subagent.blocks)) {
        for (const sub of block.subagent.blocks) {
          ctx = accumulateContext(ctx, sub.toolName, sub.toolInput);
        }
      }
    }
  }
  return ctx;
}

// ─── State ───────────────────────────────────────────────────────────────────

export interface ActiveWorktree {
  repoName: string;
  path: string;
}

export interface BootSourceMeta {
  path: string;
  kind: string;
}

export interface SectionMeta {
  source: string;
  heading: string;
  tokens: number;
  content: string;
}

export interface BootContextMeta {
  source: 'contexgin' | 'local-fallback';
  sourceCount: number;
  tokenCount: number;
  tokenBudget: number;
  sources: BootSourceMeta[];
  included: SectionMeta[];
  trimmed: SectionMeta[];
  fullMarkdown?: string;
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
  bootContext: BootContextMeta | null;
  contextConsumed: ContextEntry[];
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
  bootContext: null,
  contextConsumed: [],
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
      images?: ToolResultImage[];
    }
  | { type: 'MESSAGE_END'; messageId: string; sessionId?: string }
  | { type: 'SESSION_END'; sessionId?: string }
  // Subagent events
  | { type: 'SUBAGENT_START'; parentBlockId: string; subagentMessageId: string }
  | {
      type: 'SUBAGENT_BLOCK_START';
      parentBlockId: string;
      blockId: string;
      blockType: BlockType;
      toolName?: string;
    }
  | { type: 'SUBAGENT_BLOCK_DELTA'; parentBlockId: string; blockId: string; delta: string }
  | {
      type: 'SUBAGENT_BLOCK_END';
      parentBlockId: string;
      blockId: string;
      toolName?: string;
      toolId?: string;
      input?: string;
      rawInput?: RawToolInput;
    }
  | {
      type: 'SUBAGENT_TOOL_RESULT';
      parentBlockId: string;
      toolId: string;
      result: string;
      isError: boolean;
      images?: ToolResultImage[];
    }
  | {
      type: 'SUBAGENT_END';
      parentBlockId: string;
      summary?: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
      };
    }
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
  | { type: 'SET_BOOT_CONTEXT'; bootContext: BootContextMeta }
  | { type: 'CLEAR' };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Narrow a block's subagent to StreamingSubagentState, or null if already finished. */
function getStreamingSubagent(block: StreamingBlock): StreamingSubagentState | null {
  if (!block.subagent || !('blockOrder' in block.subagent)) return null;
  return block.subagent;
}

function finishSubagent(
  sub: StreamingSubagentState | FinishedSubagentState,
): FinishedSubagentState {
  // Already finished (SUBAGENT_END already fired)
  if (Array.isArray(sub.blocks)) return sub as FinishedSubagentState;

  // Still streaming — convert Map<string, StreamingBlock> to FinishedBlock[]
  const streaming = sub as StreamingSubagentState;
  return {
    messageId: streaming.messageId,
    blocks: streaming.blockOrder
      .map((blockId) => streaming.blocks.get(blockId))
      .filter((b): b is StreamingBlock => b != null)
      .map((b) => ({
        blockId: b.blockId,
        blockType: b.blockType,
        content: b.content,
        toolName: b.toolName,
        toolId: b.toolId,
        toolInput: b.toolInput,
        rawInput: b.rawInput,
        toolResult: b.toolResult,
        toolResultImages: b.toolResultImages,
        toolError: b.toolError,
      })),
  };
}

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
      toolResultImages: b.toolResultImages,
      toolError: b.toolError,
      subagent: b.subagent ? finishSubagent(b.subagent) : undefined,
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
  images?: ToolResultImage[],
): { messages: FinishedMessage[]; current: StreamingMessage | null } {
  const imgPatch = images && images.length > 0 ? { toolResultImages: images } : {};
  // Check current first (tool result may arrive before message_end in edge cases).
  if (current) {
    for (const block of current.blocks.values()) {
      if (block.toolId === toolId) {
        const newBlocks = new Map(current.blocks);
        newBlocks.set(block.blockId, {
          ...block,
          toolResult: result,
          toolError: isError,
          ...imgPatch,
        });
        return { messages, current: { ...current, blocks: newBlocks } };
      }
    }
  }
  // Search finished messages.
  const newMessages = messages.map((msg) => {
    const idx = msg.blocks.findIndex((b) => b.toolId === toolId);
    if (idx === -1) return msg;
    const newBlocks = [...msg.blocks];
    newBlocks[idx] = { ...newBlocks[idx], toolResult: result, toolError: isError, ...imgPatch };
    return { ...msg, blocks: newBlocks };
  });
  return { messages: newMessages, current };
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function messagesReducer(state: MessagesState, action: MessagesAction): MessagesState {
  switch (action.type) {
    case 'MESSAGE_START': {
      // Dedup: skip if this message was already restored (e.g. WS replay after RESTORE)
      if (state.messages.some((m) => m.messageId === action.messageId)) {
        return state;
      }
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
      const toolName = action.toolName ?? block.toolName;
      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.blockId, {
        ...block,
        done: true,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.toolId ? { toolId: action.toolId } : {}),
        ...(action.input ? { toolInput: action.input } : {}),
        ...(action.rawInput ? { rawInput: action.rawInput } : {}),
      });
      return {
        ...state,
        current: { ...state.current, blocks: newBlocks },
        contextConsumed: accumulateContext(state.contextConsumed, toolName, action.input),
      };
    }

    case 'TOOL_RESULT': {
      const { messages, current } = patchToolResult(
        state.messages,
        state.current,
        action.toolId,
        action.result,
        action.isError,
        action.images,
      );
      return { ...state, messages, current };
    }

    case 'MESSAGE_END': {
      if (!state.current) return state;
      // Dedup: if this message was already restored, discard the streaming copy
      if (state.messages.some((m) => m.messageId === state.current!.messageId)) {
        return { ...state, current: null };
      }
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
          toolResultImages: b.toolResultImages,
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

    case 'SET_BOOT_CONTEXT':
      return { ...state, bootContext: action.bootContext };

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
        const currentStale =
          state.current && merged.some((m) => m.messageId === state.current!.messageId);
        return {
          ...state,
          messages: merged,
          current: currentStale ? null : state.current,
          contextConsumed: rebuildContextFromMessages(merged),
        };
      }
      // Clear current if the restored set already contains it (prevents
      // MESSAGE_END from re-inserting a message that RESTORE already has).
      const currentStale =
        state.current && valid.some((m) => m.messageId === state.current!.messageId);
      return {
        ...state,
        messages: valid,
        current: currentStale ? null : state.current,
        contextConsumed: rebuildContextFromMessages(valid),
      };
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

    // Subagent reducer cases
    case 'SUBAGENT_START': {
      if (!state.current) return state;
      const block = state.current.blocks.get(action.parentBlockId);
      if (!block) return state;

      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.parentBlockId, {
        ...block,
        subagent: {
          messageId: action.subagentMessageId,
          blocks: new Map(),
          blockOrder: [],
          running: true,
        },
      });

      return { ...state, current: { ...state.current, blocks: newBlocks } };
    }

    case 'SUBAGENT_BLOCK_START': {
      if (!state.current) return state;
      const parentBlock = state.current.blocks.get(action.parentBlockId);
      if (!parentBlock) return state;
      const sub = getStreamingSubagent(parentBlock);
      if (!sub) return state;

      const newBlock: StreamingBlock = {
        blockId: action.blockId,
        blockType: action.blockType,
        content: '',
        done: false,
        ...(action.toolName ? { toolName: action.toolName } : {}),
      };

      const newSubBlocks = new Map(sub.blocks);
      newSubBlocks.set(action.blockId, newBlock);

      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.parentBlockId, {
        ...parentBlock,
        subagent: {
          ...sub,
          blocks: newSubBlocks,
          blockOrder: [...sub.blockOrder, action.blockId],
        },
      });

      return { ...state, current: { ...state.current, blocks: newBlocks } };
    }

    case 'SUBAGENT_BLOCK_DELTA': {
      if (!state.current) return state;
      const parentBlock = state.current.blocks.get(action.parentBlockId);
      if (!parentBlock) return state;
      const sub = getStreamingSubagent(parentBlock);
      if (!sub) return state;

      const subBlock = sub.blocks.get(action.blockId);
      if (!subBlock) return state;

      const newSubBlocks = new Map(sub.blocks);
      newSubBlocks.set(action.blockId, {
        ...subBlock,
        content: subBlock.content + action.delta,
      });

      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.parentBlockId, {
        ...parentBlock,
        subagent: { ...sub, blocks: newSubBlocks },
      });

      return { ...state, current: { ...state.current, blocks: newBlocks } };
    }

    case 'SUBAGENT_BLOCK_END': {
      if (!state.current) return state;
      const parentBlock = state.current.blocks.get(action.parentBlockId);
      if (!parentBlock) return state;
      const sub = getStreamingSubagent(parentBlock);
      if (!sub) return state;

      const subBlock = sub.blocks.get(action.blockId);
      if (!subBlock) return state;
      const subToolName = action.toolName ?? subBlock.toolName;

      const newSubBlocks = new Map(sub.blocks);
      newSubBlocks.set(action.blockId, {
        ...subBlock,
        done: true,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.toolId ? { toolId: action.toolId } : {}),
        ...(action.input ? { toolInput: action.input } : {}),
        ...(action.rawInput ? { rawInput: action.rawInput } : {}),
      });

      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.parentBlockId, {
        ...parentBlock,
        subagent: { ...sub, blocks: newSubBlocks },
      });

      return {
        ...state,
        current: { ...state.current, blocks: newBlocks },
        contextConsumed: accumulateContext(state.contextConsumed, subToolName, action.input),
      };
    }

    case 'SUBAGENT_TOOL_RESULT': {
      if (!state.current) return state;
      const parentBlock = state.current.blocks.get(action.parentBlockId);
      if (!parentBlock) return state;
      const sub = getStreamingSubagent(parentBlock);
      if (!sub) return state;

      // Find the tool block with matching toolId
      const imgPatch =
        action.images && action.images.length > 0 ? { toolResultImages: action.images } : {};
      for (const [blockId, subBlock] of sub.blocks) {
        if (subBlock.toolId === action.toolId) {
          const newSubBlocks = new Map(sub.blocks);
          newSubBlocks.set(blockId, {
            ...subBlock,
            toolResult: action.result,
            toolError: action.isError,
            ...imgPatch,
          });

          const newBlocks = new Map(state.current.blocks);
          newBlocks.set(action.parentBlockId, {
            ...parentBlock,
            subagent: { ...sub, blocks: newSubBlocks },
          });

          return { ...state, current: { ...state.current, blocks: newBlocks } };
        }
      }

      return state;
    }

    case 'SUBAGENT_END': {
      if (!state.current) return state;
      const parentBlock = state.current.blocks.get(action.parentBlockId);
      if (!parentBlock) return state;
      const sub = getStreamingSubagent(parentBlock);
      if (!sub) return state;

      // Convert streaming subagent state to finished state
      const finished: FinishedSubagentState = {
        messageId: sub.messageId,
        blocks: sub.blockOrder
          .map((blockId) => sub.blocks.get(blockId))
          .filter((b): b is StreamingBlock => b != null)
          .map((b) => ({
            blockId: b.blockId,
            blockType: b.blockType,
            content: b.content,
            toolName: b.toolName,
            toolId: b.toolId,
            toolInput: b.toolInput,
            rawInput: b.rawInput,
            toolResult: b.toolResult,
            toolResultImages: b.toolResultImages,
            toolError: b.toolError,
          })),
        summary: action.summary,
        usage: action.usage,
      };

      const newBlocks = new Map(state.current.blocks);
      newBlocks.set(action.parentBlockId, { ...parentBlock, subagent: finished });

      return { ...state, current: { ...state.current, blocks: newBlocks } };
    }

    default:
      return state;
  }
}
