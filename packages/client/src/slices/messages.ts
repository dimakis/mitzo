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
  ClientSessionState,
  SymposiumProvenance,
} from '@mitzo/protocol';
import { messageIdentity } from '../message-identity.js';

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
  source: 'contexgin' | 'local-fallback' | 'sandbox';
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
  /** Simultaneous attributed seat turns, keyed by seat, generation, and provider message ID. */
  currentByMessage: Record<string, StreamingMessage>;
  /** A wire event could not be safely applied; transport must request a resync. */
  resyncRequired: boolean;
  running: boolean;
  permission: PermissionRequest | null;
  permissionQueue?: PermissionRequest[];
  branch: string | null;
  isWorktree: boolean;
  wtId: string | null;
  activeWorktrees: ActiveWorktree[];
  sessionContext: string | null;
  bootContext: BootContextMeta | null;
}

export const INITIAL_MESSAGES_STATE: MessagesState = {
  messages: [],
  current: null,
  currentByMessage: {},
  resyncRequired: false,
  running: false,
  permission: null,
  branch: null,
  isWorktree: false,
  wtId: null,
  activeWorktrees: [],
  sessionContext: null,
  bootContext: null,
};

// ─── Actions ─────────────────────────────────────────────────────────────────

type MessagesCoreAction =
  // v2 content events
  | { type: 'MESSAGE_START'; messageId: string; startedSeq?: number }
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
  | { type: 'MESSAGE_SNAPSHOT'; messageId: string; startedSeq?: number; blocks: FinishedBlock[] }
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
  | { type: 'SESSION_STATE_CHANGED'; state: ClientSessionState }
  | { type: 'CONNECTION_LOST' }
  | { type: 'PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'PERMISSION_REJECTED'; permId: string; error: string }
  | { type: 'PERMISSION_TIMEOUT'; permId: string }
  | { type: 'PERMISSION_SNAPSHOT'; permissions: PermissionRequest[] }
  | { type: 'CLEAR_PERMISSIONS' }
  | { type: 'RESTORE'; messages: FinishedMessage[]; interrupted?: boolean }
  | {
      type: 'USER_MESSAGE_RECEIVED';
      messageId: string;
      startedSeq?: number;
      text: string;
      images?: string[];
      contextBlocks?: string[];
    }
  | { type: 'WORKTREE_OPENED'; repoName: string; path: string }
  | { type: 'NATIVE_COMMAND_RESULT'; command: string; content: string }
  | { type: 'SET_SESSION_CONTEXT'; context: string }
  | { type: 'SET_BOOT_CONTEXT'; bootContext: BootContextMeta }
  | { type: 'CLEAR' };

export type MessagesAction = MessagesCoreAction & {
  symposiumProvenance?: SymposiumProvenance;
  /** Optional parent turn identity for seat-scoped tool and subagent events. */
  attributedMessageId?: string;
};

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
  return {
    messageId: current.messageId,
    role: 'assistant',
    blocks,
    timestamp: Date.now(),
    ...(current.startedSeq !== undefined ? { startedSeq: current.startedSeq } : {}),
    ...(current.symposiumProvenance ? { symposiumProvenance: current.symposiumProvenance } : {}),
  };
}

/** Insert a sequenced turn before later durable turns, preserving legacy array order. */
function insertByStartedSeq(
  messages: FinishedMessage[],
  message: FinishedMessage,
): FinishedMessage[] {
  const index =
    message.startedSeq === undefined
      ? -1
      : messages.findIndex(
          (existing) =>
            existing.startedSeq !== undefined && existing.startedSeq > message.startedSeq!,
        );
  const result = [...messages];
  result.splice(index < 0 ? result.length : index, 0, message);
  return result;
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

function provenanceFields(value: SymposiumProvenance): unknown[] {
  const legacy = [
    value.seatId,
    value.configRevision,
    value.membershipGeneration,
    value.accountProfileRevision,
    value.seatProfileRevision,
    value.contextGrantRevision,
    value.authorityGrantRevision,
    value.isolationDomainId,
    value.isolationDomainRevision,
  ];
  if (!('version' in value) || value.version !== 2) return [1, ...legacy];
  return [
    2,
    ...legacy,
    value.seatLabel,
    value.seatRole,
    value.capturedAt,
    value.accountBinding.accountId,
    value.accountBinding.accountLabel,
    value.accountBinding.provider,
    value.accountBinding.model,
    value.accountBinding.profileRevision,
    value.reasoningEffort,
    value.profileBinding.profileId,
    value.profileBinding.profileRevision,
    value.contextGrant.grantId,
    value.contextGrant.revision,
    value.authorityGrant.grantId,
    value.authorityGrant.revision,
  ];
}

function sameProvenance(a: SymposiumProvenance, b: SymposiumProvenance): boolean {
  return JSON.stringify(provenanceFields(a)) === JSON.stringify(provenanceFields(b));
}

function refuseAttributedEvent(state: MessagesState): MessagesState {
  return state.resyncRequired ? state : { ...state, resyncRequired: true };
}

function reduceAttributed(state: MessagesState, action: MessagesAction): MessagesState {
  const provenance = action.symposiumProvenance!;
  const active = state.currentByMessage;
  const messageId = 'messageId' in action ? action.messageId : action.attributedMessageId;
  const key = messageId ? messageIdentity(messageId, provenance) : undefined;
  if (action.type === 'MESSAGE_START') {
    const prior = active[key!];
    if (prior) {
      return prior.symposiumProvenance && sameProvenance(prior.symposiumProvenance, provenance)
        ? state
        : refuseAttributedEvent(state);
    }
    const finished = state.messages.find(
      (message) => messageIdentity(message.messageId, message.symposiumProvenance) === key,
    );
    if (finished) {
      return finished.symposiumProvenance &&
        sameProvenance(finished.symposiumProvenance, provenance)
        ? state
        : refuseAttributedEvent(state);
    }
    if (
      Object.values(active).some(
        (current) =>
          current.symposiumProvenance?.seatId === provenance.seatId &&
          current.symposiumProvenance.membershipGeneration === provenance.membershipGeneration,
      )
    ) {
      return refuseAttributedEvent(state);
    }
    return {
      ...state,
      currentByMessage: {
        ...active,
        [key!]: {
          messageId: action.messageId,
          startedSeq: action.startedSeq,
          symposiumProvenance: provenance,
          blocks: new Map(),
          blockOrder: [],
        },
      },
    };
  }

  let toolCurrent: StreamingMessage | undefined;
  if (action.type === 'TOOL_RESULT') {
    const liveMatches = Object.values(active).flatMap((candidate) =>
      candidate.symposiumProvenance &&
      sameProvenance(candidate.symposiumProvenance, provenance) &&
      (!messageId || candidate.messageId === messageId)
        ? [...candidate.blocks.values()]
            .filter((block) => block.toolId === action.toolId)
            .map(() => candidate)
        : [],
    );
    const finishedMatches = state.messages.flatMap((candidate, index) =>
      candidate.symposiumProvenance &&
      sameProvenance(candidate.symposiumProvenance, provenance) &&
      (!messageId || candidate.messageId === messageId)
        ? candidate.blocks.filter((block) => block.toolId === action.toolId).map(() => index)
        : [],
    );
    if (liveMatches.length + finishedMatches.length !== 1) return refuseAttributedEvent(state);
    if (finishedMatches.length === 1) {
      const index = finishedMatches[0];
      const existing = state.messages[index];
      const patched = patchToolResult(
        [existing],
        null,
        action.toolId,
        action.result,
        action.isError,
        action.images,
      ).messages[0];
      const messages = [...state.messages];
      messages[index] = patched;
      return { ...state, messages };
    }
    toolCurrent = liveMatches[0];
  }

  let current: StreamingMessage | undefined;
  if (messageId) {
    current = active[key!];
  } else if (action.type === 'TOOL_RESULT') {
    current = toolCurrent;
  } else if ('parentBlockId' in action) {
    const candidates = Object.values(active).filter(
      (candidate) =>
        candidate.symposiumProvenance &&
        sameProvenance(candidate.symposiumProvenance, provenance) &&
        candidate.blocks.has(action.parentBlockId),
    );
    if (candidates.length > 1) return refuseAttributedEvent(state);
    current = candidates[0];
  } else if (action.type === 'SESSION_END') {
    const candidates = Object.values(active).filter(
      (candidate) =>
        candidate.symposiumProvenance && sameProvenance(candidate.symposiumProvenance, provenance),
    );
    if (candidates.length > 1) return refuseAttributedEvent(state);
    current = candidates[0];
  }

  if (action.type === 'MESSAGE_SNAPSHOT') {
    const finished = state.messages.find(
      (message) => messageIdentity(message.messageId, message.symposiumProvenance) === key,
    );
    if (finished) {
      return finished.symposiumProvenance &&
        sameProvenance(finished.symposiumProvenance, provenance)
        ? state
        : refuseAttributedEvent(state);
    }
    if (
      !current &&
      Object.values(active).some(
        (candidate) =>
          candidate.symposiumProvenance?.seatId === provenance.seatId &&
          candidate.symposiumProvenance.membershipGeneration === provenance.membershipGeneration,
      )
    )
      return refuseAttributedEvent(state);
    if (current?.symposiumProvenance && !sameProvenance(current.symposiumProvenance, provenance))
      return refuseAttributedEvent(state);
  } else if (!current) {
    // Replayed terminal events for an already restored message are harmless.
    if (
      action.type === 'MESSAGE_END' &&
      state.messages.some(
        (message) =>
          messageIdentity(message.messageId, message.symposiumProvenance) === key &&
          message.symposiumProvenance &&
          sameProvenance(message.symposiumProvenance, provenance),
      )
    )
      return state;
    if (
      action.type === 'SESSION_END' &&
      !Object.values(active).some(
        (candidate) =>
          candidate.symposiumProvenance?.seatId === provenance.seatId &&
          candidate.symposiumProvenance.membershipGeneration === provenance.membershipGeneration,
      ) &&
      state.messages.some(
        (message) =>
          message.symposiumProvenance && sameProvenance(message.symposiumProvenance, provenance),
      )
    )
      return state;
    return refuseAttributedEvent(state);
  } else if (
    !current.symposiumProvenance ||
    !sameProvenance(current.symposiumProvenance, provenance)
  ) {
    return refuseAttributedEvent(state);
  }

  // The existing one-turn reducer owns block/subagent semantics. Run it on the
  // selected seat turn, then restore the ordinary chat adapter unchanged.
  const scoped = reduceLegacyMessages({ ...state, current: current ?? null }, action);
  const currentByMessage = { ...active };
  if (scoped.current) {
    currentByMessage[messageIdentity(scoped.current.messageId, provenance)] = {
      ...scoped.current,
      symposiumProvenance: provenance,
    };
  } else if (current) {
    delete currentByMessage[messageIdentity(current.messageId, provenance)];
  }
  return {
    ...scoped,
    current: state.current,
    currentByMessage,
    // A seat terminal does not make another seat or the conversation idle.
    running: action.type === 'SESSION_END' ? state.running : scoped.running,
  };
}

export function messagesReducer(state: MessagesState, action: MessagesAction): MessagesState {
  if (
    action.symposiumProvenance &&
    (action.type === 'MESSAGE_START' ||
      action.type === 'BLOCK_START' ||
      action.type === 'BLOCK_DELTA' ||
      action.type === 'BLOCK_END' ||
      action.type === 'TOOL_RESULT' ||
      action.type === 'MESSAGE_END' ||
      action.type === 'MESSAGE_SNAPSHOT' ||
      action.type === 'SESSION_END' ||
      action.type.startsWith('SUBAGENT_'))
  )
    return reduceAttributed(state, action);
  const next = reduceLegacyMessages(state, action);
  if (action.type === 'SESSION_END' && Object.keys(state.currentByMessage).length > 0) {
    let messages = next.messages;
    for (const current of Object.values(state.currentByMessage)) {
      if (
        !messages.some(
          (message) =>
            messageIdentity(message.messageId, message.symposiumProvenance) ===
            messageIdentity(current.messageId, current.symposiumProvenance),
        )
      )
        messages = insertByStartedSeq(messages, finishCurrent(current));
    }
    return { ...next, messages, currentByMessage: {} };
  }
  if (action.type === 'RESTORE') {
    const finishedIds = new Set(
      next.messages.map((message) =>
        messageIdentity(message.messageId, message.symposiumProvenance),
      ),
    );
    const currentByMessage = state.resyncRequired
      ? {}
      : Object.fromEntries(
          Object.entries(state.currentByMessage).filter(([id]) => !finishedIds.has(id)),
        );
    return { ...next, currentByMessage, resyncRequired: false };
  }
  return next;
}

function reduceLegacyMessages(state: MessagesState, action: MessagesAction): MessagesState {
  switch (action.type) {
    case 'MESSAGE_START': {
      // Dedup: skip if this message was already restored (e.g. WS replay after RESTORE)
      if (
        state.messages.some(
          (m) =>
            messageIdentity(m.messageId, m.symposiumProvenance) ===
            messageIdentity(action.messageId, action.symposiumProvenance),
        )
      ) {
        return state;
      }
      const base = state.current
        ? { ...state, messages: insertByStartedSeq(state.messages, finishCurrent(state.current)) }
        : state;
      return {
        ...base,
        current: {
          messageId: action.messageId,
          ...(action.startedSeq !== undefined ? { startedSeq: action.startedSeq } : {}),
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
        action.images,
      );
      return { ...state, messages, current };
    }

    case 'MESSAGE_END': {
      if (!state.current) return state;
      // Dedup: if this message was already restored, discard the streaming copy
      if (
        state.messages.some(
          (m) =>
            messageIdentity(m.messageId, m.symposiumProvenance) ===
            messageIdentity(state.current!.messageId, state.current!.symposiumProvenance),
        )
      ) {
        return { ...state, current: null };
      }
      const finished = finishCurrent(state.current);
      return { ...state, messages: insertByStartedSeq(state.messages, finished), current: null };
    }

    case 'SESSION_END': {
      if (state.current) {
        const finished = finishCurrent(state.current);
        return {
          ...state,
          running: false,
          messages: insertByStartedSeq(state.messages, finished),
          current: null,
        };
      }
      return { ...state, running: false };
    }

    case 'MESSAGE_SNAPSHOT': {
      const snapshotBlocks = action.blocks ?? [];
      if (!Array.isArray(action.blocks)) return state;
      const blocks = new Map<string, StreamingBlock>();
      const blockOrder: string[] = [];
      for (const b of snapshotBlocks) {
        const nested = b.subagent as unknown as
          | {
              messageId: string;
              running?: boolean;
              blocks: Array<FinishedBlock & { done?: boolean }>;
            }
          | undefined;
        const subagent: StreamingSubagentState | FinishedSubagentState | undefined =
          nested?.running && Array.isArray(nested.blocks)
            ? {
                messageId: nested.messageId,
                blocks: new Map(
                  nested.blocks.map((block) => [
                    block.blockId,
                    {
                      ...block,
                      done: block.done ?? false,
                    },
                  ]),
                ),
                blockOrder: nested.blocks.map((block) => block.blockId),
                running: true as const,
              }
            : b.subagent;
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
          ...(subagent ? { subagent } : {}),
        });
        blockOrder.push(b.blockId);
      }
      return {
        ...state,
        current: {
          messageId: action.messageId,
          ...(action.startedSeq !== undefined ? { startedSeq: action.startedSeq } : {}),
          blocks,
          blockOrder,
        },
      };
    }

    case 'PERMISSION_REQUEST': {
      if (state.permission?.permId === action.payload.permId)
        return { ...state, permission: action.payload };
      const queue = state.permissionQueue ?? [];
      if (queue.some((p) => p.permId === action.payload.permId)) return state;
      return state.permission
        ? { ...state, permissionQueue: [...queue, action.payload] }
        : { ...state, permission: action.payload };
    }

    case 'PERMISSION_SNAPSHOT': {
      const valid = action.permissions.filter(
        (request) => request && typeof request.permId === 'string',
      );
      return { ...state, permission: valid[0] ?? null, permissionQueue: valid.slice(1) };
    }

    case 'PERMISSION_REJECTED': {
      const update = (permission: PermissionRequest) =>
        permission.permId === action.permId
          ? { ...permission, responseError: action.error }
          : permission;
      return {
        ...state,
        permission: state.permission ? update(state.permission) : null,
        permissionQueue: state.permissionQueue?.map(update),
      };
    }

    case 'PERMISSION_TIMEOUT': {
      const queue = (state.permissionQueue ?? []).filter((p) => p.permId !== action.permId);
      if (state.permission?.permId !== action.permId) return { ...state, permissionQueue: queue };
      return { ...state, permission: queue[0] ?? null, permissionQueue: queue.slice(1) };
    }

    case 'CLEAR_PERMISSIONS':
      return { ...state, permission: null, permissionQueue: [] };

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
        const existingById = new Map(
          state.messages.map((m) => [messageIdentity(m.messageId, m.symposiumProvenance), m]),
        );
        const hasNewMessages = valid.some(
          (m) => !existingById.has(messageIdentity(m.messageId, m.symposiumProvenance)),
        );
        const hasNewSequence = valid.some(
          (m) =>
            m.startedSeq !== undefined &&
            existingById.get(messageIdentity(m.messageId, m.symposiumProvenance))?.startedSeq !==
              m.startedSeq,
        );
        if (!hasNewMessages && !hasNewSequence && state.messages.length > 0) {
          return state;
        }
      }
      if (action.interrupted) {
        const restoredIds = new Set(
          valid.map((m) => messageIdentity(m.messageId, m.symposiumProvenance)),
        );
        const optimisticUserMsgs = state.messages.filter(
          (m) =>
            m.role === 'user' &&
            m.messageId.startsWith('user-') &&
            !restoredIds.has(messageIdentity(m.messageId, m.symposiumProvenance)),
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
          state.current &&
          merged.some(
            (m) =>
              messageIdentity(m.messageId, m.symposiumProvenance) ===
              messageIdentity(state.current!.messageId, state.current!.symposiumProvenance),
          );
        return { ...state, messages: merged, current: currentStale ? null : state.current };
      }
      // Clear current if the restored set already contains it (prevents
      // MESSAGE_END from re-inserting a message that RESTORE already has).
      const currentStale =
        state.current &&
        valid.some(
          (m) =>
            messageIdentity(m.messageId, m.symposiumProvenance) ===
            messageIdentity(state.current!.messageId, state.current!.symposiumProvenance),
        );
      return { ...state, messages: valid, current: currentStale ? null : state.current };
    }

    case 'USER_MESSAGE_RECEIVED': {
      const existingIndex = state.messages.findIndex((m) => m.messageId === action.messageId);
      if (existingIndex !== -1) {
        const existing = state.messages[existingIndex];
        if (existing.role !== 'user') return state;
        const startedSeq = action.startedSeq ?? existing.startedSeq;
        const images = action.images ?? existing.images;
        const contextBlocks = action.contextBlocks ?? existing.contextBlocks;
        if (
          startedSeq === existing.startedSeq &&
          images === existing.images &&
          contextBlocks === existing.contextBlocks
        )
          return state;
        const messages = [...state.messages];
        messages[existingIndex] = { ...existing, startedSeq, images, contextBlocks };
        return { ...state, messages };
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            messageId: action.messageId,
            ...(action.startedSeq !== undefined ? { startedSeq: action.startedSeq } : {}),
            role: 'user',
            timestamp: Date.now(),
            images: action.images,
            contextBlocks: action.contextBlocks,
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

    case 'SESSION_STATE_CHANGED':
      return { ...state, running: action.state !== 'idle' };

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

      return { ...state, current: { ...state.current, blocks: newBlocks } };
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
