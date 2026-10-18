import { z } from 'zod';
import {
  AgentProfileSelectionSchema,
  CollaborationApplicationReviewInputSchema,
  SessionCollaborationIdSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinSchema,
  CollaborationSettingsSchema,
  CollaborationSnapshotReferenceSchema,
} from '@mitzo/protocol';
import {
  CONVERSATION_JOINING_RECOVERY_PREFIX,
  currentVerifiedAuthSessionId,
  getApiBaseUrl,
} from './api-fetch';
import { sha256Hex } from './browser-crypto';
import type { ConversationJoiningReviewResult } from './conversation-joining-review';

const id = z.string().min(1).max(200).regex(/^\S+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const setup = z.strictObject({
  name: z.string().max(100),
  purpose: z.string().max(4000),
  context: z.enum(['conversation_so_far', 'selected']),
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
  runOn: z.enum(['openshell', 'local']),
  selection: z
    .strictObject({
      accountId: id.optional(),
      model: id,
      reasoningEffort: z.string().max(100).nullable().optional(),
    })
    .nullable(),
  agent: AgentProfileSelectionSchema.nullable(),
});
const reviewRequest = z.strictObject({
  requestId: z.uuid(),
  setup,
  joiningBrief: z.string().max(20_000).optional(),
  previousSnapshot: CollaborationSnapshotReferenceSchema.optional(),
});
const fence = z.strictObject({
  sourceSha256: digest,
  settings: CollaborationSettingsSchema,
  expectedMembershipRevision: z.number().int().nonnegative().safe(),
  snapshot: CollaborationSnapshotReferenceSchema,
  joiningBrief: z.string().max(20_000),
});
export type ConversationJoiningReviewFence = z.infer<typeof fence>;
const fields = {
  sourceConversationId: id,
  reviewRequest,
  previousReview: fence.optional(),
  acceptedReview: fence.optional(),
  submission: CollaborationJoinInputSchema.optional(),
  join: CollaborationJoinSchema.optional(),
};
const application = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('capture_pending'),
    collaborationId: SessionCollaborationIdSchema,
  }),
  z.strictObject({
    state: z.literal('captured'),
    collaborationId: SessionCollaborationIdSchema,
    input: CollaborationApplicationReviewInputSchema,
  }),
]);
const schema = z
  .discriminatedUnion('version', [
    z.strictObject({ version: z.literal(1), ...fields }),
    z.strictObject({ version: z.literal(2), ...fields, application }),
  ])
  .superRefine((record, context) => {
    const input = record.submission;
    const accepted = record.acceptedReview;
    const join = record.join;
    if (record.version === 2) {
      const captured = record.application;
      if (captured.state === 'capture_pending') {
        if (record.acceptedReview || input || join)
          context.addIssue({ code: 'custom', message: 'Application review was never captured' });
      } else {
        const { selection, target, previousSnapshot } = captured.input;
        const request = record.reviewRequest;
        const setup = request.setup;
        if (
          selection.requestId !== request.requestId ||
          selection.sourceConversationId !== record.sourceConversationId ||
          selection.mode !== setup.context ||
          selection.purpose !== setup.purpose.trim() ||
          !joiningReviewEqual(selection.messageIds, setup.messageIds) ||
          !joiningReviewEqual(selection.artifacts, setup.artifacts) ||
          !setup.selection ||
          target.accountId !== setup.selection.accountId ||
          target.model !== setup.selection.model ||
          target.reasoningEffort !== (setup.selection.reasoningEffort ?? null) ||
          target.runOn !== setup.runOn ||
          !joiningReviewEqual(target.agent, setup.agent) ||
          (request.joiningBrief !== undefined && selection.joiningBrief !== request.joiningBrief) ||
          !joiningReviewEqual(previousSnapshot, request.previousSnapshot)
        )
          context.addIssue({
            code: 'custom',
            message: 'Captured application review identity conflicts',
          });
      }
    }
    if (
      (record.reviewRequest.previousSnapshot !== undefined) !==
        (record.previousReview !== undefined) ||
      (record.previousReview &&
        !joiningReviewEqual(
          record.previousReview.snapshot,
          record.reviewRequest.previousSnapshot,
        )) ||
      (input &&
        (!accepted ||
          input.name !== record.reviewRequest.setup.name.trim() ||
          input.expectedMembershipRevision !== accepted.expectedMembershipRevision ||
          !joiningReviewEqual(input.settings, accepted.settings) ||
          !joiningReviewEqual(input.snapshot, accepted.snapshot))) ||
      (join &&
        (!input ||
          join.name !== input.name ||
          join.membershipRevision !== input.expectedMembershipRevision ||
          !joiningReviewEqual(join.settings, input.settings) ||
          !joiningReviewEqual(join.snapshot, input.snapshot)))
    )
      context.addIssue({ code: 'custom', message: 'Joining recovery identity conflicts' });
  });
export type ConversationJoiningRecoveryRecord = z.infer<typeof schema>;
const canonical = (input: unknown) =>
  JSON.stringify(input, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
export const joiningReviewEqual = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Retain source identity without copying messages, artifact bytes or native witnesses. */
export function joiningReviewFence(
  review: ConversationJoiningReviewResult,
): ConversationJoiningReviewFence {
  const { sourceConversationId, boundary, mode, purpose, messages, artifacts, summary } =
    review.snapshot;
  return fence.parse({
    sourceSha256: sha256Hex(
      canonical({ sourceConversationId, boundary, mode, purpose, messages, artifacts, summary }),
    ),
    settings: review.settings,
    expectedMembershipRevision: review.expectedMembershipRevision,
    snapshot: { snapshotId: review.snapshot.snapshotId, sha256: review.snapshot.sha256 },
    joiningBrief: review.snapshot.joiningBrief,
  });
}

/** A tab's retry journal only. Every replay still crosses the authenticated owner.
 * No capacity status, source bytes, native request handles or execution grants persist.
 */
export function conversationJoiningRecovery(sourceConversationId: string) {
  const authSessionId = currentVerifiedAuthSessionId();
  if (!authSessionId) throw new Error('Verified joining recovery identity unavailable');
  id.parse(sourceConversationId);
  const base = getApiBaseUrl();
  const key =
    CONVERSATION_JOINING_RECOVERY_PREFIX +
    [base, authSessionId, sourceConversationId].map(encodeURIComponent).join(':');
  const isCurrent = () => {
    try {
      return currentVerifiedAuthSessionId() === authSessionId && getApiBaseUrl() === base;
    } catch {
      return false;
    }
  };
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Joining recovery login changed');
  };
  const read = (): ConversationJoiningRecoveryRecord | null => {
    assertCurrent();
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    if (raw.length > 256 * 1024) throw new Error('Joining recovery size exceeded');
    const record = schema.parse(JSON.parse(raw));
    if (record.sourceConversationId !== sourceConversationId)
      throw new Error('Joining recovery source changed');
    return record;
  };
  const assertExpected = (expected: ConversationJoiningRecoveryRecord | null) => {
    if (!joiningReviewEqual(read(), expected))
      throw new Error('Joining recovery operation changed');
  };
  return {
    isCurrent,
    read,
    save(raw: unknown, expected: ConversationJoiningRecoveryRecord | null) {
      assertExpected(expected);
      const record = schema.parse(raw);
      if (
        record.sourceConversationId !== sourceConversationId ||
        (expected?.submission && !joiningReviewEqual(record.submission, expected.submission))
      )
        throw new Error('Original joining operation must be recovered');
      if (expected?.reviewRequest.requestId === record.reviewRequest.requestId) {
        if (
          expected.version === 2 &&
          expected.acceptedReview &&
          !joiningReviewEqual(expected.acceptedReview, record.acceptedReview)
        )
          throw new Error('Original application review receipt must be recovered');
        if (
          expected.version !== record.version ||
          !joiningReviewEqual(expected.reviewRequest, record.reviewRequest) ||
          !joiningReviewEqual(expected.previousReview, record.previousReview) ||
          (expected.version === 2 &&
            (record.version !== 2 ||
              expected.application.collaborationId !== record.application.collaborationId ||
              (expected.application.state === 'captured' &&
                !joiningReviewEqual(expected.application, record.application))))
        )
          throw new Error('Original application review must be recovered');
      }
      const encoded = JSON.stringify(record);
      if (encoded.length > 256 * 1024) throw new Error('Joining recovery size exceeded');
      sessionStorage.setItem(key, encoded);
      return record;
    },
    clear(expected: ConversationJoiningRecoveryRecord) {
      assertExpected(expected);
      if (expected.join?.state !== 'linked') throw new Error('Joining is not linked');
      sessionStorage.removeItem(key);
    },
  };
}
