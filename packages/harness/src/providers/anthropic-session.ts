/**
 * Anthropic Messages API session — calls Claude (or any provider via praxis-proxy).
 *
 * Sends requests in Anthropic Messages format and streams back SSE events.
 * When pointed at praxis-proxy (:9090), the proxy handles translation to
 * whatever backend provider is configured (OpenAI, local models, etc.).
 *
 * This means Mitzo always speaks Anthropic wire format — praxis-proxy
 * is the translation layer.
 */

import { createLogger } from '../logger.js';
import type {
  ConversationMessage,
  ModelSession,
  ModelSessionConfig,
  StreamEvent,
} from './session-types.js';

const log = createLogger('provider:anthropic-session');

/** Default Anthropic API base URL. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Praxis proxy URL for provider-agnostic routing. */
const PRAXIS_URL = 'http://127.0.0.1:9090';

export interface AnthropicSessionOptions {
  /** Base URL for the API. Defaults to Anthropic API or praxis-proxy. */
  baseUrl?: string;
  /** API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Use praxis-proxy instead of direct Anthropic API. */
  useProxy?: boolean;
  /** Anthropic API version header. */
  apiVersion?: string;
}

/**
 * Parse an SSE line pair into a StreamEvent.
 * SSE format: "event: <type>\ndata: <json>\n\n"
 */
function parseSSE(eventType: string, data: string): StreamEvent | null {
  if (eventType === 'ping' || eventType === 'message_stop') return null;
  if (data === '[DONE]') return null;

  try {
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
      return null;
    }

    switch (parsed.type) {
      case 'message_start':
        if (!parsed.message?.id || !parsed.message?.role) return null;
        return parsed as StreamEvent;
      case 'content_block_start':
        if (typeof parsed.index !== 'number' || !parsed.content_block?.type) return null;
        return parsed as StreamEvent;
      case 'content_block_delta':
        if (typeof parsed.index !== 'number' || !parsed.delta?.type) return null;
        return parsed as StreamEvent;
      case 'content_block_stop':
        if (typeof parsed.index !== 'number') return null;
        return parsed as StreamEvent;
      case 'message_delta':
        if (!parsed.delta || !parsed.usage) return null;
        return parsed as StreamEvent;
      default:
        return null;
    }
  } catch {
    log.warn('failed to parse SSE data', { eventType, data: data.slice(0, 200) });
    return null;
  }
}

export class AnthropicSession implements ModelSession {
  readonly provider = 'anthropic';
  private baseUrl: string;
  private apiKey: string;
  private apiVersion: string;
  private config: ModelSessionConfig;

  constructor(config: ModelSessionConfig, options: AnthropicSessionOptions = {}) {
    this.config = config;

    const useProxy = options.useProxy ?? !!process.env.MITZO_USE_PRAXIS;
    this.baseUrl = options.baseUrl ?? (useProxy ? PRAXIS_URL : DEFAULT_BASE_URL);
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.apiVersion = options.apiVersion ?? '2023-06-01';

    if (!this.apiKey && !useProxy) {
      log.warn('no API key configured and not using praxis-proxy — requests will fail with 401');
    }

    log.info('session created', {
      model: config.model,
      baseUrl: this.baseUrl,
      useProxy,
      toolCount: config.tools?.length ?? 0,
    });
  }

  async *turn(messages: ConversationMessage[]): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      stream: true,
      messages,
    };

    if (this.config.systemPrompt) {
      body.system = this.config.systemPrompt;
    }

    if (this.config.tools && this.config.tools.length > 0) {
      body.tools = this.config.tools;
    }

    if (this.config.thinking) {
      body.thinking = this.config.thinking;
    }

    const url = `${this.baseUrl}/v1/messages`;

    log.debug('turn request', {
      model: this.config.model,
      messageCount: messages.length,
      url,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify(body),
      signal: this.config.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const err = new Error(`Anthropic API error ${response.status}: ${errorBody.slice(0, 500)}`);
      log.error('API request failed', {
        status: response.status,
        body: errorBody.slice(0, 200),
      });
      throw err;
    }

    if (!response.body) {
      throw new Error('Response body is null — streaming not supported');
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            const event = parseSSE(currentEventType, data);
            if (event) {
              yield event;
            }
            currentEventType = '';
          }
          // Empty lines and other lines are ignored (SSE separators)
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const remaining = buffer.split('\n');
        for (const line of remaining) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            const event = parseSSE(currentEventType, data);
            if (event) {
              yield event;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Factory: create an AnthropicSession.
 *
 * Reads MITZO_USE_PRAXIS env var to decide whether to route through
 * praxis-proxy (provider-agnostic) or direct to Anthropic.
 */
export function createAnthropicSession(
  config: ModelSessionConfig,
  options?: AnthropicSessionOptions,
): AnthropicSession {
  return new AnthropicSession(config, options);
}
