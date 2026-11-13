import { z } from 'zod';
import { AgentProfileSelectionSchema, CollaborationSnapshotSelectionSchema } from '@mitzo/protocol';

const id = z.string().trim().min(1).max(200);
export const SpecialistRouteInputSchema = z.strictObject({
  role: id,
  agent: AgentProfileSelectionSchema.optional(),
  accountId: id,
  model: id,
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
  input: ConsultationInputSchema,
  route: SpecialistRouteSchema,
  boundary: CollaborationSnapshotSelectionSchema.shape.boundary,
  workspaceId: z.uuid(),
  reviewRequestId: z.uuid(),
  joinRequestId: z.uuid(),
  sendRequestId: z.uuid(),
  stopRequestId: z.uuid(),
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
  diagnostic: z.strictObject({ code: id, stage: id, message: z.string().max(1000) }).nullable(),
});
export type ConsultationRecord = z.infer<typeof ConsultationRecordSchema>;

export const specialistToolSchema = z.strictObject({
  operation: z.enum(['catalog', 'authorize', 'consult', 'read', 'stop', 'revoke']),
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
export const specialistToolDefinition = {
  name: 'SymposiumConsult',
  description:
    'Consult saved specialist agents through ordinary shared conversations. First catalog profiles, eligible account/model/runtime routes and repository sources; authorize a bounded session policy with concrete routes for operator review. Then consult by role with an assignment and selected public message/artifact references. reviewOf requests independent review of a completed contribution; choose an eligible different model family when configured. Read returns attributed results and original receipts without model work. Stop targets the original work; revoke prevents future work. Retain policyId and requestId after interruption. No manual agent choice before starting the lead chat is required. Policy approval authorizes only bounded requested turns; it grants no specialist tools, merge or deployment authority.',
  input_schema: z.toJSONSchema(specialistToolSchema),
};
export const SPECIALIST_INSTRUCTIONS =
  '\nUse SymposiumConsult when consequential planning, product decisions, investigations or delivery would benefit from a saved specialist. Simple tasks stay with you; do not call a separate classifier. Catalog and select published profiles and eligible configured routes, then authorize one bounded policy for the work. Prefer a strong planner followed by an independent strong reviewer from another model family when an eligible route exists. Use reviewOf to retain that relationship. Request only needed public context; never copy hidden reasoning, credentials or private tool payloads. Consultations return receipts: use read until a terminal attributed contribution is available, then reconcile it and continue as the accountable lead. Do not equate joining, dispatch or partial text with completion. State routing refusals, uncertain outcomes and unavailable independence explicitly. Never recruit recursively or start unbounded review loops.\n';
