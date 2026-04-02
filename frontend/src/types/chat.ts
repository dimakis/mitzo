export interface RawToolInput {
  type: 'write' | 'diff' | 'command';
  path?: string;
  contents?: string;
  old_string?: string;
  new_string?: string;
  command?: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'thinking';
  text?: string;
  images?: string[];
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  toolResult?: string;
  rawInput?: RawToolInput;
  streaming?: boolean;
}

export type GroupedItem =
  | { type: 'message'; message: Message }
  | { type: 'tool-group'; tools: Message[] };

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
