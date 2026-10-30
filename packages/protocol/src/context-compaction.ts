/** Observed provider lifecycle, separate from cumulative usage and retained chat history. */
export interface ContextCompaction {
  id: string;
  seq: number;
  observedAt: number;
  /** Missing start/terminal observations remain unknown, including truncated history. */
  startedAt?: number | null;
  endedAt?: number | null;
  /** Nearby usage, not exact compaction input/output sizes. */
  usageBefore?: {
    tokens: number;
    observedAt: number;
    model: string | null;
    contextCeiling: number | null;
  } | null;
  usageAfter?: ContextCompaction['usageBefore'];
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
