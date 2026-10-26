import type { ConversationMessage } from './session-types.js';

/** Historical Responses checkpoint shape retained for private stored histories and
 * deferred Gemini compatibility. This is data, never a Codex thread or launcher. */
export interface ResponsesCheckpoint {
  accountId: string;
  model: string;
  history: ConversationMessage[];
  /** Opaque provider data stays server-private and is never copied into native context. */
  input: Record<string, unknown>[];
}
