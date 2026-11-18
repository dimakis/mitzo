import { createLogger } from './logger.js';

const log = createLogger('sdk-late-steer-hold');

/** Upper bound for the CLI to dequeue a late steer after its terminal result.
 * The live CLI echoes it in under a second; the follow-up turn's model latency
 * comes after the echo and is not covered by this bound. */
export const LATE_STEER_ECHO_TIMEOUT_MS = 10_000;
/** Process-wide bound; tests shorten it instead of faking stream timers. */
export const lateSteerHold = { echoTimeoutMs: LATE_STEER_ECHO_TIMEOUT_MS };

export type LateSteerLabel = { kind: 'correction' | 'peer'; id: string };

const TIMEOUT = Symbol('late-steer-timeout');

/**
 * A steer released to stdin during a turn's final model request is not folded
 * into that turn: Claude Code emits the terminal result and then immediately runs
 * the steer as a follow-up turn in the same process. Without this hold the owner
 * treats the first result as the command's end, retires the query, and its hooks
 * refuse the follow-up turn, which loses the steer.
 *
 * This keeps exactly that result back while the steer's echo is outstanding. The
 * follow-up turn then streams under the same command, and its own result ends
 * the command. If no follow-up starts within the bound, the held result is
 * released unchanged, so the existing unconfirmed settlement still applies.
 */
export async function* holdResultForLateSteer<E extends Record<string, unknown>>(
  source: AsyncIterable<E>,
  owner: {
    /** Claim one un-echoed steer for this result, if any. */
    hold(): LateSteerLabel | undefined;
    /** Whether a claimed steer still awaits its provider echo. */
    awaiting(): boolean;
    signal: AbortSignal;
    sessionId: string;
    timeoutMs?: number;
  },
): AsyncGenerator<E> {
  const iterator = source[Symbol.asyncIterator]();
  const timeoutMs = owner.timeoutMs ?? lateSteerHold.echoTimeoutMs;
  let held: { event: E; label: LateSteerLabel; since: number } | undefined;
  let next: Promise<IteratorResult<E>> | undefined;
  let finished = false;
  try {
    for (;;) {
      let step: IteratorResult<E> | typeof TIMEOUT;
      try {
        next ??= iterator.next();
        if (held && !owner.signal.aborted) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let onAbort: (() => void) | undefined;
          const deadline = new Promise<typeof TIMEOUT>((resolve) => {
            timer = setTimeout(
              () => resolve(TIMEOUT),
              Math.max(0, held!.since + timeoutMs - Date.now()),
            );
            onAbort = () => resolve(TIMEOUT);
            owner.signal.addEventListener('abort', onAbort, { once: true });
          });
          try {
            step = await Promise.race([next, deadline]);
          } finally {
            clearTimeout(timer);
            if (onAbort) owner.signal.removeEventListener('abort', onAbort);
          }
        } else step = await next;
      } catch (error) {
        // The native iterator can fail after its turn completed, for example
        // while closing. Release a held result first: the owner then settles
        // it as terminal and handles this failure as post-terminal instead of
        // reporting the completed command as failed.
        if (held) {
          const released = held;
          held = undefined;
          log.warn('SDK stream failed while a result was held for a late steer', {
            code: 'sdk_late_steer_stream_failed',
            stage: 'follow_up_turn',
            sessionId: owner.sessionId,
            steerKind: released.label.kind,
            steerId: released.label.id,
          });
          yield released.event;
        }
        throw error;
      }

      if (step === TIMEOUT) {
        const released = held!;
        held = undefined;
        if (!owner.signal.aborted)
          log.warn('Late steer follow-up turn did not start; releasing the held result', {
            code: 'sdk_late_steer_follow_up_missing',
            stage: 'follow_up_turn',
            sessionId: owner.sessionId,
            steerKind: released.label.kind,
            steerId: released.label.id,
            waitedMs: Date.now() - released.since,
          });
        yield released.event;
        continue; // the outstanding next() is still pending
      }
      next = undefined;
      if (step.done) {
        finished = true;
        if (held) {
          const released = held;
          held = undefined;
          log.warn('SDK stream ended while a result was held for a late steer', {
            code: 'sdk_late_steer_stream_ended',
            stage: 'follow_up_turn',
            sessionId: owner.sessionId,
            steerKind: released.label.kind,
            steerId: released.label.id,
          });
          yield released.event;
        }
        return;
      }
      const event = step.value;
      if (event.type === 'result') {
        if (held) {
          // A further result while the echo is still missing ends the follow-up
          // window: the earlier result is superseded and this one is terminal.
          log.warn('Follow-up result arrived without the late steer echo', {
            code: 'sdk_late_steer_echo_missing',
            stage: 'follow_up_turn',
            sessionId: owner.sessionId,
            steerKind: held.label.kind,
            steerId: held.label.id,
          });
          held = undefined;
        }
        const label = owner.signal.aborted ? undefined : owner.hold();
        if (label) {
          held = { event, label, since: Date.now() };
          log.info('Holding turn result for a late steer follow-up turn', {
            code: 'sdk_late_steer_held',
            stage: 'turn_completion',
            sessionId: owner.sessionId,
            steerKind: label.kind,
            steerId: label.id,
            heldCostUsd:
              typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
          });
          continue;
        }
        yield event;
        continue;
      }
      yield event;
      if (held && !owner.awaiting()) {
        log.info('Late steer echoed; follow-up turn continues the command', {
          code: 'sdk_late_steer_follow_up',
          stage: 'follow_up_turn',
          sessionId: owner.sessionId,
          steerKind: held.label.kind,
          steerId: held.label.id,
          echoMs: Date.now() - held.since,
        });
        held = undefined;
      }
    }
  } finally {
    // Preserve for-await close semantics: only an early exit closes the source.
    if (!finished) await iterator.return?.();
  }
}
