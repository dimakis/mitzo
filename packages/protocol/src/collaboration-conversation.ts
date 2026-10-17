import { z } from 'zod';
import {
  SessionCollaborationIdSchema,
  SessionCollaborationSchema,
} from './session-collaboration.js';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';
import { OrdinaryLocalCommandSelectionSchema } from './ordinary-local-admission.js';
import { AgentProfileSelectionSchema } from './agent-library.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
const sequence = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z
  .array(id)
  .max(16)
  .refine((values) => new Set(values).size === values.length, 'Duplicate ID');
const request = { requestId: z.uuid(), expectedMembershipRevision: sequence };
const author = z.union([z.literal('operator'), z.strictObject({ sessionId: id })]);
export const CollaborationMessageSourceSchema = z.strictObject({
  conversationId: id,
  commandId: id,
  messageId: id,
  blockIds: z.array(id).max(100),
  throughSequence: sequence,
});
export const COLLABORATION_EXECUTION_DISABLED = {
  enabled: false,
  reason:
    'Fresh-agent preparation and ordinary delivery are not wired. No session or model is started.',
} as const;
export const CollaborationExecutionSchema = z.strictObject({
  enabled: z.literal(false),
  reason: z.literal(COLLABORATION_EXECUTION_DISABLED.reason),
});
/** An ordinary selection snapshot, never admission, credentials or a runtime registry. */
export const CollaborationSettingsSchema = z.strictObject({
  binding: SessionRuntimeBindingV2Schema,
  selection: OrdinaryLocalCommandSelectionSchema,
  repositoryWorkspaceId: id,
});
/** Trusted existing review reservation identity; not accepted from public routes. */
export const CollaborationReviewIdentitySchema = z.strictObject({
  collaborationId: SessionCollaborationIdSchema,
  operatorId: id,
  requestId: z.uuid(),
});
/** Schema normalization supplies stable key order; source bytes are deliberately
 * excluded so changed unfinished input conflicts under the original native operation. */
export function collaborationCapacityOperationKey(rawIdentity: unknown, rawSettings: unknown) {
  const identity = CollaborationReviewIdentitySchema.parse(rawIdentity);
  const settings = CollaborationSettingsSchema.parse(rawSettings);
  return JSON.stringify([
    identity.collaborationId,
    identity.operatorId,
    identity.requestId,
    settings,
  ]);
}
export const CollaborationPolicyUpdateSchema = z.strictObject({
  ...request,
  expectedRevision: sequence,
  sessionId: id,
  readsFutureDiscussion: z.boolean(),
  repliesByDefault: z.boolean(),
});
export const CollaborationBeginSchema = z.strictObject({ requestId: z.uuid(), sessionId: id });
export const CollaborationPolicySchema = z.strictObject({
  version: z.literal(1),
  sessionId: id,
  revision: sequence,
  membershipRevision: sequence,
  effectiveFromSequence: sequence,
  readsFutureDiscussion: z.boolean(),
  repliesByDefault: z.boolean(),
});
export const CollaborationSnapshotReferenceSchema = z.strictObject({
  snapshotId: z.uuid(),
  sha256: digest,
});
/** Public selectors only: the source owner must authorize and read exact versions server-side. */
export const CollaborationSnapshotSelectionSchema = z.strictObject({
  ...request,
  sourceConversationId: id,
  boundary: z.strictObject({ sequence, messageId: id.nullable() }),
  mode: z.enum(['conversation_so_far', 'selected']),
  messageIds: z.array(id).max(500),
  artifacts: z
    .array(
      z.strictObject({
        artifactId: id,
        revision: z.number().int().positive().safe(),
        sha256: digest,
      }),
    )
    .max(100),
  purpose: z.string().trim().min(1).max(4000),
  joiningBrief: z.string().max(20_000),
});
/** Application review intent only. Actual owners resolve settings, source access
 * and the unused prepared workspace; these selectors confer no capacity or send right. */
export const CollaborationApplicationReviewInputSchema = z.strictObject({
  selection: CollaborationSnapshotSelectionSchema,
  target: z.strictObject({
    runOn: z.enum(['local', 'openshell']),
    accountId: id,
    model: id,
    reasoningEffort: id.nullable(),
    agent: AgentProfileSelectionSchema.nullable(),
    repositoryWorkspaceId: id,
    permissionMode: OrdinaryLocalCommandSelectionSchema.shape.permission.shape.mode,
  }),
  previousSnapshot: CollaborationSnapshotReferenceSchema.optional(),
});
export type CollaborationApplicationReviewInput = z.infer<
  typeof CollaborationApplicationReviewInputSchema
>;
/** Transport correlation only; the server checks its existing live login binding. */
export const CollaborationApplicationReviewRequestSchema =
  CollaborationApplicationReviewInputSchema.extend({ clientId: id });
export const CollaborationMessageInputSchema = z.strictObject({
  ...request,
  expectedPolicySequence: sequence,
  text: z.string().min(1).max(100_000),
  responders: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('default') }),
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({ kind: z.literal('selected'), sessionIds: ids }),
  ]),
  snapshot: CollaborationSnapshotReferenceSchema.nullable(),
});
/** Trusted ordinary driver/source owner input. Text is read from finalized source events. */
export const CollaborationReplyInputSchema = z.strictObject({
  requestId: z.uuid(),
  messageId: z.uuid(),
  deliveryId: z.uuid(),
  source: CollaborationMessageSourceSchema.refine(
    (source) =>
      source.blockIds.length > 0 && new Set(source.blockIds).size === source.blockIds.length,
    'Reply source requires distinct text blocks',
  ),
});
export const CollaborationDeliveryReceiptInputSchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: sequence,
  status: z.enum(['pending', 'queued', 'delivered', 'failed', 'unavailable', 'uncertain']),
  commandId: id.nullable(),
  reason: z.string().min(1).max(1000).nullable(),
});
export const CollaborationDeliverySchema = z.strictObject({
  version: z.literal(1),
  deliveryId: z.uuid(),
  sessionId: id,
  purpose: z.enum(['context', 'reply']),
  revision: sequence,
  status: CollaborationDeliveryReceiptInputSchema.shape.status,
  commandId: id.nullable(),
  reason: z.string().max(1000).nullable(),
});
export const CollaborationMessageSchema = z
  .strictObject({
    version: z.literal(1),
    messageId: z.uuid(),
    projectionId: z.uuid(),
    sequence,
    author,
    text: z.string().min(1).max(100_000),
    // Replies must originate in an explicitly mapped ordinary command, never all session activity.
    source: CollaborationMessageSourceSchema.nullable(),
    replyToDeliveryId: z.uuid().nullable(),
    membershipRevision: sequence,
    policySequence: sequence,
    policyRevisions: z.record(id, sequence),
    responders: ids,
    readers: ids,
    snapshot: CollaborationSnapshotReferenceSchema.nullable(),
    settings: z.record(id, CollaborationSettingsSchema),
    deliveries: z.array(CollaborationDeliverySchema).max(16),
  })
  .superRefine((message, context) => {
    if (
      message.responders.some((id) => !message.readers.includes(id)) ||
      Object.keys(message.settings).sort().join('\0') !== [...message.readers].sort().join('\0') ||
      message.deliveries.length !== message.readers.length ||
      new Set(message.deliveries.map((d) => d.sessionId)).size !== message.readers.length ||
      message.deliveries.some(
        (d) =>
          !message.readers.includes(d.sessionId) ||
          d.purpose !== (message.responders.includes(d.sessionId) ? 'reply' : 'context'),
      )
    )
      context.addIssue({ code: 'custom', message: 'Delivery audience mismatch' });
    if (
      message.author === 'operator'
        ? message.source !== null || message.replyToDeliveryId !== null
        : !message.source ||
          !message.replyToDeliveryId ||
          message.source.conversationId !== message.author.sessionId
    )
      context.addIssue({ code: 'custom', message: 'Attributed source mismatch' });
  });
const block = z.strictObject({ blockId: id, content: z.string().max(500_000), sha256: digest });
export const CollaborationSnapshotMessageSchema = z.strictObject({
  conversationId: id,
  messageId: id,
  sequence,
  author,
  source: CollaborationMessageSourceSchema.nullable(),
  blocks: z.array(block).min(1).max(100),
});
const artifact = z.strictObject({
  artifactId: id,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: digest,
  sourceConversationId: id,
  mediaType: z.string().min(1).max(200),
  sizeBytes: sequence,
  // Absent on historical reference-only snapshots. Present only after authorized exact-byte reads.
  contentBase64: z
    .string()
    .max(512 * 1024)
    .optional(),
});
/** Public fit evidence only. This review scope can never authorize command consumption. */
export const CollaborationNativeCapacityAssessmentSchema = z
  .strictObject({
    kind: z.literal('nativePreparedRequest'),
    scope: z.literal('reviewContext'),
    settings: CollaborationSettingsSchema,
    measurementId: z.uuid(),
    inputTokens: z.number().int().nonnegative().safe(),
    maxOutputTokens: z.number().int().positive().safe(),
    contextWindowTokens: z.number().int().positive().safe(),
  })
  .refine(
    (value) =>
      Number.isSafeInteger(value.inputTokens + value.maxOutputTokens) &&
      value.inputTokens + value.maxOutputTokens <= value.contextWindowTokens,
    'Native capacity accounting mismatch',
  );
/** Trusted host persistence only; never included in a snapshot or public replay. */
export const CollaborationNativeCapacityWitnessSchema = z.strictObject({
  assessment: CollaborationNativeCapacityAssessmentSchema,
  nativeOperationId: z.string().regex(/^collaboration-review:[a-f0-9]{64}$/),
  contextSha256: digest,
  nativeWitness: z.strictObject({ preparationId: id, requestIdentity: digest, witnessId: id }),
});
export type CollaborationNativeCapacityWitness = z.infer<
  typeof CollaborationNativeCapacityWitnessSchema
>;
const capacity = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    assessments: z
      .array(
        z.union([
          CollaborationNativeCapacityAssessmentSchema,
          z
            .strictObject({
              settings: CollaborationSettingsSchema,
              availableTokens: sequence,
              estimatedTokens: sequence,
              estimatorRevision: id,
              components: z
                .strictObject({
                  contextTokens: sequence,
                  adapterTokens: sequence,
                  bootTokens: sequence,
                  toolTokens: sequence,
                  reservedOutputTokens: sequence,
                  contextWindowTokens: sequence,
                })
                .optional(),
            })
            .refine((c) => c.estimatedTokens <= c.availableTokens)
            .refine(
              (c) =>
                !c.components ||
                (c.estimatedTokens ===
                  c.components.contextTokens +
                    c.components.adapterTokens +
                    c.components.bootTokens +
                    c.components.toolTokens &&
                  c.availableTokens ===
                    c.components.contextWindowTokens - c.components.reservedOutputTokens),
              'Capacity accounting mismatch',
            ),
        ]),
      )
      .min(1)
      .max(16)
      .refine((assessments) => {
        const native = assessments.filter(
          (assessment) => 'kind' in assessment && assessment.kind === 'nativePreparedRequest',
        );
        return (
          new Set(
            native.map((assessment) => 'measurementId' in assessment && assessment.measurementId),
          ).size === native.length
        );
      }, 'Duplicate native measurement ID'),
  }),
  z.strictObject({
    status: z.enum(['unverified', 'refused', 'needs_reviewed_summary']),
    reason: z.string().min(1).max(1000),
  }),
]);
/** Built only by a trusted source/access owner. Never parse caller-supplied bytes as source proof.
 * An artifact pin is a reference, not retained bytes or a grant to read those bytes.
 */
export const CollaborationSnapshotDraftSchema = z.strictObject({
  requestId: z.uuid(),
  sourceConversationId: id,
  boundary: z.strictObject({ sequence, messageId: id.nullable() }),
  mode: z.enum(['conversation_so_far', 'selected']),
  purpose: z.string().trim().min(1).max(4000),
  joiningBrief: z.string().max(20_000),
  messages: z.array(CollaborationSnapshotMessageSchema).max(500),
  artifacts: z.array(artifact).max(100),
  capacity,
  // A separately reviewed alternative retains exact original source pins and attribution.
  summary: z
    .strictObject({
      sourceSnapshotId: z.uuid(),
      sourceSha256: digest,
      content: z.string().min(1).max(100_000),
      author: id,
    })
    .nullable(),
});
export const CollaborationSnapshotSchema = CollaborationSnapshotDraftSchema.omit({
  requestId: true,
}).extend({
  version: z.literal(1),
  snapshotId: z.uuid(),
  sha256: digest,
});
export const CollaborationApplicationReviewResultSchema = z.strictObject({
  snapshot: CollaborationSnapshotSchema,
  settings: CollaborationSettingsSchema,
  expectedMembershipRevision: sequence,
  artifactLabels: z
    .array(
      z.strictObject({
        artifactId: id,
        revision: z.number().int().positive().safe(),
        sha256: digest,
        title: z.string().trim().min(1).max(1000),
        filename: z.string().trim().min(1).max(1000).optional(),
      }),
    )
    .max(100)
    .optional(),
});
export type CollaborationApplicationReviewResult = z.infer<
  typeof CollaborationApplicationReviewResultSchema
>;
export const CollaborationJoinInputSchema = z.strictObject({
  ...request,
  name: z.string().trim().min(1).max(100),
  settings: CollaborationSettingsSchema,
  snapshot: CollaborationSnapshotReferenceSchema,
});
/** Explicit membership-only approval of an existing allocation's original frozen review. */
export const CollaborationJoinReconcileInputSchema = z.strictObject({
  ...request,
  snapshot: CollaborationSnapshotReferenceSchema,
});
export const CollaborationAllocationSchema = z.strictObject({
  operationId: z.uuid(),
  sessionId: id,
  settings: CollaborationSettingsSchema,
});
export const CollaborationJoinSchema = z
  .strictObject({
    version: z.literal(1),
    joinId: z.uuid(),
    name: z.string().min(1).max(100),
    membershipRevision: sequence,
    settings: CollaborationSettingsSchema,
    snapshot: CollaborationSnapshotReferenceSchema,
    allocationOperationId: z.uuid(),
    state: z.enum(['pending_preparation', 'allocated', 'linked']),
    sessionId: id.nullable(),
    linkedFromRevision: sequence.nullable(),
    execution: CollaborationExecutionSchema,
  })
  .refine(
    (join) =>
      (join.state === 'pending_preparation') === (join.sessionId === null) &&
      (join.state === 'linked') === (join.linkedFromRevision !== null),
    'Join allocation state mismatch',
  );
export const CollaborationEventSchema = z.strictObject({
  version: z.literal(1),
  collaborationId: SessionCollaborationIdSchema,
  eventId: z.uuid(),
  sequence,
  change: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('membership'),
      membership: SessionCollaborationSchema,
      policies: z.array(CollaborationPolicySchema).max(16),
    }),
    z.strictObject({ kind: z.literal('policy'), policy: CollaborationPolicySchema }),
    z.strictObject({ kind: z.literal('message'), message: CollaborationMessageSchema }),
    z.strictObject({
      kind: z.literal('delivery'),
      messageId: z.uuid(),
      delivery: CollaborationDeliverySchema,
    }),
    z.strictObject({ kind: z.literal('snapshot'), snapshotId: z.uuid() }),
    z.strictObject({ kind: z.literal('join'), join: CollaborationJoinSchema }),
  ]),
});
export const CollaborationEventsSchema = z.strictObject({
  events: z.array(CollaborationEventSchema).max(50),
  cursor: sequence,
  highWatermark: sequence,
  hasMore: z.boolean(),
});
export const CollaborationViewSchema = z.strictObject({
  version: z.literal(1),
  collaborationId: SessionCollaborationIdSchema,
  membershipRevision: sequence,
  participantSessionIds: ids,
  unavailableParticipantSessionIds: ids,
  cursor: sequence,
  policySequence: sequence,
  policies: z.array(CollaborationPolicySchema).max(16),
  messages: z.array(CollaborationMessageSchema).max(50),
  hasEarlierMessages: z.boolean(),
  joins: z.array(CollaborationJoinSchema).max(16),
  execution: CollaborationExecutionSchema,
});
export const CollaborationCursorSchema = z.strictObject({
  after: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1)
    .default(0),
});
export type CollaborationSettings = z.infer<typeof CollaborationSettingsSchema>;
export type CollaborationPolicy = z.infer<typeof CollaborationPolicySchema>;
export type CollaborationMessage = z.infer<typeof CollaborationMessageSchema>;
export type CollaborationDelivery = z.infer<typeof CollaborationDeliverySchema>;
export type CollaborationSnapshot = z.infer<typeof CollaborationSnapshotSchema>;
export type CollaborationJoin = z.infer<typeof CollaborationJoinSchema>;
export type CollaborationEvent = z.infer<typeof CollaborationEventSchema>;
export type CollaborationView = z.infer<typeof CollaborationViewSchema>;
export type CollaborationEvents = z.infer<typeof CollaborationEventsSchema>;
export type CollaborationPolicyUpdate = z.infer<typeof CollaborationPolicyUpdateSchema>;
export type CollaborationMessageInput = z.infer<typeof CollaborationMessageInputSchema>;
export type CollaborationReplyInput = z.infer<typeof CollaborationReplyInputSchema>;
export type CollaborationMessageSource = z.infer<typeof CollaborationMessageSourceSchema>;
export type CollaborationJoinInput = z.infer<typeof CollaborationJoinInputSchema>;
export type CollaborationJoinReconcileInput = z.infer<typeof CollaborationJoinReconcileInputSchema>;
export type CollaborationSnapshotSelection = z.infer<typeof CollaborationSnapshotSelectionSchema>;
export class CollaborationContractError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'conflict'
      | 'request_conflict'
      | 'unknown_recipient'
      | 'unavailable_recipient'
      | 'no_responders'
      | 'snapshot_changed'
      | 'capacity_refused'
      | 'invalid_transition'
      | 'allocation_conflict'
      | 'execution_unavailable'
      | 'reply_conflict'
      | 'reply_unavailable',
  ) {
    super(code);
  }
}
