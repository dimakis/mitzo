type Snapshot = Record<string, unknown>;

function record(value: unknown): Snapshot | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Snapshot)
    : undefined;
}

/** Only documented accounting counters are additive; capacities and other
 * metadata describe the current query. Missing observations never imply zero. */
class Counters {
  private readonly totals = new Map<string, number>();

  constructor(private readonly fields: readonly string[]) {}

  get observed(): boolean {
    return this.totals.size > 0;
  }

  include(current: Snapshot = {}): Snapshot {
    const result = { ...current };
    for (const field of this.fields) {
      const value = current[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        const total = (this.totals.get(field) ?? 0) + value;
        if (Number.isFinite(total)) this.totals.set(field, total);
      }
      if (this.totals.has(field)) result[field] = this.totals.get(field);
      else delete result[field];
    }
    return result;
  }
}

/** Converts each fresh SDK process's terminal accounting into the cumulative
 * result contract consumed by the continuous chat query loop. */
export class SdkQueryUsage {
  private readonly result = new Counters([
    'total_cost_usd',
    'num_turns',
    'duration_ms',
    'duration_api_ms',
  ]);
  private readonly usage = new Counters([
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ]);
  private readonly nestedUsage = new Map([
    ['cache_creation', new Counters(['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'])],
    ['server_tool_use', new Counters(['web_search_requests', 'web_fetch_requests'])],
    ['output_tokens_details', new Counters(['thinking_tokens'])],
  ]);
  private readonly models = new Map<string, { counters: Counters; snapshot: Snapshot }>();

  include(event: Snapshot): Snapshot {
    const result = this.result.include(event);
    const currentUsage = record(event.usage);
    const usage = this.usage.include(currentUsage);
    for (const [field, counters] of this.nestedUsage) {
      const current = record(currentUsage?.[field]);
      const total = counters.include(current);
      if (current || counters.observed) usage[field] = total;
    }
    if (
      currentUsage ||
      this.usage.observed ||
      [...this.nestedUsage.values()].some((v) => v.observed)
    )
      result.usage = usage;

    for (const [model, current] of Object.entries(record(event.modelUsage) ?? {})) {
      const observation = record(current);
      if (!observation) continue;
      let state = this.models.get(model);
      if (!state) {
        state = {
          counters: new Counters([
            'inputTokens',
            'outputTokens',
            'cacheReadInputTokens',
            'cacheCreationInputTokens',
            'webSearchRequests',
            'costUSD',
          ]),
          snapshot: {},
        };
        this.models.set(model, state);
      }
      state.snapshot = { ...state.snapshot, ...state.counters.include(observation) };
    }
    if (this.models.size)
      result.modelUsage = Object.fromEntries(
        [...this.models].map(([model, state]) => [model, { ...state.snapshot }]),
      );
    return result;
  }
}
