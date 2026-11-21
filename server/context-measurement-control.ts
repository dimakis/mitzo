import {
  ContextObservationSchema,
  type ContextMeasurement,
  type ContextObservation,
} from '@mitzo/protocol';
import { normalizeClaudeContext } from './context-measurement-adapters.js';
import { createLogger } from './logger.js';

const log = createLogger('context-measurement');
export type ContextInspectionReason =
  | 'unsupported_route'
  | 'control_missing'
  | 'query_retired'
  | 'scope_changed'
  | 'timed_out'
  | 'cancelled'
  | 'invalid_response'
  | 'control_failed'
  | 'token_count_not_authorized';
export type ContextInspectionResult =
  | { status: 'available'; snapshot: ContextMeasurement }
  | { status: 'unavailable'; reason: ContextInspectionReason };
export type ContextInspectionOwner = ContextObservation & { active: boolean; query: object };
class Unavailable extends Error {
  constructor(readonly reason: ContextInspectionReason) {
    super(reason);
  }
}

/** The caller supplies an already authorized owner, never a factory. This port does not
 * acquire a runtime. Full-detail authority belongs to the host caller and is rechecked.
 * No coalescing: each invocation owns its deadline, cancellation and authority lifetime.
 */
export async function inspectClaudeContext(input: {
  current(): ContextInspectionOwner | undefined;
  signal: AbortSignal;
  detail?: 'summary' | 'full';
  authorizeFull?: () => Promise<boolean>;
  timeoutMs?: number;
  now?: () => number;
  diagnostic?: (event: {
    reason: ContextInspectionReason;
    sessionId?: string;
    stage: string;
  }) => void;
}): Promise<ContextInspectionResult> {
  let owner: ContextInspectionOwner | undefined;
  let sessionId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  let finished = false;
  try {
    if (input.signal.aborted) throw new Unavailable('cancelled');
    owner = input.current();
    if (!owner || !owner.active) throw new Unavailable('query_retired');
    const context = ContextObservationSchema.parse(owner);
    sessionId = context.identity.sessionId;
    if (context.binding.engine !== 'claude' || context.binding.placement !== 'local')
      throw new Unavailable('unsupported_route');
    const query = owner.query;
    const control: unknown = Reflect.get(query, 'getContextUsage', query);
    if (typeof control !== 'function') throw new Unavailable('control_missing');
    const identity = JSON.stringify({ identity: context.identity, binding: context.binding });
    const assertCurrent = () => {
      if (input.signal.aborted) throw new Unavailable('cancelled');
      if (finished) throw new Unavailable('timed_out');
      const current = input.current();
      if (
        current !== owner ||
        !current?.active ||
        current.query !== query ||
        JSON.stringify({
          identity: ContextObservationSchema.parse(current).identity,
          binding: ContextObservationSchema.parse(current).binding,
        }) !== identity
      )
        throw new Unavailable('scope_changed');
    };
    const detail = input.detail ?? 'summary';
    const authorize = async () => {
      if (detail === 'full' && !(await input.authorizeFull?.()))
        throw new Unavailable('token_count_not_authorized');
      assertCurrent();
    };
    const bounded = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Unavailable('cancelled'));
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      const requested = input.timeoutMs ?? 5000;
      const timeout = Number.isFinite(requested) ? Math.max(1, Math.min(30_000, requested)) : 5000;
      timer = setTimeout(() => reject(new Unavailable('timed_out')), timeout);
    });
    const work = async (): Promise<ContextInspectionResult> => {
      await authorize();
      const response: unknown = await control.call(query, { detail });
      assertCurrent();
      await authorize();
      let snapshot: ContextMeasurement;
      try {
        snapshot = normalizeClaudeContext(
          response,
          { ...context, observedAt: (input.now ?? Date.now)() },
          detail,
        );
      } catch {
        throw new Unavailable('invalid_response');
      }
      return { status: 'available', snapshot };
    };
    return await Promise.race([work(), bounded]);
  } catch (error) {
    const reason = error instanceof Unavailable ? error.reason : 'control_failed';
    const event = { reason, sessionId, stage: 'context_inspection' };
    // Raw SDK errors can contain prompts or source paths; emit only bounded metadata.
    if (reason === 'control_failed' || reason === 'invalid_response')
      log.warn('Context inspection unavailable', event);
    try {
      input.diagnostic?.(event);
    } catch {
      log.warn('Context inspection diagnostic callback failed', {
        stage: 'context_inspection_diagnostic',
      });
    }
    return { status: 'unavailable', reason };
  } finally {
    finished = true;
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
  }
}
