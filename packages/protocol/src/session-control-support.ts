import { z } from 'zod';

const unknown = z.strictObject({
  state: z.literal('unknown'),
  reason: z.enum([
    'session_unavailable',
    'not_observed',
    'invalid_evidence',
    'scope_mismatch',
    'owner_unavailable',
  ]),
});
const unavailable = z.strictObject({
  state: z.literal('unavailable'),
  reason: z.enum(['not_integrated', 'route_not_qualified']),
});
const mutation = z.discriminatedUnion('state', [unknown, unavailable]);

/** Source-qualified product limits, bound to the enclosing readiness snapshot.
 * This is neither operation evidence nor permission to call a native SDK API.
 * Recorded usage can be absent/stale; its own timestamp remains authoritative.
 * There is deliberately no executable branching or rewind state in this policy.
 */
export const SessionControlSupportSchema = z.strictObject({
  policyRevision: z.literal('session-controls-2026-11-13'),
  readinessRevision: z.string().regex(/^[a-f0-9]{64}$/),
  branching: mutation,
  contextInspection: z.discriminatedUnion('state', [
    unknown,
    unavailable,
    z.strictObject({ state: z.literal('limited'), reason: z.literal('recorded_usage_only') }),
  ]),
  rewind: mutation,
});

export type SessionControlSupport = z.infer<typeof SessionControlSupportSchema>;
