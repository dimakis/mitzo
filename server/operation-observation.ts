import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { tracer } from './tracing.js';

type Attributes = Record<string, string | number | boolean>;

/** Fixed operation names and caller-selected counts only; never record exceptions or content. */
export function beginOperationObservation(name: string, attributes: Attributes = {}) {
  let span: Span | undefined;
  try {
    span = tracer.startSpan(name);
  } catch {
    /* Telemetry is optional. */
  }
  let ended = false;
  const annotate = (values: Attributes) => {
    try {
      span?.setAttributes(values);
    } catch {
      /* Preserve the operation. */
    }
  };
  annotate(attributes);
  return {
    annotate,
    run<T>(work: () => T): T {
      return span ? context.with(trace.setSpan(context.active(), span), work) : work();
    },
    end(failed = false) {
      if (ended) return;
      ended = true;
      try {
        span?.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span?.end();
      } catch {
        /* Diagnostics cannot replace a result or the original failure. */
      }
    },
  };
}

export function observeOperationSync<T>(
  name: string,
  work: (observation: ReturnType<typeof beginOperationObservation>) => T,
): T {
  const observation = beginOperationObservation(name);
  try {
    const result = observation.run(() => work(observation));
    observation.end();
    return result;
  } catch (error) {
    observation.end(true);
    throw error;
  }
}

export async function observeOperationAsync<T>(
  name: string,
  work: () => Promise<T>,
  attributes: Attributes = {},
): Promise<T> {
  const observation = beginOperationObservation(name, attributes);
  try {
    const result = await observation.run(work);
    observation.end();
    return result;
  } catch (error) {
    observation.end(true);
    throw error;
  }
}
