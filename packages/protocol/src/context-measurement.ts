import { z } from 'zod';
import { ModelTokenLimitsSchema } from './token-limits.js';

const text = z.string().min(1).max(256);
const count = z.number().int().nonnegative().safe();
const assurance = z.enum(['provider-reported', 'estimated', 'unknown']);

export const ContextObservationSchema = z.object({
  identity: z.object({
    sessionId: text,
    threadId: text.optional(),
    queryId: text.optional(),
    turnId: text.optional(),
    parentSessionId: text.optional(),
    scope: z.enum(['parent', 'subagent']),
    ownerGeneration: text,
  }),
  binding: z.object({
    engine: z.enum(['claude', 'codex']),
    placement: z.enum(['local', 'openshell']),
    model: text,
    accountRef: text,
    runtimeBindingRevision: text,
    runtimeVersion: text.optional(),
  }),
  /** Host receipt time, not the provider's last request time. */
  observedAt: count,
});
export type ContextObservation = z.infer<typeof ContextObservationSchema>;

export const ContextRequestUsageSchema = z
  .object({
    inputTokens: count,
    cachedInputTokens: count,
    outputTokens: count,
    reasoningOutputTokens: count,
    totalTokens: count,
  })
  .refine(
    (value) =>
      value.cachedInputTokens <= value.inputTokens &&
      value.reasoningOutputTokens <= value.outputTokens &&
      Number.isSafeInteger(value.inputTokens + value.outputTokens) &&
      value.totalTokens === value.inputTokens + value.outputTokens,
  );

/** Display evidence only. Neither occupancy estimates nor capacity authorize a request.
 * Unknown additive fields are stripped; unknown versions and invalid known fields fail.
 */
export const ContextMeasurementSchema = ContextObservationSchema.extend({
  version: z.literal(1),
  freshness: z.object({
    state: z.enum(['current', 'stale', 'unknown']),
    reason: text.optional(),
    expiresAt: count.optional(),
  }),
  measurement: z.object({
    basis: z.enum(['current-context-estimate', 'latest-request', 'host-assembly']),
    method: z.enum(['claude-summary', 'claude-full', 'codex-event', 'host-observation']),
    assurance: z.enum(['provider-reported', 'estimated', 'mixed']),
  }),
  usedTokens: count.optional(),
  requestUsage: ContextRequestUsageSchema.optional(),
  categories: z
    .array(
      z.object({
        key: text,
        providerId: text.optional(),
        label: text,
        kind: z.enum(['used', 'free', 'buffer', 'deferred', 'unknown']),
        tokens: count.optional(),
        assurance,
      }),
    )
    .max(256),
  contributions: z
    .array(
      z.object({
        id: text,
        categoryKey: text.optional(),
        /** Snapshot-local reference; no path/content or claim of retained source occupancy. */
        sourceRef: text,
        tokens: count.optional(),
        relation: z.enum(['partition', 'overlap', 'inventory', 'unknown']),
        assurance,
      }),
    )
    .max(2048),
  capacity: z.object({
    modelLimits: ModelTokenLimitsSchema.optional(),
    compactionWindowTokens: count.positive().optional(),
    usableWindowTokens: count.positive().optional(),
    bufferTokens: count.optional(),
    freeTokens: count.optional(),
    kind: z.enum(['model-limit', 'compaction-policy', 'unknown']),
    source: text,
    stale: z.boolean(),
  }),
  reconciliation: z.object({
    residualTokens: z.number().int().safe().optional(),
    status: z.enum(['consistent', 'partial', 'overlap', 'inconsistent', 'unknown']),
  }),
}).superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const { basis, method } = value.measurement;
  if (value.identity.scope === 'subagent' && !value.identity.parentSessionId)
    fail('Subagent observations require parent identity');
  if (value.identity.parentSessionId === value.identity.sessionId)
    fail('Parent and child identities must differ');
  if (basis !== 'current-context-estimate' && value.usedTokens !== undefined)
    fail('Request accounting and inventory are not current occupancy');
  if (
    method.startsWith('claude-') &&
    (value.binding.engine !== 'claude' ||
      value.binding.placement !== 'local' ||
      basis !== 'current-context-estimate')
  )
    fail('Claude inspection route or measurement basis mismatch');
  if (method === 'codex-event' && (value.binding.engine !== 'codex' || basis !== 'latest-request'))
    fail('Codex events describe latest-request accounting');
  if (method === 'host-observation' && basis !== 'host-assembly')
    fail('Host observations describe assembly only');
  if (value.capacity.modelLimits && value.capacity.modelLimits.model !== value.binding.model)
    fail('Capacity model differs from runtime binding');
  if (
    value.freshness.state === 'current' &&
    value.freshness.expiresAt !== undefined &&
    value.freshness.expiresAt <= value.observedAt
  )
    fail('Current observation is already expired');
  const keys = new Set(value.categories.map((row) => row.key));
  if (keys.size !== value.categories.length) fail('Duplicate category identity');
  if (new Set(value.contributions.map((row) => row.id)).size !== value.contributions.length)
    fail('Duplicate contribution identity');
  for (const row of value.contributions)
    if (row.categoryKey && !keys.has(row.categoryKey)) fail('Unknown contribution category');
});
export type ContextMeasurement = z.infer<typeof ContextMeasurementSchema>;
