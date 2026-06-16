/**
 * Gemini model provider via Google Vertex AI SDK.
 *
 * Uses the same GCP project and ADC credentials as the Anthropic Vertex
 * provider, but calls the Google AI Platform endpoint for Gemini models.
 */

import { createLogger } from '../logger.js';
import type { CallOptions, ModelProvider, ProviderMessage, ProviderResponse } from './types.js';
import { calculateCost } from './types.js';

const log = createLogger('provider:google');

/** Vertex AI model name mapping. */
const VERTEX_MODEL_MAP: Record<string, string> = {
  'gemini-2.5-pro': 'gemini-2.5-pro-preview-06-05',
  'gemini-2.5-flash': 'gemini-2.5-flash-preview-05-20',
};

export interface GoogleVertexProviderOptions {
  /** GCP project ID. Falls back to GOOGLE_CLOUD_PROJECT or ANTHROPIC_VERTEX_PROJECT_ID. */
  projectId?: string;
  /** GCP region for Gemini. Falls back to GOOGLE_CLOUD_REGION, then 'us-central1'. */
  region?: string;
}

/**
 * Gemini provider using the Vertex AI REST API directly.
 *
 * We use fetch() against the Vertex AI generateContent endpoint rather than
 * importing @google-cloud/vertexai to avoid adding a heavy SDK dependency.
 * The REST API is stable and well-documented.
 */
export class GoogleVertexModelProvider implements ModelProvider {
  readonly name = 'google-vertex';
  private model: string;
  private projectId: string;
  private region: string;

  constructor(model: string, options: GoogleVertexProviderOptions = {}) {
    this.model = model;
    this.projectId =
      options.projectId ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
      '';
    this.region = options.region || process.env.GOOGLE_CLOUD_REGION || 'us-central1';
  }

  async call(messages: ProviderMessage[], options?: CallOptions): Promise<ProviderResponse> {
    const apiModel = VERTEX_MODEL_MAP[this.model] ?? this.model;

    // Get access token from ADC (gcloud)
    const accessToken = await this.getAccessToken();

    // Build Gemini API request
    const systemInstruction = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const contents = this.convertMessages(messages.filter((m) => m.role !== 'system'));

    const endpoint = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${apiModel}:generateContent`;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        ...(options?.responseFormat === 'json' && {
          responseMimeType: 'application/json',
        }),
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as GeminiResponse;

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    const usage = {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };

    log.debug('Gemini call completed', {
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

  /** Convert ProviderMessages to Gemini content format. */
  private convertMessages(
    messages: ProviderMessage[],
  ): Array<{ role: string; parts: Array<{ text: string }> }> {
    return messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  }

  /** Cached token + expiry (4 min TTL to stay inside gcloud's 60 min window). */
  private cachedToken: { token: string; expiresAt: number } | null = null;

  /** Get an access token from Application Default Credentials (cached). */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    let token: string;
    try {
      const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      token = stdout.trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          'gcloud CLI not found — install Google Cloud SDK or configure Application Default Credentials',
        );
      }
      throw err;
    }

    // Cache for 4 minutes (gcloud tokens last ~60 min)
    this.cachedToken = { token, expiresAt: now + 4 * 60 * 1000 };
    return token;
  }
}

// ─── Gemini API response types ─────────────────────────────────────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
