export interface RawToolInput {
  type: 'write' | 'diff' | 'command';
  path?: string;
  contents?: string;
  old_string?: string;
  new_string?: string;
  command?: string;
}

// --- v2 streaming model ---

export type BlockType = 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';

export interface StreamingBlock {
  blockId: string;
  blockType: BlockType;
  content: string;
  done: boolean;
  // tool_use specific
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  rawInput?: RawToolInput;
  toolResult?: string;
  toolError?: boolean;
}

export interface StreamingMessage {
  messageId: string;
  blocks: Map<string, StreamingBlock>; // blockId → block
  blockOrder: string[]; // insertion order
}

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
  contextNames?: string[];
}

// --- Legacy flat Message type (used for restore/session history only) ---
export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'thinking';
  text?: string;
  images?: string[];
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  toolResult?: string;
  rawInput?: RawToolInput;
}

export type GroupedItem =
  | { type: 'message'; message: FinishedBlock | { role: 'user'; text?: string; images?: string[] } }
  | { type: 'tool-group'; tools: FinishedBlock[]; key: string };

export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';

export interface PermissionRequest {
  permId: string;
  toolName: string;
  toolInput: string;
  title?: string;
  description?: string;
  displayName?: string;
  tier?: ToolTier;
}

export interface ImageAttachment {
  data: string;
  mediaType: string;
  preview: string;
}

export interface Session {
  id: string;
  summary: string;
  lastModified: number;
  branch?: string;
}
