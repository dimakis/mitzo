import type { RuntimeReadiness, SessionControlSupport } from '@mitzo/protocol';

/** Reuse the validated Access/readiness owner. Do not discover accounts, acquire
 * a runtime, inspect private provider history, or turn SDK API presence into a
 * callable product control. See docs/features/session-controls.md for evidence.
 */
export function projectSessionControlSupport(readiness: RuntimeReadiness): SessionControlSupport {
  const base = {
    policyRevision: 'session-controls-2026-11-13' as const,
    readinessRevision: readiness.revision,
  };
  const { execution } = readiness;
  if (execution.state === 'unknown') {
    const unknown = { state: 'unknown' as const, reason: execution.reason };
    return { ...base, branching: unknown, contextInspection: unknown, rewind: unknown };
  }
  const { harness, execution: target } = execution.binding;
  const recordedInspection =
    harness.implementation === 'codex' ||
    (harness.implementation === 'claude-sdk' && target.location === 'local');
  const unavailable = {
    state: 'unavailable' as const,
    reason: recordedInspection ? ('not_integrated' as const) : ('route_not_qualified' as const),
  };
  return {
    ...base,
    branching: unavailable,
    contextInspection: recordedInspection
      ? { state: 'limited', reason: 'recorded_usage_only' }
      : unavailable,
    rewind: unavailable,
  };
}
