/**
 * Multi-provider model abstraction layer.
 *
 * Thin adapters that normalize different LLM provider SDKs into a common
 * interface. Used by both deliberation and fusion orchestrators.
 *
 * Each adapter is ~50-80 lines. We avoid a full router sidecar (LiteLLM/OGX)
 * because we only have 2-3 providers on the same Vertex billing.
 */

/** A message in the provider-agnostic format. */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Token usage from a single model call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Response from a single model call. */
export interface ProviderResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
}

/** Options for a model call. */
export interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  /** Request JSON output (model-dependent). */
  responseFormat?: 'text' | 'json';
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/** A model provider adapter. */
export interface ModelProvider {
  /** Provider name (e.g. 'anthropic-vertex', 'google-vertex', 'openai'). */
  readonly name: string;

  /** Make a completion call. */
  call(messages: ProviderMessage[], options?: CallOptions): Promise<ProviderResponse>;
}

/** Cost rates per million tokens (input/output). */
export interface CostRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Known model cost rates (USD per million tokens). */
export const MODEL_COSTS: Record<string, CostRate> = {
  // Claude via Vertex AI
  'claude-opus-4-6': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4.0 },

  // Gemini via Vertex AI
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10.0 },
  'gemini-2.5-flash': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
};

/** Calculate cost in USD from token usage and model name. */
export function calculateCost(model: string, usage: TokenUsage): number {
  const rate = MODEL_COSTS[model];
  if (!rate) return 0; // unknown model — don't block, just don't track
  return (
    (usage.inputTokens / 1_000_000) * rate.inputPerMillion +
    (usage.outputTokens / 1_000_000) * rate.outputPerMillion
  );
}
