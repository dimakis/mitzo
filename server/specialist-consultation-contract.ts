import { z } from 'zod';
import { AgentProfileSelectionSchema, CollaborationSnapshotSelectionSchema } from '@mitzo/protocol';

const id = z.string().trim().min(1).max(200);
export const SpecialistRouteInputSchema = z.strictObject({
  role: id,
  agent: AgentProfileSelectionSchema.optional(),
  accountId: id,
  model: id,
  modelFamily: id.optional(),
  reasoningEffort: id.nullable(),
  runOn: z.enum(['local', 'openshell']).default('local'),
  targetId: id,
});
export const SpecialistRouteSchema = SpecialistRouteInputSchema.extend({
  agent: AgentProfileSelectionSchema,
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  provider: id,
  accountRevision: id,
});
export const ConsultationInputSchema = z.strictObject({
  requestId: z.uuid(),
  role: id,
  assignment: z.string().trim().min(1).max(16000),
  messageIds: z.array(id).max(20).default([]),
  artifacts: CollaborationSnapshotSelectionSchema.shape.artifacts.max(10).default([]),
  reviewOf: z.uuid().optional(),
});
export type ConsultationInput = z.infer<typeof ConsultationInputSchema>;
// Retained in the existing policy receipt alongside its resolved profile pins.
// Defaults make omitted and explicitly defaulted retries the same request.
export const SpecialistAuthorizationInputSchema = z
  .strictObject({
    requestId: z.uuid(),
    repository: id,
    connectionId: id,
    routes: z.array(SpecialistRouteInputSchema).min(1).max(8),
    durationMinutes: z.number().int().min(1).max(120).default(30),
    maxConsultations: z.number().int().min(1).max(8).default(4),
    maxContextBytes: z.number().int().min(1).max(128000).default(32000),
  })
  .transform((input) => ({
    ...input,
    routes: input.routes.map(({ agent, modelFamily, ...route }) => ({
      ...route,
      ...(agent === undefined ? {} : { agent }),
      ...(modelFamily === undefined ? {} : { modelFamily }),
    })),
  }));
export const SpecialistPolicyInputSchema = z.strictObject({
  requestId: z.uuid(),
  expiresAt: z.number().int().positive(),
  maxConsultations: z.number().int().min(1).max(8),
  maxContextBytes: z.number().int().min(1).max(128000),
  repository: id,
  connectionId: id,
  routes: z.array(SpecialistRouteSchema).min(1).max(8),
});
export const SpecialistPolicySchema = SpecialistPolicyInputSchema.extend({
  policyId: z.uuid(),
  collaborationId: z.uuid(),
  leadSessionId: id,
  authSessionId: id,
  revoked: z.boolean(),
});
export type SpecialistPolicy = z.infer<typeof SpecialistPolicySchema>;
export type SpecialistRoute = z.infer<typeof SpecialistRouteSchema>;
export const ConsultationRecordSchema = z.strictObject({
  requestId: z.uuid(),
  policyId: z.uuid(),
  leadSessionId: id,
  revision: z.number().int().nonnegative(),
  attemptOrdinal: z.number().int().nonnegative().max(7),
  input: ConsultationInputSchema,
  route: SpecialistRouteSchema,
  boundary: CollaborationSnapshotSelectionSchema.shape.boundary,
  workspaceId: z.uuid(),
  reviewRequestId: z.uuid(),
  joinRequestId: z.uuid(),
  sendRequestId: z.uuid(),
  state: z.enum([
    'reserved',
    'preparing',
    'reviewed',
    'joined',
    'dispatched',
    'uncertain',
    'stopped',
  ]),
  sessionId: id.nullable(),
  joinId: z.uuid().nullable(),
  review: z.unknown().optional(),
  messageInput: z.unknown().optional(),
  routingAudit: z.unknown().optional(),
  contextEnvelope: z.unknown().optional(),
  diagnostic: z.strictObject({ code: id, stage: id, message: z.string().max(1000) }).nullable(),
});
export type ConsultationRecord = z.infer<typeof ConsultationRecordSchema>;

export const specialistToolSchema = z.strictObject({
  operation: z.enum(['catalog', 'authorize', 'consult', 'read', 'recover', 'stop', 'revoke']),
  requestId: z.uuid().optional(),
  policyId: z.uuid().optional(),
  role: id.optional(),
  assignment: z.string().trim().min(1).max(16000).optional(),
  messageIds: z.array(id).max(20).optional(),
  artifacts: CollaborationSnapshotSelectionSchema.shape.artifacts.max(10).optional(),
  reviewOf: z.uuid().optional(),
  routes: z.array(SpecialistRouteInputSchema).min(1).max(8).optional(),
  repository: id.optional(),
  connectionId: id.optional(),
  durationMinutes: z.number().int().min(1).max(120).optional(),
  maxConsultations: z.number().int().min(1).max(8).optional(),
  maxContextBytes: z.number().int().min(1).max(128000).optional(),
});
/** Validation precedes service entry and all approvals, allocation and dispatch.
 * This typed refusal proves no effect started; later service errors do not. */
export class SpecialistInputError extends Error {
  constructor(readonly missingFields: readonly string[]) {
    super(`Required specialist inputs: ${missingFields.join(', ')}`);
  }
}
export function parseSpecialistToolInput(raw: unknown) {
  const input = specialistToolSchema.parse(raw);
  const required: Record<typeof input.operation, readonly (keyof typeof input)[]> = {
    catalog: [],
    authorize: ['requestId', 'repository', 'connectionId', 'routes'],
    consult: ['requestId', 'policyId', 'role', 'assignment'],
    read: ['requestId'],
    recover: ['requestId'],
    stop: ['requestId'],
    revoke: ['policyId'],
  };
  const missing = required[input.operation].filter((key) => input[key] === undefined);
  if (missing.length) throw new SpecialistInputError(missing);
  return input;
}
export const specialistToolDefinition = {
  name: 'SymposiumConsult',
  description:
    'Consult saved specialists in ordinary shared conversations. Catalog profiles/routes and repository connection IDs first. Authorize requires requestId, repository, connectionId and routes for operator review. Consult requires policyId, requestId, role and assignment with selected public context. reviewOf requests independent review of a completed contribution. Read/recover/stop require the original requestId; revoke requires policyId. Read returns attributed results without model work. Retain policyId/requestId after interruption. No tools, merge or deployment authority is inherited.',
  input_schema: z.toJSONSchema(specialistToolSchema),
};
export const SPECIALIST_INSTRUCTIONS =
  '\nUse SymposiumConsult when consequential planning, product decisions, investigations or delivery would benefit from a saved specialist. Simple tasks stay with you; do not call a separate classifier. Catalog and select published profiles and eligible configured routes, then authorize one bounded policy for the work. Prefer a strong planner followed by an independent strong reviewer from another model family when an eligible route exists. Use reviewOf to retain that relationship. Request only needed public context; never copy hidden reasoning, credentials or private tool payloads. Consultations return receipts: use read until a terminal attributed contribution is available, then reconcile it and continue as the accountable lead. Do not equate joining, dispatch or partial text with completion. State routing refusals, uncertain outcomes and unavailable independence explicitly. The catalog names an account with no repository source in unavailable as repository_scope_not_assigned, repository_connection_unverified, repository_connection_unavailable or repository_scope_ambiguous; the operator assigns that account to the GitHub connection in Connections. Never recruit recursively or start unbounded review loops.\n';
