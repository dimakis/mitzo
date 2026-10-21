import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { tracer } from './tracing.js';

type AdmissionPhase =
  | 'retained_migration'
  | 'provider_environment'
  | 'agent_context'
  | 'knowledge'
  | 'task_capabilities';

/** Fixed phase names only. Native failures can contain paths, prompts or secrets,
 * so their details are deliberately not recorded on admission spans. */
export async function admissionPhase<T>(
  phase: AdmissionPhase,
  operation: () => T | Promise<T>,
): Promise<T> {
  const parent = context.active();
  const span = tracer.startSpan(`codex.admission.${phase}`, {}, parent);
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Preserve the coordinator's existing custody semantics; only measure how long
 * admission waits before the callback acquires its lifecycle reservation. */
export async function admissionLifecycle<T>(
  admit: (work: () => Promise<T>) => Promise<T>,
  operation: () => Promise<T>,
): Promise<T> {
  const waiting = tracer.startSpan('codex.admission.lifecycle_wait');
  let entered = false;
  try {
    return await admit(async () => {
      entered = true;
      waiting.setStatus({ code: SpanStatusCode.OK });
      waiting.end();
      return operation();
    });
  } catch (error) {
    if (!entered) waiting.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    if (!entered) waiting.end();
  }
}

/** Call only inside the owning lifecycle reservation, after runtime validation.
 * The fixed inventory probe only reads task entrypoint presence; knowledge
 * adoption writes its separate immutable view. Neither needs the other's result.
 * Settle both before returning or failing so no work escapes lifecycle custody.
 * This is per-command work: no observation or one-use receipt is cached here. */
export async function prepareKnowledgeAndCapabilities<Knowledge, Capabilities>(
  selectKnowledge: () => Promise<Knowledge>,
  inspectCapabilities: () => Promise<Capabilities>,
): Promise<[Knowledge, Capabilities]> {
  const [knowledge, capabilities] = await Promise.allSettled([
    admissionPhase('knowledge', selectKnowledge),
    admissionPhase('task_capabilities', inspectCapabilities),
  ]);
  // Retain the previous serial order's authoritative failure precedence.
  if (knowledge.status === 'rejected') throw knowledge.reason;
  if (capabilities.status === 'rejected') throw capabilities.reason;
  return [knowledge.value, capabilities.value];
}
