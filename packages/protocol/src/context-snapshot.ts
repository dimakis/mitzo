import { z } from 'zod';
import { ContextMeasurementSchema, ContextObservationSchema } from './context-measurement.js';

export const ContextSnapshotScopeSchema = ContextObservationSchema.omit({ observedAt: true });
export type ContextSnapshotScope = z.infer<typeof ContextSnapshotScopeSchema>;

export const ContextSnapshotReasonSchema = z.enum([
  'not_observed',
  'adapter_not_attached',
  'unsupported_route',
  'refresh_unsupported',
  'control_missing',
  'query_retired',
  'scope_changed',
  'timed_out',
  'cancelled',
  'invalid_response',
  'control_failed',
  'token_count_not_authorized',
  'authority_expired',
  'detached',
  'suspended',
  'compacted',
  'turn_completed',
  'restored',
  'expired',
  'superseded',
  'storage_failed',
  'request_conflict',
]);
export type ContextSnapshotReason = z.infer<typeof ContextSnapshotReasonSchema>;
export const ContextSnapshotRequestSchema = z.strictObject({
  requestId: z.string().uuid(),
  detail: z.enum(['summary', 'full']).default('summary'),
  /** Explicit browser consent; the host must also recheck its current authority. */
  allowTokenCount: z.literal(true).optional(),
});
export type ContextSnapshotRequest = z.infer<typeof ContextSnapshotRequestSchema>;
export const ContextSnapshotResponseSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(256),
    revision: z.number().int().nonnegative().safe(),
    status: z.enum([
      'available',
      'partial',
      'stale',
      'unavailable',
      'loading',
      'cancelled',
      'failed',
    ]),
    reason: ContextSnapshotReasonSchema.optional(),
    snapshot: ContextMeasurementSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.snapshot && value.snapshot.identity.sessionId !== value.sessionId)
      ctx.addIssue({ code: 'custom', message: 'Snapshot response session mismatch' });
    if (
      ['available', 'partial'].includes(value.status) &&
      value.snapshot?.freshness.state !== 'current'
    )
      ctx.addIssue({ code: 'custom', message: 'Available snapshots require current evidence' });
    if (value.status === 'stale' && value.snapshot?.freshness.state !== 'stale')
      ctx.addIssue({ code: 'custom', message: 'Stale snapshots require stale evidence' });
  });
export type ContextSnapshotResponse = z.infer<typeof ContextSnapshotResponseSchema>;

/** Host-only adapter interface, never serialized or accepted in a browser request.
 * One object per native query/turn; ownership remains with ManagedSession.
 */
export interface ContextSnapshotOwner {
  scope: ContextSnapshotScope;
  state: 'active' | 'retired' | 'detached' | 'suspended';
  collect?: (input: {
    detail: 'summary' | 'full';
    signal: AbortSignal;
    assertCurrent(): void;
    authorizeFull(): Promise<boolean>;
  }) => Promise<
    | { status: 'available'; snapshot: z.infer<typeof ContextMeasurementSchema> }
    | { status: 'unavailable'; reason: ContextSnapshotReason }
  >;
}

/** Canonicalized known fields only. Never accept a client-selected owner as authority. */
export function contextSnapshotScopeKey(scope: ContextSnapshotScope): string {
  return JSON.stringify(ContextSnapshotScopeSchema.parse(scope));
}
