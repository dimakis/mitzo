import type { Context, Span } from '@opentelemetry/api';
import { tracer } from './tracing.js';
import { createLogger } from './logger.js';

const reported = new Set<string>();
/** Telemetry must never alter command execution. Report a bounded diagnostic once per stage. */
export function timingObservation(stage: string, work: () => void) {
  try {
    work();
  } catch {
    if (reported.has(stage)) return;
    reported.add(stage);
    createLogger('command-timing').warn('Command timing observation unavailable', {
      code: 'command_timing_failed',
      stage,
    });
  }
}

export type QueueReason =
  'queued' | 'active_turn' | 'recovery' | 'deployment' | 'admission' | 'eligible';
const queueReasons = new WeakMap<Span, QueueReason>();
export function recordCommandQueueReason(span: Span | undefined, reason: QueueReason) {
  if (!span || queueReasons.get(span) === reason) return;
  queueReasons.set(span, reason);
  timingObservation('queue_reason', () => {
    span.setAttribute('mitzo.queue.reason', reason);
    span.addEvent('queue.reason_changed', { 'mitzo.queue.reason': reason });
  });
}

/** Timing is observational: exporter/instrumentation faults grant no authority
 * and cannot refuse an otherwise valid command or change its durable state. */
export function startCommandTimingSpan(
  name: 'codex.command.http' | 'codex.command.queue_wait' | 'codex.command.preparation',
  commandId: unknown,
  parent: Context,
): Span | undefined {
  let span: Span | undefined;
  timingObservation('start', () => {
    span = tracer.startSpan(
      name,
      {
        attributes: {
          ...(typeof commandId === 'string' &&
          /^(?:(?:session-prompt|collaboration):)?[a-zA-Z0-9_-]{1,256}$/.test(commandId) &&
          commandId.length <= 256
            ? { 'mitzo.command.id': commandId }
            : {}),
        },
      },
      parent,
    );
  });
  return span;
}
export function finishCommandTimingSpan(
  span: Span | undefined,
  outcome: 'claimed' | 'cancelled' | 'closed' | 'submitted' | 'stopped' | number,
): void {
  timingObservation('outcome', () => {
    span?.setAttribute('mitzo.timing.outcome', outcome);
  });
  timingObservation('end', () => {
    span?.end();
  });
}
