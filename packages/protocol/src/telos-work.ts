import { z } from 'zod';
import { SessionRuntimeBindingSchema } from './session-runtime-binding.js';
import { OrdinaryLocalCommandSelectionSchema } from './ordinary-local-admission.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
const revision = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Original timestamps are preserved verbatim (including legacy offset/naive ISO dates).
// Null means unknown; neither migration nor schema parsing supplies today's date.
const recordedDate = z.string().min(1).nullable();

export const TelosOrdinaryConversationReferenceSchema = z.strictObject({
  namespace: z.literal('mitzo'),
  conversationId: id,
});
export const TelosSourceConversationReferenceSchema = z.discriminatedUnion('namespace', [
  TelosOrdinaryConversationReferenceSchema,
  z.strictObject({
    namespace: z.literal('external_codex'),
    conversationId: id,
    url: z.string().startsWith('codex://threads/'),
  }),
]);

/** A projection of the existing Telos record, not a replacement composition store.
 * Legacy kind is null until explicitly classified; profile is the source profile.
 * Preserve unmapped fields for repeatable lossless transfer. S2 owns graph/authority
 * validation; parsing a record cannot assign a role, authorize or dispatch work.
 */
export const TelosWorkItemSchema = z.strictObject({
  version: z.literal(1),
  itemId: id,
  kind: z.enum(['coordinator', 'outcome', 'work_item']).nullable(),
  parentId: id.nullable(),
  summary: z.string(),
  intent: z.string(),
  rationale: z.string(),
  acceptanceCriteria: z.array(z.string()),
  profile: z.string(),
  status: z.enum(['active', 'acknowledged', 'snoozed', 'completed']),
  starred: z.boolean(),
  categories: z.array(z.string()),
  createdAt: recordedDate,
  updatedAt: recordedDate,
  contextHints: z.strictObject({
    repos: z.array(z.string()),
    paths: z.array(z.string()),
    issues: z.array(z.string()),
    docIds: z.array(z.string()),
    people: z.array(z.string()),
    jiraKeys: z.array(z.string()),
    keywords: z.array(z.string()),
    taskHint: z.string(),
    sessionIds: z.array(z.string()),
  }),
  sources: z.array(
    z.strictObject({
      type: z.string(),
      url: z.string(),
      title: z.string(),
      author: z.string().nullable(),
      rawSnippet: z.string(),
      createdAt: recordedDate,
      addedAt: recordedDate,
      updatedAt: recordedDate,
    }),
  ),
  links: z.array(
    z.strictObject({
      type: z.string(),
      url: z.string(),
      title: z.string(),
      description: z.string(),
      addedAt: recordedDate,
    }),
  ),
  legacyFields: z.record(z.string(), z.unknown()),
});

const link = {
  version: z.literal(1),
  linkId: id,
  itemId: id,
  linkedAt: recordedDate,
  linkedBy: z.string().nullable(),
  availability: z.enum(['available', 'unavailable', 'unknown']),
  attemptId: id.nullable(),
};
/** Role history and current assignment are separate facts. External origins are
 * never ordinary Mitzo allocations, even when their source IDs look like sessions.
 */
export const TelosWorkSessionLinkSchema = z.discriminatedUnion('role', [
  z.strictObject({
    ...link,
    role: z.literal('origin'),
    conversation: TelosSourceConversationReferenceSchema,
  }),
  z.strictObject({
    ...link,
    role: z.enum(['lead', 'advisor', 'worker', 'reviewer']),
    conversation: TelosOrdinaryConversationReferenceSchema,
  }),
]);
export const TelosWorkAssignmentSchema = z.strictObject({
  itemId: id,
  role: z.enum(['lead', 'worker']),
  conversation: TelosOrdinaryConversationReferenceSchema,
  revision,
  assignedAt: recordedDate,
  assignedBy: z.string().nullable(),
});

export const TelosWorkArtifactReferenceSchema = z.strictObject({
  artifactId: z.string().regex(/^[a-f0-9]{32}$/),
  revision: z.number().int().positive().safe(),
  sha256: digest,
});
/** An immutable adopted source reference, never a dynamically read latest chat.
 * The source/artifact owners retain bytes and validate authorized selections.
 */
export const TelosWorkSourceSnapshotSchema = z.strictObject({
  version: z.literal(1),
  snapshotId: id,
  itemId: id,
  source: TelosSourceConversationReferenceSchema.nullable(),
  selection: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('selected'),
      messageIds: z.array(id).min(1),
      blockIds: z.array(id),
      throughSequence: revision,
    }),
    z.strictObject({ kind: z.literal('unknown') }),
  ]),
  adoptedBrief: z.strictObject({ revision: id, sha256: digest }).nullable(),
  artifacts: z.array(TelosWorkArtifactReferenceSchema),
  author: z.string().nullable(),
  sourceCreatedAt: recordedDate,
  adoptedAt: recordedDate,
});

/** References to ordinary settings owned by the existing session/runtime stores.
 * These are selection metadata, not admission or an alternative runtime catalog.
 */
export const TelosWorkConversationSchema = z.strictObject({
  conversation: TelosOrdinaryConversationReferenceSchema,
  binding: SessionRuntimeBindingSchema,
  selection: OrdinaryLocalCommandSelectionSchema,
  workspaceId: id,
  providerContinuationId: id.nullable(),
  clientId: id.nullable(),
  draft: z.string(),
  historyMessageIds: z.array(id),
});

/** Work-level request/allocation receipt only. Actual execution and completion
 * remain in SessionService, the ordinary command queue and execution ledger.
 * S2/S5 own durable idempotency, authority and recovery, not this wire schema.
 */
export const TelosWorkAttemptSchema = z
  .strictObject({
    version: z.literal(1),
    requestId: id,
    attemptId: id,
    predecessorAttemptId: id.nullable(),
    leadConversationId: id,
    childItemId: id,
    contextSnapshotId: id,
    state: z.enum(['requested', 'allocation_uncertain', 'chat_ready', 'admission_failed']),
    workerConversationId: id.nullable(),
    allocationReceiptId: id.nullable(),
    executionTaskId: id.nullable(),
    accountingGoalId: id.nullable(),
    turnCommandId: id.nullable(),
  })
  .refine(
    (attempt) =>
      attempt.state !== 'chat_ready' ||
      (attempt.workerConversationId !== null && attempt.allocationReceiptId !== null),
    'Chat readiness requires an ordinary allocation receipt and conversation',
  );

/** Per-recipient evidence. A hold is neither an abort nor a global paused flag.
 * S6 integrates existing coordination authority/delivery; this shape grants none.
 */
export const TelosWorkControlReceiptSchema = z.strictObject({
  version: z.literal(1),
  controlId: id,
  coordinatorItemId: id,
  coordinatorConversationId: id,
  targetOutcomeId: id,
  targetLeadConversationId: id,
  scope: z.enum(['publication', 'new_worker_dispatch', 'safe_point']),
  stage: z.enum(['requested', 'acknowledged', 'applied', 'released']),
  evidenceRef: id,
  workerEvidenceRefs: z.array(id),
  publicationRevalidation: z.enum(['not_applicable', 'required']),
});

export type TelosWorkItem = z.infer<typeof TelosWorkItemSchema>;
export type TelosWorkSessionLink = z.infer<typeof TelosWorkSessionLinkSchema>;
export type TelosWorkAssignment = z.infer<typeof TelosWorkAssignmentSchema>;
export type TelosWorkSourceSnapshot = z.infer<typeof TelosWorkSourceSnapshotSchema>;
export type TelosWorkConversation = z.infer<typeof TelosWorkConversationSchema>;
export type TelosWorkAttempt = z.infer<typeof TelosWorkAttemptSchema>;
export type TelosWorkControlReceipt = z.infer<typeof TelosWorkControlReceiptSchema>;
