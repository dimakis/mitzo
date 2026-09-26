import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Breakdown = z
  .object({
    inputTokens: count,
    cachedInputTokens: count,
    cacheWriteInputTokens: count.optional().default(0),
    outputTokens: count,
    reasoningOutputTokens: count,
    totalTokens: count,
  })
  .refine(
    (value) =>
      value.cachedInputTokens <= value.inputTokens &&
      value.cacheWriteInputTokens <= value.inputTokens &&
      value.reasoningOutputTokens <= value.outputTokens &&
      Number.isSafeInteger(value.inputTokens + value.outputTokens) &&
      value.totalTokens === value.inputTokens + value.outputTokens,
  );
type Totals = z.infer<typeof Breakdown>;
const zero: Totals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};
const keys = Object.keys(zero) as (keyof Totals)[];
const Snapshot = z.object({
  turnId: z.string().min(1),
  tokenUsage: z.object({ total: Breakdown }),
});

/** Upstream TokenUsageInfo appends completed response usage into total; last is
 * only one response. A resumed/forked thread has no trustworthy zero baseline.
 * This is accounting evidence only, never a native budget enforcement proof.
 */
export class CodexTurnUsage {
  private baseline: Totals | undefined;
  private latest: Totals | undefined;
  private turnId: string | undefined;
  private invalid = false;
  constructor(freshThread = false) {
    this.baseline = freshThread ? zero : undefined;
  }

  start(turnId: string): void {
    if (this.turnId === turnId) return;
    if (this.turnId) this.baseline = undefined;
    this.turnId = turnId;
    this.latest = undefined;
    this.invalid = false;
  }

  invalidate(): void {
    this.baseline = undefined;
    this.latest = undefined;
    this.invalid = true;
  }

  update(params: unknown): void {
    const parsed = Snapshot.safeParse(params);
    if (!parsed.success || !this.turnId || parsed.data.turnId !== this.turnId) {
      this.invalidate();
      return;
    }
    if (this.invalid) return;
    const total = parsed.data.tokenUsage.total;
    const previous = this.latest ?? this.baseline;
    if (previous && keys.some((key) => total[key] < previous[key])) {
      this.invalidate();
      return;
    }
    this.latest = total;
  }

  /** Observed deltas only: completion ordering does not prove these are final.
   * Callers must not persist them as complete turn accounting without separate
   * terminal-total evidence. The native event mapper deliberately omits them.
   */
  finish(
    turnId: string,
  ): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | undefined {
    if (turnId !== this.turnId) return;
    const baseline = this.baseline;
    const latest = this.invalid ? undefined : this.latest;
    this.turnId = undefined;
    this.baseline = latest;
    this.latest = undefined;
    if (!baseline || !latest) return;
    const delta = Object.fromEntries(keys.map((key) => [key, latest[key] - baseline[key]]));
    const parsed = Breakdown.safeParse(delta);
    if (!parsed.success) {
      this.baseline = undefined;
      return;
    }
    return {
      input_tokens: parsed.data.inputTokens - parsed.data.cachedInputTokens,
      output_tokens: parsed.data.outputTokens,
      cache_read_input_tokens: parsed.data.cachedInputTokens,
    };
  }
}
