import { isReadOnlyBuiltinToolCall } from './builtin-tool-behavior.js';
import { codexToolFailureResult } from './codex-tool-failure.js';
import type { CodexToolResult } from './codex-tool-result.js';
import { LocalRepositoryGitInspectionError } from './local-repository-git-inspection.js';
import { createLogger } from './logger.js';
import { retainCallbackOutcome, retainedCallbackOutcome } from './turn-callbacks.js';
import { runtimeFailureDiagnostics } from './runtime-failure-diagnostics.js';

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

type CauseEntry = { name: string; code?: string; kind?: string; reason?: string };
const codeOwnedReason = /^[a-z0-9-]{1,64}$/;

/** Class names, errno codes and code-owned refusal reasons only: messages may
 * carry paths or upstream payloads. */
function causeChain(error: unknown): CauseEntry[] {
  const chain: CauseEntry[] = [];
  for (let current = error, depth = 0; current !== undefined && depth < 4; depth++) {
    if (!(current instanceof Error)) {
      chain.push({ name: typeof current });
      break;
    }
    const code = (current as NodeJS.ErrnoException).code;
    chain.push({
      name: current.name,
      ...(typeof code === 'string' && /^[A-Za-z_]{1,64}$/.test(code) ? { code } : {}),
      ...(current instanceof LocalRepositoryGitInspectionError &&
      codeOwnedReason.test(current.reason)
        ? { kind: current.kind, reason: current.reason }
        : {}),
    });
    current = current.cause;
  }
  return chain;
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
    causes: causeChain(error),
    ...runtimeFailureDiagnostics(error),
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
