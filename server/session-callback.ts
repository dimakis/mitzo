/**
 * Session callback — fires a POST to callbackUrl when a session ends.
 *
 * Used by external services (e.g. Centaur) to receive structured results
 * from headless Mitzo sessions. The payload includes the final assistant
 * message (expected to contain structured JSON), usage stats, and status.
 *
 * The callback body is signed with HMAC-SHA256 using the session's
 * callbackSecret, sent as the X-Mitzo-Signature header.
 */

import { createHmac } from 'node:crypto';
import type { SessionMeta, StoredEvent } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

export interface CallbackPayload {
  sessionId: string;
  status: 'completed' | 'failed';
  error?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
    numTurns: number;
    durationMs: number;
  };
  result: unknown;
}

interface CallbackLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const noopLogger: CallbackLogger = { info() {}, error() {} };

/**
 * Extract the structured result from the session's event stream.
 *
 * Walks the events backwards to find the last assistant text block,
 * then attempts to parse JSON from it. If no JSON is found, returns
 * the raw text.
 */
export function extractResult(events: StoredEvent[]): unknown {
  // Walk backwards to find the last assistant text content
  const textParts: string[] = [];
  let inAssistantMessage = false;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'message_end') {
      inAssistantMessage = true;
      continue;
    }
    if (ev.type === 'message_start' && inAssistantMessage) {
      break; // We've collected the full last message
    }
    if (inAssistantMessage && ev.type === 'block_delta') {
      const content = (ev.payload as Record<string, unknown>).content;
      if (typeof content === 'string') {
        textParts.unshift(content);
      }
    }
  }

  const fullText = textParts.join('');
  if (!fullText) return null;

  // Try to extract JSON from the text (may be wrapped in ```json fences)
  const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/) ?? fullText.match(/(\{[\s\S]*\})/);

  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // Not valid JSON — return raw text
    }
  }

  return fullText;
}

function signPayload(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Fire the session callback if configured.
 *
 * Called from the query loop when a session transitions to ENDED.
 * This is fire-and-forget — callback failures are logged but don't
 * affect the session lifecycle.
 */
export async function fireSessionCallback(
  sessionId: string,
  store: EventStore,
  opts?: { reason?: string; logger?: CallbackLogger },
): Promise<void> {
  const log = opts?.logger ?? noopLogger;

  const meta: SessionMeta | null = store.getSession(sessionId);
  if (!meta?.callbackUrl) return;

  const events = store.getSessionEvents(sessionId);
  const result = extractResult(events);
  const failed = opts?.reason === 'error';

  const payload: CallbackPayload = {
    sessionId,
    status: failed ? 'failed' : 'completed',
    ...(failed && { error: 'Session ended with error' }),
    usage: {
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      totalCostUsd: meta.totalCostUsd,
      numTurns: meta.numTurns,
      durationMs: meta.durationMs,
    },
    result,
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (meta.callbackSecret) {
    headers['X-Mitzo-Signature'] = signPayload(body, meta.callbackSecret);
  }

  try {
    const response = await fetch(meta.callbackUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    log.info('session callback fired', {
      sessionId,
      callbackUrl: meta.callbackUrl,
      status: response.status,
      ok: response.ok,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('session callback failed', {
      sessionId,
      callbackUrl: meta.callbackUrl,
      error: message,
    });
  }
}
