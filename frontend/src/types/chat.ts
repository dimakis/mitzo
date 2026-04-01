export interface Message {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  images?: string[];
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  toolResult?: string;
  streaming?: boolean;
}

export type GroupedItem =
  | { type: 'message'; message: Message }
  | { type: 'tool-group'; tools: Message[] };

export interface PermissionRequest {
  permId: string;
  toolName: string;
  toolInput: string;
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
