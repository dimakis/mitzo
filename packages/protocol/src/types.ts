// Unified protocol types — single source of truth for both server and frontends.
// Previously duplicated between server/session-registry.ts, server/tool-summary.ts,
// server/event-store.ts, and frontend/src/types/chat.ts.

// --- Modes & enums ---

export type MitzoMode = 'ask' | 'agent' | 'auto';
export type BlockType = 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';
export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';

// --- Tool input ---

export interface RawToolInput {
  type: 'write' | 'diff' | 'command';
  path?: string;
  contents?: string;
  old_string?: string;
  new_string?: string;
  command?: string;
}

// --- Snapshot (server-side current message state) ---

export interface SnapshotBlock {
  blockId: string;
  blockType: BlockType;
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

// --- Streaming message (frontend in-flight state) ---

export interface StreamingBlock {
  blockId: string;
  blockType: BlockType;
  content: string;
  done: boolean;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  rawInput?: RawToolInput;
  toolResult?: string;
  toolError?: boolean;
}

export interface StreamingMessage {
  messageId: string;
  blocks: Map<string, StreamingBlock>;
  blockOrder: string[];
}

// --- Finished message (persisted state) ---

export interface FinishedBlock {
  blockId: string;
  blockType: BlockType;
  content: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  rawInput?: RawToolInput;
  toolResult?: string;
  toolError?: boolean;
}

export interface FinishedMessage {
  messageId: string;
  role: 'user' | 'assistant';
  blocks: FinishedBlock[];
  images?: string[];
  contextBlocks?: string[];
}

// --- Permission ---

export interface PermissionRequest {
  permId: string;
  toolName: string;
  toolInput: string;
  title?: string;
  description?: string;
  displayName?: string;
  tier?: ToolTier;
}

// --- Image attachment ---

export interface ImageAttachment {
  data: string;
  mediaType: string;
  preview: string;
}

// --- Session (client-facing) ---

export interface Session {
  id: string;
  summary: string;
  lastModified: number;
  branch?: string;
  isActive?: boolean;
  isAttached?: boolean;
  totalTokens?: number;
  numTurns?: number;
}

// --- Event store types ---

export interface StoredEvent {
  seq: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface SessionMeta {
  sessionId: string;
  summary: string | null;
  branch: string | null;
  cwd: string | null;
  mode: string;
  isActive: boolean;
  isHidden: boolean;
  promptCount: number;
  manuallyRenamed: boolean;
  initialPrompt: string | null;
  wtId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  goalId: string | null;
  createdAt: number;
  updatedAt: number;
}
