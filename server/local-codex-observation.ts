import { performance } from 'node:perf_hooks';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { createLogger } from './logger.js';
import { tracer } from './tracing.js';

type Phase =
  | 'repository_selection'
  | 'repository_reservation'
  | 'repository_credential_check'
  | 'bootstrap'
  | 'keychain_read'
  | 'host_tool_admission'
  | 'host_tool_execution'
  | 'credential_check'
  | 'workspace_check'
  | 'model_qualification';
const log = createLogger('local-codex-dispatch');
/** Bounded phase names only: no prompts, paths, credential material or provider errors. */
export async function observeLocalCodexPhase<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
  const span = tracer.startSpan(`local_codex.${phase}`),
    start = performance.now();
  let outcome = 'success';
  try {
    const result = await context.with(trace.setSpan(context.active(), span), work);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    outcome = 'failed';
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    const elapsedMs = Math.round(performance.now() - start);
    span.setAttribute('phase.elapsed_ms', elapsedMs);
    span.end();
    if (elapsedMs >= 500 || outcome === 'failed')
      log.warn('Local Codex phase completed', { phase, elapsedMs, outcome });
  }
}
