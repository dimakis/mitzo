/** Observed provider lifecycle, separate from cumulative usage and retained chat history. */
export interface ContextCompaction {
  id: string;
  seq: number;
  observedAt: number;
  phase: 'compacting' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  afterMessageId: string | null;
  turnIndex: number | null;
  beforeTokens: number | null;
  afterTokens: number | null;
  /** Only populated when an adapter supplies an exact app-message range. */
  condensedRange: { firstMessageId: string; lastMessageId: string } | null;
  summary: string | null;
  retainedProviderMessageIds: string[];
}
