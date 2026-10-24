import type { Context, Span } from '@opentelemetry/api';
import { tracer } from './tracing.js';

/** Timing is observational: exporter/instrumentation faults grant no authority
 * and cannot refuse an otherwise valid command or change its durable state. */
export function startCommandTimingSpan(
  name: 'codex.command.http' | 'codex.command.queue_wait' | 'codex.command.preparation',
  commandId: unknown,
  parent: Context,
): Span | undefined {
  try {
    return tracer.startSpan(
      name,
      {
        attributes: {
          ...(typeof commandId === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(commandId)
            ? { 'mitzo.command.id': commandId }
            : {}),
        },
      },
      parent,
    );
  } catch {
    return undefined;
  }
}
export function finishCommandTimingSpan(
  span: Span | undefined,
  outcome: 'claimed' | 'cancelled' | 'closed' | 'submitted' | 'stopped' | number,
): void {
  try {
    span?.setAttribute('mitzo.timing.outcome', outcome);
  } catch {
    /* observational */
  }
  try {
    span?.end();
  } catch {
    /* observational */
  }
}
