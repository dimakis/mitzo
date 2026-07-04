import type { BlockType, FinishedBlock, ToolTier, RawToolInput } from './chat';
import type { Task } from './task';
import type { ProgressItem, ProgressItemStatus } from '@mitzo/protocol';

interface ClientIdMsg {
  type: 'client_id';
  clientId: string;
}

interface ReattachedMsg {
  type: 'reattached';
  clientId: string;
  sessionId?: string;
  running: boolean;
}

interface ReattachFailedMsg {
  type: 'reattach_failed';
  clientId: string;
  reason?: string;
}

interface SessionInfoMsg {
  type: 'session_info';
  branch: string;
  cwd: string;
  worktree: boolean;
  /** Session-scoped worktree ID, shared across all repos. */
  wtId?: string;
}

interface SessionIdMsg {
  type: 'session_id';
  sessionId: string;
}

interface MessageStartMsg {
  type: 'message_start';
  v: 2;
  messageId: string;
}

interface BlockStartMsg {
  type: 'block_start';
  v: 2;
  messageId: string;
  blockId: string;
  blockType: BlockType;
  toolName?: string;
}

interface BlockDeltaMsg {
  type: 'block_delta';
  v: 2;
  messageId: string;
  blockId: string;
  blockType: BlockType;
  delta: string;
}

interface BlockEndMsg {
  type: 'block_end';
  v: 2;
  messageId: string;
  blockId: string;
  blockType: BlockType;
  toolName?: string;
  toolId?: string;
  input?: string;
  rawInput?: RawToolInput;
}

interface ToolResultMsg {
  type: 'tool_result';
  v: 2;
  messageId: string;
  toolId: string;
  result: string;
  isError: boolean;
}

interface MessageEndMsg {
  type: 'message_end';
  v: 2;
  messageId: string;
  sessionId?: string;
}

interface MessageSnapshotMsg {
  type: 'message_snapshot';
  v: 2;
  messageId: string;
  blocks: FinishedBlock[];
}

interface SessionEndMsg {
  type: 'session_end';
  v: 2;
  sessionId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalCostUsd: number;
    numTurns: number;
    durationMs: number;
    durationApiMs: number;
  };
}

interface PermissionRequestMsg {
  type: 'permission_request';
  permId: string;
  toolName: string;
  toolInput: string;
  title?: string;
  description?: string;
  displayName?: string;
  tier?: ToolTier;
}

interface PermissionTimeoutMsg {
  type: 'permission_timeout';
  permId: string;
}

interface ErrorMsg {
  type: 'error';
  error: string;
}

interface SessionTakeoverMsg {
  type: 'session_takeover';
  sessionId: string;
}

interface ModeChangedMsg {
  type: 'mode_changed';
  mode: 'ask' | 'agent' | 'auto';
}

interface UpdateAvailableMsg {
  type: 'update_available';
}

interface WorktreeOpenedMsg {
  type: 'worktree_opened';
  repoName: string;
  path: string;
}

interface NativeCommandResultMsg {
  type: 'native_command_result';
  v: 2;
  command: string;
  content: string;
}

/** Reasoning event streamed during /deliberate or /fuse execution. */
interface ReasoningEventMsg {
  type: 'reasoning_event';
  v: 2;
  mode: 'deliberation' | 'fusion';
  event: {
    type: 'reasoning_start' | 'phase_start' | 'phase_delta' | 'phase_end' | 'reasoning_end';
    phase?: string;
    speaker?: string;
    model?: string;
    task?: string;
    delta?: string;
    content?: string;
    costUsd?: number;
    totalCost?: number;
  };
}

interface SkillInvokedMsg {
  type: 'skill_invoked';
  v: 2;
  name: string;
  source: 'repo' | 'user' | 'bundled';
  arguments: string;
}

interface UserMessageMsg {
  type: 'user_message';
  v: 2;
  messageId: string;
  text: string;
  sessionId?: string;
}

interface SessionRenamedMsg {
  type: 'session_renamed';
  sessionId: string;
  name: string;
}

interface SubscribedMsg {
  type: 'subscribed';
  sessionId: string;
  running: boolean;
}

interface TaskStateMsg {
  type: 'task_state';
  tasks: Task[];
}

interface TaskUpdatedMsg {
  type: 'task_updated';
  task: Task;
}

interface TaskDeletedMsg {
  type: 'task_deleted';
  taskId: string;
}

export type ServerMessage =
  | ClientIdMsg
  | ReattachedMsg
  | ReattachFailedMsg
  | SessionInfoMsg
  | SessionIdMsg
  | MessageStartMsg
  | BlockStartMsg
  | BlockDeltaMsg
  | BlockEndMsg
  | ToolResultMsg
  | MessageEndMsg
  | MessageSnapshotMsg
  | SessionEndMsg
  | PermissionRequestMsg
  | PermissionTimeoutMsg
  | ErrorMsg
  | SessionTakeoverMsg
  | ModeChangedMsg
  | UpdateAvailableMsg
  | WorktreeOpenedMsg
  | NativeCommandResultMsg
  | ReasoningEventMsg
  | SkillInvokedMsg
  | UserMessageMsg
  | SessionRenamedMsg
  | SubscribedMsg
  | InboxUpdatedMsg
  | TaskStateMsg
  | TaskUpdatedMsg
  | TaskDeletedMsg
  | TokenUpdateMsg
  | LoopStatusMsg
  | ProgressStartMsg
  | ProgressUpdateMsg
  | ProgressReplaceMsg
  | SubagentStartMsg
  | SubagentBlockStartMsg
  | SubagentBlockDeltaMsg
  | SubagentBlockEndMsg
  | SubagentToolResultMsg
  | SubagentEndMsg
  | SubagentCancelledMsg;

export interface ProgressStartMsg {
  type: 'progress_start';
  v: 2;
  messageId: string;
  progressId: string;
  sourceToolId?: string;
  items: ProgressItem[];
}

export interface ProgressUpdateMsg {
  type: 'progress_update';
  v: 2;
  progressId: string;
  itemId: string;
  status: ProgressItemStatus;
}

export interface ProgressReplaceMsg {
  type: 'progress_replace';
  v: 2;
  progressId: string;
  sourceToolId?: string;
  items: ProgressItem[];
}

export interface InboxUpdatedMsg {
  type: 'inbox_updated';
}

export interface TokenUpdateMsg {
  type: 'token_update';
  agentContext: number;
  contextCeiling?: number;
  sessionTotal?: number;
  numTurns?: number;
  numCompactions?: number;
  turnIndex: number;
}

export interface LoopStatusMsg {
  type: 'loop_status';
  state: 'idle' | 'running' | 'paused';
  goalId: string | null;
  activeTaskId: string | null;
  progress: { done: number; total: number } | null;
  specMode: boolean;
  awaitingApproval: boolean;
  spawnEnabled: boolean;
}

// Subagent lifecycle events
export interface SubagentStartMsg {
  type: 'subagent_start';
  v: 2;
  ts: number;
  sessionId: string;
  parentBlockId: string;
  parentToolId: string;
  subagentMessageId: string;
  description?: string;
}

export interface SubagentBlockStartMsg {
  type: 'subagent_block_start';
  v: 2;
  ts: number;
  sessionId: string;
  parentBlockId: string;
  subagentMessageId: string;
  blockId: string;
  blockType: BlockType;
  toolName?: string;
}

export interface SubagentBlockDeltaMsg {
  type: 'subagent_block_delta';
  v: 2;
  ts: number;
  sessionId: string;
  parentBlockId: string;
  subagentMessageId: string;
  blockId: string;
  blockType: BlockType;
  delta: string;
}

export interface SubagentBlockEndMsg {
  type: 'subagent_block_end';
  v: 2;
  ts: number;
  sessionId: string;
  parentBlockId: string;
  subagentMessageId: string;
  blockId: string;
  blockType: BlockType;
  toolName?: string;
  toolId?: string;
  input?: string;
  rawInput?: RawToolInput;
}

export interface SubagentToolResultMsg {
  type: 'subagent_tool_result';
  v: 2;
  ts: number;
  sessionId: string;
  parentBlockId: string;
  subagentMessageId: string;
  toolId: string;
  result: string;
  isError: boolean;
}

export interface SubagentEndMsg {
  type: 'subagent_end';
  v: 2;
  ts: number;
  sessionId: string;
  parentBlockId: string;
  subagentMessageId: string;
  summary?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

export interface SubagentCancelledMsg {
  type: 'subagent_cancelled';
  v: 2;
  ts: number;
  sessionId: string;
  parentBlockId: string;
  subagentMessageId: string;
  taskId: string;
}
