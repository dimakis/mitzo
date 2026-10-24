/** Shared model/session contracts and explicit retired-factory failures.
 * Product execution injects selected native harness adapters; model prefixes
 * never select accounts, credentials or direct inference implementations.
 */

import type { ModelProvider } from './types.js';

/** Compatibility failure only. Model prefixes no longer select credentials,
 * billing accounts or an inference SDK. Product consumers inject a reviewed
 * per-role native harness provider into the existing orchestrators. */
export function createProvider(_model: string): ModelProvider {
  throw Error(
    'Direct provider execution is retired; select the native harness account, model and target for this role',
  );
}
export function createProviders(models: string[]): Map<string, ModelProvider> {
  return new Map(models.map((model) => [model, createProvider(model)]));
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

// SDK adapter — bridges ModelSession to query-loop.ts event shapes
export { sdkWrapperEmitter, runDeferredGeminiLoop } from './sdk-adapter.js';
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

export type { ResponsesCheckpoint } from './legacy-provider-checkpoint.js';
