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
 * Capture the owner's trace context once, then create each native query
 * outside any caller-scoped tool guard or turn effect owner. Callbacks start
 * their own root guards and are fenced only by the owner's ordinary authority.
 */
export function createRuntimeOwnerContext() {
  const trace = context.active();
  return <T>(create: () => T): T =>
    context.with(trace, () => runOutsideToolGuard(() => runOutsideTurnCallbackEffects(create)));
}
