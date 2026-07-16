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

export interface AnthropicVertexProviderOptions {
  /** GCP project ID. Falls back to ANTHROPIC_VERTEX_PROJECT_ID env var. */
  projectId?: string;
  /** GCP region. Falls back to CLOUD_ML_REGION env var, then 'us-east5'. */
  region?: string;
  /** Use standard Anthropic API instead of Vertex. */
  useDirectApi?: boolean;
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

    const apiModel = this.model;

    const response = await this.client.messages.create({
      model: apiModel,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      ...(systemMessages.length > 0 && {
        system: systemMessages.map((m) => m.content).join('\n\n'),
      }),
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
