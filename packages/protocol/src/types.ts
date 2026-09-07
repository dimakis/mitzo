// Unified protocol types — single source of truth for both server and frontends.
// Previously duplicated between server/session-registry.ts, server/tool-summary.ts,
// server/event-store.ts, and frontend/src/types/chat.ts.

// --- Modes & enums ---

export type MitzoMode = 'ask' | 'agent' | 'auto';
export type BlockType = 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';
export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';
export type AgentDefinitionSource = 'contexgin' | 'local' | 'fallback';

// --- Agent definition (shared between agent-loader and session-registry) ---

export interface AgentIdentity {
  name: string;
  description: string;
  mode?: 'narrow' | 'dynamic';
  role?: string;
}

export interface AgentProviderTiering {
  fast?: string | null;
  standard?: string | null;
  capable?: string | null;
}

export interface AgentProvider {
  default: string;
  tiering?: AgentProviderTiering;
}

export interface AgentContextConfig {
  budget?: number;
  sources?: { hubs?: Array<{ path: string; spokes?: string[] }> };
  priority?: string[];
  exclude?: string[];
  profile?: string;
}

export interface GovernanceBoundary {
  spoke: string;
  access: 'none' | 'read' | 'write';
}

export interface GovernanceApproval {
  required_for?: string[];
  auto_allow?: string[];
}

export interface AgentGovernance {
  boundaries?: GovernanceBoundary[];
  approval?: GovernanceApproval;
}

export interface AgentMemoryConfig {
  scope: 'none' | 'read' | 'read-write';
  vault?: string;
}

export interface AgentOutputConventions {
  commit_style?: string;
  response_format?: string | null;
}

export interface AgentOutput {
  conventions?: AgentOutputConventions;
  guides?: string[];
}

export interface AgentDefinition {
  identity: AgentIdentity;
  provider: AgentProvider;
  context?: AgentContextConfig;
  governance?: AgentGovernance;
  memory?: AgentMemoryConfig;
  output?: AgentOutput;
}

// --- Tool input ---

export interface RawToolInput {
  type: 'write' | 'diff' | 'command' | 'read' | 'agent';
  path?: string;
  contents?: string;
  old_string?: string;
  new_string?: string;
  command?: string;
  /** Language hint derived from file extension (e.g. 'typescript', 'python'). */
  language?: string;
  /** Agent tool: description of what the subagent is doing. */
  description?: string;
  /** Agent tool: the type of subagent (e.g. 'Explore', 'Plan'). */
  subagent_type?: string;
  /** Agent tool: the full prompt sent to the subagent. */
  prompt?: string;
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
  toolResultImages?: ToolResultImage[];
  toolError?: boolean;
  subagent?: StreamingSubagentState | FinishedSubagentState;
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
  toolResultImages?: ToolResultImage[];
  toolError?: boolean;
  subagent?: FinishedSubagentState;
}

export interface FinishedMessage {
  messageId: string;
  role: 'user' | 'assistant';
  blocks: FinishedBlock[];
  images?: string[];
  contextBlocks?: string[];
  timestamp?: number;
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

// --- Tool result image ---

/** Raw image extracted from SDK tool result content blocks (base64 data). */
export interface RawToolResultImage {
  data: string;
  mediaType: string;
}

/** Reference to a server-stored image (sent over WS / persisted in blocks). */
export interface ToolResultImage {
  id: string;
  mediaType: string;
}

// --- Session (client-facing) ---

export type SessionClosedBy = 'user' | 'auto' | 'abandoned';

export type SessionState =
  | 'CREATED'
  | 'STARTING'
  | 'ACTIVE'
  | 'DETACHED'
  | 'SUSPENDED'
  | 'CLOSING'
  | 'ENDED';

/**
 * Client-facing session state derived from the internal 7-state machine.
 * Mirrors Anthropic SDK convention: idle | running | requires_action.
 */
export type ClientSessionState = 'idle' | 'running' | 'requires_action';

/** Server-authoritative state event emitted on every lifecycle transition. */
export interface SessionStateEvent {
  type: 'session_state_changed';
  sessionId: string;
  state: ClientSessionState;
  /** Internal lifecycle state for debugging (not used for UI). */
  internalState: SessionState;
  timestamp: number;
}

export interface Session {
  id: string;
  summary: string;
  lastModified: number;
  branch?: string;
  isActive?: boolean;
  isAttached?: boolean;
  totalTokens?: number;
  numTurns?: number;
  telosTaskId?: string;
  closedBy?: SessionClosedBy;
}

// --- Session activity types (SSE event bus) ---

export type SessionActivityState = 'init' | 'working' | 'waiting' | 'done' | 'idle' | 'paused';

export type WaitReason = 'permission' | 'review' | 'blocked';

export interface SessionActivity {
  sessionId: string;
  clientId: string;
  title: string;
  repo?: string;
  state: SessionActivityState;
  flags: SessionActivityState[];
  waitReason?: WaitReason;
  progress?: { done: number; total: number };
  lastEventAt: number;
  taskId?: string;
  /** True when the session worktree has uncommitted changes. */
  uncommittedWork?: boolean;
  /** True when last message was from assistant and session is not actively streaming. */
  awaitingReply?: boolean;
  /** Minutes since the last speaker event (user or assistant). */
  idleMinutes?: number;
}

// --- Service health (SSE event bus) ---

export interface ServiceHealthStatus {
  name: string;
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface ServiceHealthPayload {
  services: ServiceHealthStatus[];
  checkedAt: number;
}

// --- Event store types ---

/** Optional logger interface — keeps the protocol package free of server dependencies. */
export interface EventStoreLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
}

export interface StoredEvent {
  seq: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface SessionSearchResult {
  sessionId: string;
  summary: string | null;
  snippet: string;
  matchedAt: number; // timestamp of the matching event
  updatedAt: number;
}

export interface AccountBinding {
  accountId: string;
  accountLabel: string;
  provider: string;
  model: string;
  profileRevision: string;
}

export interface SessionMeta {
  accountBinding?: AccountBinding | null;
  sessionId: string;
  summary: string | null;
  branch: string | null;
  cwd: string | null;
  mode: MitzoMode;
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
  telosTaskId: string | null;
  closedBy: SessionClosedBy | null;
  lastSpeaker: 'user' | 'assistant' | null;
  lastSpeakerAt: number | null;
  state: SessionState | null;
  lastStateChange: number | null;
  agentName: string | null;
  /** Serialized JSON of the boot_context payload (sources, tokens, sections). */
  bootContext: string | null;
  createdAt: number;
  updatedAt: number;
}

// --- Progress tracking (in-session agent progress) ---

export type ProgressItemStatus = 'pending' | 'in_progress' | 'done';

export interface ProgressItem {
  id: string;
  title: string;
  status: ProgressItemStatus;
}

export interface ProgressBlock {
  progressId: string;
  items: ProgressItem[];
  sourceToolId?: string;
}

// --- Subagent nesting (nested agent execution visibility) ---

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Streaming subagent state — blocks in a Map, running flag set. */
export interface StreamingSubagentState {
  messageId: string;
  blocks: Map<string, StreamingBlock>;
  blockOrder: string[];
  running: true;
  summary?: never;
  usage?: never;
}

/** Finished subagent state — blocks as array, summary + usage set. */
export interface FinishedSubagentState {
  messageId: string;
  blocks: FinishedBlock[];
  summary?: string;
  usage?: SubagentUsage;
  running?: never;
}

/** Union type for subagent state — streaming or finished. */
export type SubagentState = StreamingSubagentState | FinishedSubagentState;
