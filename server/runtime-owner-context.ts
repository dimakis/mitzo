import { context } from '@opentelemetry/api';
import { runOutsideToolGuard } from '@mitzo/harness';
import { runOutsideTurnCallbackEffects } from './turn-callbacks.js';

/**
 * A native provider query is a long-lived resource of its session owner. Work
 * may be admitted into that owner from an operator socket, a timer or another
 * session's tool call (a delivered peer message). Node async context follows
 * resource creation, so a query created inside a peer's tool call would run
 * every later hook and MCP callback inside that peer's tool guard and turn:
 * borrowing (and, once it settles, losing) authority that is not the owner's.
 *
 * Capture the calling turn's trace and create that native query outside any
 * caller-scoped tool guard or turn effect owner. Callbacks start their own root
 * guards and are fenced only by the owner's ordinary authority.
 *
 * Build this at each native query creation, not once per runtime: a session
 * runtime creates a successor query for every later turn, and a context captured
 * at startup would stamp that first turn's trace on all of them. Capturing per
 * turn keeps a peer-started turn correlated with the send that admitted it
 * without leaking that sender's trace into unrelated later turns.
 */
export function createRuntimeOwnerContext() {
  const trace = context.active();
  return <T>(create: () => T): T =>
    context.with(trace, () => runOutsideToolGuard(() => runOutsideTurnCallbackEffects(create)));
}
