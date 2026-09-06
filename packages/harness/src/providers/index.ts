/**
 * Provider registry — factory for model-specific providers.
 *
 * Resolves a canonical model name (e.g. 'claude-opus-4-6', 'gemini-2.5-pro')
 * to the correct provider adapter with the right SDK and credentials.
 */

import { createLogger } from '../logger.js';
import { AnthropicVertexModelProvider } from './anthropic-vertex.js';
import { GoogleVertexModelProvider } from './google-vertex.js';
import type { ModelProvider } from './types.js';

const log = createLogger('provider-registry');

/** Which provider handles which model prefix. */
const MODEL_PROVIDER_MAP: Record<string, 'anthropic' | 'google'> = {
  'claude-opus': 'anthropic',
  'claude-sonnet': 'anthropic',
  'claude-haiku': 'anthropic',
  'gemini-': 'google',
};

/** Resolve which provider family handles a given model name. */
function resolveProviderType(model: string): 'anthropic' | 'google' {
  for (const [prefix, provider] of Object.entries(MODEL_PROVIDER_MAP)) {
    if (model.startsWith(prefix)) return provider;
  }
  // Default to anthropic for unknown models
  log.warn(`Unknown model "${model}", defaulting to anthropic provider`);
  return 'anthropic';
}

/**
 * Create a ModelProvider bound to a specific model.
 *
 * Each provider instance is model-specific — the orchestrators create
 * one provider per participant role.
 */
export function createProvider(model: string): ModelProvider {
  const providerType = resolveProviderType(model);

  switch (providerType) {
    case 'anthropic':
      return new AnthropicVertexModelProvider(model);
    case 'google':
      return new GoogleVertexModelProvider(model);
  }
}

/**
 * Create providers for a set of model names. Returns a map keyed by model name.
 */
export function createProviders(models: string[]): Map<string, ModelProvider> {
  const providers = new Map<string, ModelProvider>();
  for (const model of models) {
    if (!providers.has(model)) {
      providers.set(model, createProvider(model));
    }
  }
  return providers;
}

// Re-export everything
export type {
  ModelProvider,
  ProviderMessage,
  ProviderResponse,
  CallOptions,
  CostRate,
  TokenUsage,
} from './types.js';
export { calculateCost, MODEL_COSTS } from './types.js';
export { AnthropicVertexModelProvider } from './anthropic-vertex.js';
export { GoogleVertexModelProvider } from './google-vertex.js';

// Agentic session abstractions (provider-agnostic loop)
export type {
  ModelSession,
  ModelSessionConfig,
  ModelSessionFactory,
  StreamEvent,
  ConversationMessage,
  ContentBlock,
  ToolDefinition,
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
} from './session-types.js';
export { AnthropicSession, createAnthropicSession } from './anthropic-session.js';
export type { AnthropicSessionOptions } from './anthropic-session.js';

// SDK adapter — bridges ModelSession to query-loop.ts event shapes
export { sdkWrapperEmitter, runAgenticLoop } from './sdk-adapter.js';
export type {
  SdkWrapperEvent,
  SdkAssistantEvent,
  SdkStreamEvent,
  SdkUserEvent,
  SdkResultEvent,
  SdkSystemEvent,
  SdkUsage,
  AgenticLoopOptions,
  ToolUseBlock,
  ToolResultBlock,
} from './sdk-adapter.js';

export { ResponsesSession } from './responses-session.js';
export type { ResponsesSessionOptions, ResponsesCheckpoint } from './responses-session.js';
