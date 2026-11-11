import { isReadOnlyBuiltinToolCall } from './builtin-tool-behavior.js';
import { codexToolFailureResult } from './codex-tool-failure.js';
import type { CodexToolResult } from './codex-tool-result.js';
import { createLogger } from './logger.js';
import { retainCallbackOutcome, retainedCallbackOutcome } from './turn-callbacks.js';

const log = createLogger('tool-failure');

/** Shared by engine adapters. A failed read is still a completed observation;
 * explicit uncertainty and cancellation are never upgraded by this default. */
export function qualifyToolResult<T extends CodexToolResult>(
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  result: T,
): T {
  if (
    result.isError &&
    !signal.aborted &&
    !retainedCallbackOutcome(result) &&
    isReadOnlyBuiltinToolCall(name, input)
  )
    retainCallbackOutcome(result, 'settled');
  return result;
}

/** Exceptions become model-visible failures, with fixed diagnostics rather than
 * upstream payloads. Reporting does not authorize retries or settle unknown work. */
export function reportToolFailure(
  error: unknown,
  context: { sessionId: string; tool: string; signal: AbortSignal; callId?: string },
): CodexToolResult {
  const result = codexToolFailureResult(error, context.signal.aborted);
  const detail = JSON.parse(result.content);
  log.warn('Tool execution failed', {
    sessionId: context.sessionId,
    tool: context.tool,
    callId: context.callId,
    diagnosticId: detail.diagnosticId,
    code: detail.error,
    diagnostic: detail.diagnostic,
  });
  return retainCallbackOutcome(
    result,
    error instanceof Error && retainedCallbackOutcome(error) === 'settled'
      ? 'settled'
      : detail.diagnostic.effectStatus === 'not_started'
        ? 'settled'
        : 'unknown',
  );
}
