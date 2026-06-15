/**
 * Claude model provider via Anthropic Vertex AI SDK.
 *
 * Uses the same credentials and SDK as the existing Mitzo auto-rename module,
 * but exposed through the ModelProvider interface for multi-model reasoning.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { createLogger } from '../logger.js';
import type { CallOptions, ModelProvider, ProviderMessage, ProviderResponse } from './types.js';
import { calculateCost } from './types.js';

const log = createLogger('provider:anthropic');

/** Vertex AI model name mapping (Vertex uses different naming). */
const VERTEX_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-6': 'claude-opus-4-6@20250514',
  'claude-sonnet-4-6': 'claude-sonnet-4-6@20250514',
  'claude-haiku-4-5': 'claude-3-5-haiku@20241022',
};

export interface AnthropicVertexProviderOptions {
  /** GCP project ID. Falls back to ANTHROPIC_VERTEX_PROJECT_ID env var. */
  projectId?: string;
  /** GCP region. Falls back to CLOUD_ML_REGION env var, then 'us-east5'. */
  region?: string;
  /** Use standard Anthropic API instead of Vertex. */
  useDirectApi?: boolean;
}

export class AnthropicVertexProvider implements ModelProvider {
  readonly name = 'anthropic-vertex';
  private client: Anthropic | AnthropicVertex;
  private isVertex: boolean;

  constructor(options: AnthropicVertexProviderOptions = {}) {
    const useVertex = !options.useDirectApi && process.env.CLAUDE_CODE_USE_VERTEX === '1';

    if (useVertex) {
      const projectId = options.projectId || process.env.ANTHROPIC_VERTEX_PROJECT_ID || '';
      const region = options.region || process.env.CLOUD_ML_REGION || 'us-east5';
      this.client = new AnthropicVertex({ projectId, region });
      this.isVertex = true;
    } else {
      this.client = new Anthropic();
      this.isVertex = false;
    }
  }

  async call(messages: ProviderMessage[], options?: CallOptions): Promise<ProviderResponse> {
    // Separate system message from conversation messages
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    // Claude API requires model name — resolve Vertex name if needed
    const requestModel = messages.length > 0 ? this.resolveModel(options) : 'claude-opus-4-6';

    const response = await this.client.messages.create({
      model: requestModel,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      ...(systemMessages.length > 0 && { system: systemMessages.map((m) => m.content).join('\n\n') }),
      messages: conversationMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const content = textBlock?.text ?? '';

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    // Use the canonical model name for cost calculation
    const canonicalModel = this.reverseModelName(response.model);

    log.debug('Anthropic call completed', {
      model: canonicalModel,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    return {
      content,
      model: canonicalModel,
      usage,
      costUsd: calculateCost(canonicalModel, usage),
    };
  }

  /** Resolve the canonical model name to what the API expects. */
  private resolveModel(_options?: CallOptions): string {
    // Default model — callers pass the model via the orchestrator config,
    // not via CallOptions. This adapter is instantiated per-role.
    // The orchestrator creates one provider per model, so we use a fixed model.
    // This will be overridden by ProviderRegistry.getProvider(model).
    return 'claude-opus-4-6';
  }

  /** Convert a Vertex model name back to canonical form. */
  private reverseModelName(apiModel: string): string {
    for (const [canonical, vertex] of Object.entries(VERTEX_MODEL_MAP)) {
      if (apiModel === vertex || apiModel.startsWith(vertex.split('@')[0])) {
        return canonical;
      }
    }
    return apiModel;
  }

  /** Create a provider bound to a specific model. */
  static forModel(model: string, options?: AnthropicVertexProviderOptions): AnthropicVertexModelProvider {
    return new AnthropicVertexModelProvider(model, options);
  }
}

/**
 * A model-specific Anthropic provider — bound to a single model at construction time.
 * This is what the orchestrators actually use: one provider per role.
 */
export class AnthropicVertexModelProvider implements ModelProvider {
  readonly name = 'anthropic-vertex';
  private client: Anthropic | AnthropicVertex;
  private isVertex: boolean;
  private model: string;

  constructor(model: string, options: AnthropicVertexProviderOptions = {}) {
    this.model = model;
    const useVertex = !options.useDirectApi && process.env.CLAUDE_CODE_USE_VERTEX === '1';

    if (useVertex) {
      const projectId = options.projectId || process.env.ANTHROPIC_VERTEX_PROJECT_ID || '';
      const region = options.region || process.env.CLOUD_ML_REGION || 'us-east5';
      this.client = new AnthropicVertex({ projectId, region });
      this.isVertex = true;
    } else {
      this.client = new Anthropic();
      this.isVertex = false;
    }
  }

  async call(messages: ProviderMessage[], options?: CallOptions): Promise<ProviderResponse> {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const apiModel = this.isVertex
      ? (VERTEX_MODEL_MAP[this.model] ?? this.model)
      : this.model;

    const response = await this.client.messages.create({
      model: apiModel,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      ...(systemMessages.length > 0 && { system: systemMessages.map((m) => m.content).join('\n\n') }),
      messages: conversationMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const content = textBlock?.text ?? '';

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    log.debug('Anthropic call completed', {
      model: this.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    return {
      content,
      model: this.model,
      usage,
      costUsd: calculateCost(this.model, usage),
    };
  }
}
