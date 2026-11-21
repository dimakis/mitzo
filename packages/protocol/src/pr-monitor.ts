import { z } from 'zod';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';

const reference = z.string().trim().min(1).max(200);
const revision = z.number().int().nonnegative();
const timestamp = z.number().int().nonnegative();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PrMonitorAuthorityReferenceSchema = z.strictObject({
  id: z.uuid(),
  revision: revision.min(1),
  expiresAt: timestamp,
});
export const PrMonitorSubscriptionSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  revision: revision.min(1),
  operatorId: reference,
  conversationId: reference,
  github: z.strictObject({
    connectionId: z.uuid(),
    identityRevision: reference,
    repositoryId: reference,
    owner: z
      .string()
      .regex(/^[\w.-]+$/)
      .max(100),
    name: z
      .string()
      .regex(/^[\w.-]+$/)
      .max(100),
    pr: z.number().int().positive(),
    prNodeId: reference,
  }),
  head: z.strictObject({ sha, baseSha: sha, generation: revision.min(1) }).nullable(),
  execution: z.strictObject({
    binding: SessionRuntimeBindingV2Schema,
    selectionRevision: reference,
    profileRevision: reference,
    workspaceId: reference,
  }),
  watch: PrMonitorAuthorityReferenceSchema.nullable(),
  autoFix: PrMonitorAuthorityReferenceSchema.nullable(),
  merge: z.strictObject({ id: reference, headSha: sha, baseSha: sha }).nullable(),
  lifecycle: z.enum(['watching', 'paused', 'closed', 'merged', 'unavailable', 'removed']),
  lastAttemptAt: timestamp.nullable(),
  lastSuccessfulRefreshAt: timestamp.nullable(),
  nextRefreshAt: timestamp.nullable(),
  snapshotRevision: revision,
  eligibilityRevision: revision,
  eligibilityDigest: digest,
});
export type PrMonitorSubscription = z.infer<typeof PrMonitorSubscriptionSchema>;
export const PrMonitorAuthoritySchema = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    revision: revision.min(1),
    kind: z.enum(['pr-watch', 'pr-auto-fix']),
    subscriptionId: z.uuid(),
    conversationId: reference,
    issuer: z.strictObject({
      realm: z.literal('ordinary'),
      subject: z.literal('user'),
      authSessionId: reference,
      authExpiresAt: timestamp,
    }),
    scope: z.strictObject({
      connectionId: z.uuid(),
      connectionRevision: reference,
      githubPrincipalId: reference,
      repositoryId: reference,
      prNodeId: reference,
    }),
    settingsDigest: digest.nullable(),
    maxAttemptsPerBatch: z.number().int().positive().nullable(),
    maxCommandsPerHour: z.number().int().positive().nullable(),
    expiresAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.expiresAt > value.issuer.authExpiresAt ||
      (value.kind === 'pr-watch' &&
        (value.settingsDigest !== null ||
          value.maxAttemptsPerBatch !== null ||
          value.maxCommandsPerHour !== null)) ||
      (value.kind === 'pr-auto-fix' &&
        (!value.settingsDigest || !value.maxAttemptsPerBatch || !value.maxCommandsPerHour))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid monitor authority bounds' });
  });
export type PrMonitorAuthority = z.infer<typeof PrMonitorAuthoritySchema>;
export const PrMonitorReferenceSchema = z.strictObject({
  kind: z.enum(['job', 'check', 'review']),
  id: reference,
  url: z
    .url()
    .max(2048)
    .refine((value) => {
      const u = new URL(value);
      return (
        u.origin === 'https://github.com' && !u.username && !u.password && !u.search && !u.hash
      );
    }),
});
export const PrMonitorFindingSchema = z.strictObject({
  kind: z.enum(['ci_failure', 'review_actionable']),
  sourceIds: z.array(reference).min(1).max(20),
  summary: z.string().max(4096),
  references: z.array(PrMonitorReferenceSchema).max(20),
  truncated: z.boolean(),
});
export type PrMonitorFinding = z.infer<typeof PrMonitorFindingSchema>;
export const PrMonitorSnapshotSchema = z.strictObject({
  title: z.string().max(1024),
  state: z.enum(['open', 'closed', 'merged']),
  headSha: sha,
  baseSha: sha,
  complete: z.boolean(),
  observedAt: timestamp,
  ci: z.enum(['none', 'pending', 'passed', 'failed', 'partial']),
  review: z.enum(['none', 'pending', 'actionable', 'partial']),
});
export type PrMonitorSnapshot = z.infer<typeof PrMonitorSnapshotSchema>;
export type PrMonitorEvent = PrMonitorFinding & {
  version: 1;
  id: string;
  subscriptionId: string;
  headSha: string;
  generation: number;
  evidenceDigest: string;
  observedAt: number;
  disposition: 'status_only' | 'actionable' | 'recovered' | 'superseded';
};
export type PrMonitorDiagnostic = {
  code:
    | 'rate_limited'
    | 'read_failed'
    | 'authority_unavailable'
    | 'connection_unavailable'
    | 'conversation_unavailable'
    | 'head_changed'
    | 'incomplete'
    | 'quota_delayed';
  stage: 'read' | 'publish' | 'reconcile';
  nextRefreshAt: number | null;
};
/** Observation outbox only. Delivery owns command allocation and native receipts. */
export type PrMonitorObservation = {
  baselinePending: boolean;
  failureCount: number;
  subscription: PrMonitorSubscription;
  snapshot: PrMonitorSnapshot | null;
  events: PrMonitorEvent[];
  outbox: {
    eventIds: string[];
    eligibilityRevision: number;
    eligibilityDigest: string;
    headSha: string;
    generation: number;
    availableAt: number;
    firstObservedAt: number;
    overflow: number;
  } | null;
  refreshState: 'current' | 'partial' | 'stale' | 'quota_delayed' | 'backoff' | 'blocked';
  diagnostic: PrMonitorDiagnostic | null;
  counters: { observations: number; distinctEvents: number; modelTurns: 0 };
};
