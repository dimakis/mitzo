import { performance } from 'node:perf_hooks';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { createLogger } from './logger.js';
import { tracer } from './tracing.js';

type Phase =
  | 'repository_selection'
  | 'repository_reservation'
  | 'repository_fetch'
  | 'repository_credential_check'
  | 'bootstrap'
  | 'keychain_read'
  | 'native_measurement'
  | 'native_capture'
  | 'native_launch_integrity'
  | 'native_version_check'
  | 'host_tool_admission'
  | 'host_tool_execution'
  | 'credential_check'
  | 'workspace_check'
  | 'model_qualification';
const log = createLogger('local-codex-dispatch');
function beginPhase(phase: Phase) {
  const span = tracer.startSpan(`local_codex.${phase}`),
    start = performance.now();
  return {
    run: <T>(work: () => T): T => context.with(trace.setSpan(context.active(), span), work),
    end(outcome: 'success' | 'failed') {
      const elapsedMs = Math.round(performance.now() - start);
      span.setStatus({ code: outcome === 'success' ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      span.setAttribute('phase.elapsed_ms', elapsedMs);
      span.setAttribute('phase.outcome', outcome);
      span.end();
      if (elapsedMs >= 500 || outcome === 'failed')
        log.warn('Local Codex phase completed', { phase, elapsedMs, outcome });
    },
  };
}
/** Bounded phase names only: no prompts, paths, credential material or provider errors. */
export async function observeLocalCodexPhase<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
  const observation = beginPhase(phase);
  let outcome: 'success' | 'failed' = 'success';
  try {
    const result = await observation.run(work);
    // A native dynamic-tool failure is a fulfilled RPC with success:false.
    // Observe that outcome without throwing, inspecting content or changing
    // the original result. Other phase results have no such tool contract.
    if (phase === 'host_tool_execution' && result && typeof result === 'object') {
      try {
        const success = Object.getOwnPropertyDescriptor(result, 'success');
        if (success && 'value' in success && success.value === false) outcome = 'failed';
      } catch {
        /* Diagnostic inspection must not reject or replay an otherwise fulfilled RPC. */
      }
    }
    return result;
  } catch (error) {
    outcome = 'failed';
    throw error;
  } finally {
    observation.end(outcome);
  }
}
/** Preserves synchronous qualification and throws without introducing an await. */
export function observeLocalCodexSyncPhase<T>(phase: Phase, work: () => T): T {
  const observation = beginPhase(phase);
  let outcome: 'success' | 'failed' = 'success';
  try {
    return observation.run(work);
  } catch (error) {
    outcome = 'failed';
    throw error;
  } finally {
    observation.end(outcome);
  }
}
