import type { BlockType, FinishedBlock, ToolTier, RawToolInput } from './chat';

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

interface SkillInvokedMsg {
  type: 'skill_invoked';
  v: 2;
  name: string;
  source: 'repo' | 'user' | 'bundled';
  arguments: string;
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
  | ModeChangedMsg
  | UpdateAvailableMsg
  | WorktreeOpenedMsg
  | NativeCommandResultMsg
  | SkillInvokedMsg;
