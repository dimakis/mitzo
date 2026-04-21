// Re-export shared types from @mitzo/protocol
export type {
  RawToolInput,
  BlockType,
  StreamingBlock,
  StreamingMessage,
  FinishedBlock,
  FinishedMessage,
  ToolTier,
  PermissionRequest,
  ImageAttachment,
  Session,
  SessionSearchResult,
} from '@mitzo/protocol';

import type { FinishedBlock, RawToolInput } from '@mitzo/protocol';

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
