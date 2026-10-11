import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import { assertNativeCodexContextAdmission } from './native-codex-context-admission.js';

// Retain authority in host memory, never in caller-controlled execution fields.
const executionAuthorizations = new WeakMap<
  SymposiumSeatExecution,
  (signal: AbortSignal) => Promise<void>
>();
export function bindSymposiumAgentContextAuthorization(
  execution: SymposiumSeatExecution,
  authorize: (signal: AbortSignal) => Promise<void>,
) {
  if (executionAuthorizations.has(execution)) throw Error('Context authorization is already bound');
  executionAuthorizations.set(execution, async (signal) => {
    execution.signal.throwIfAborted();
    signal.throwIfAborted();
    await authorize(signal);
    execution.signal.throwIfAborted();
    signal.throwIfAborted();
  });
}
export function symposiumAgentContextAuthorization(execution: SymposiumSeatExecution) {
  const authorize = executionAuthorizations.get(execution);
  if (!authorize && (execution.seat.contextRecipe || execution.agentContext))
    throw Error('Trusted prepared context authorization is unavailable');
  return authorize;
}

/** Shared Codex turns and native seats cannot silently drop prepared pack context. */
export function assertSymposiumNativeCodexContextAdmission(input: SymposiumSeatExecution): void {
  assertNativeCodexContextAdmission(input.seat.contextRecipe, input.agentContext);
  // Preparation issues this trusted binding only for published packs. Caller-visible
  // fields can change, but cannot erase the retained execution's source authority.
  if (symposiumAgentContextAuthorization(input))
    assertNativeCodexContextAdmission({ source: 'packs' });
}
