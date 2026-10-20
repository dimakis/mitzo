import { z } from 'zod';
import {
  AgentProfileSelectionSchema,
  CollaborationApplicationReviewInputSchema,
  CollaborationArtifactPinSchema,
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
import {
  ConversationJoiningTargetIntentSchema,
  type ConversationJoiningTargetIntent,
} from './conversation-joining-target-intent';

const id = z.string().min(1).max(200).regex(/^\S+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const setup = z.strictObject({
  name: z.string().max(100),
  purpose: z.string().max(4000),
  context: z.enum(['conversation_so_far', 'selected']),
  messageIds: z.array(id).max(500),
  artifacts: z.array(CollaborationArtifactPinSchema).max(100),
  runOn: z.enum(['openshell', 'local']),
  selection: z
    .strictObject({
      accountId: id.optional(),
      model: id,
      reasoningEffort: z.string().max(100).nullable().optional(),
    })
    .nullable(),
  agent: AgentProfileSelectionSchema.nullable(),
  sourceRepository: z.string().min(3).max(256).optional(),
  repositoryWorkspaceId:
    CollaborationApplicationReviewInputSchema.shape.target.shape.repositoryWorkspaceId.optional(),
  permissionMode:
    CollaborationApplicationReviewInputSchema.shape.target.shape.permissionMode.optional(),
});
const reviewRequest = z.strictObject({
  requestId: z.uuid(),
  setup,
  joiningBrief: z.string().max(20_000).optional(),
  previousSnapshot: CollaborationSnapshotReferenceSchema.optional(),
  previousSource: CollaborationApplicationReviewInputSchema.shape.selection
    .pick({ boundary: true, expectedMembershipRevision: true })
    .optional(),
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
        // New full-context captures omit selector IDs without clearing the UI.
        // Historical captured wire still requires exact retained-request equality.
        if (
          selection.requestId !== request.requestId ||
          selection.sourceConversationId !== record.sourceConversationId ||
          selection.mode !== setup.context ||
          selection.purpose !== setup.purpose.trim() ||
          (!joiningReviewEqual(selection.messageIds, setup.messageIds) &&
            (setup.context !== 'conversation_so_far' || selection.messageIds.length !== 0)) ||
          !joiningReviewEqual(selection.artifacts, setup.artifacts) ||
          !setup.selection ||
          target.accountId !== setup.selection.accountId ||
          target.model !== setup.selection.model ||
          target.reasoningEffort !== (setup.selection.reasoningEffort ?? null) ||
          target.runOn !== setup.runOn ||
          (setup.repositoryWorkspaceId !== undefined &&
            target.repositoryWorkspaceId !== setup.repositoryWorkspaceId) ||
          (setup.permissionMode !== undefined && target.permissionMode !== setup.permissionMode) ||
          !joiningReviewEqual(target.agent, setup.agent) ||
          (request.joiningBrief !== undefined && selection.joiningBrief !== request.joiningBrief) ||
          !joiningReviewEqual(previousSnapshot, request.previousSnapshot) ||
          (request.previousSource &&
            (!joiningReviewEqual(selection.boundary, request.previousSource.boundary) ||
              selection.expectedMembershipRevision !==
                request.previousSource.expectedMembershipRevision))
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
      (record.reviewRequest.previousSource &&
        (!record.previousReview ||
          record.reviewRequest.previousSource.expectedMembershipRevision !==
            record.previousReview.expectedMembershipRevision)) ||
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
const begin = z.strictObject({
  collaborationId: SessionCollaborationIdSchema,
  requestId: z.uuid(),
});
export type ConversationJoiningBeginRecord = z.infer<typeof begin>;
// The same auth/base/source-bound journal can exist before the user reviews a
// draft. It retains only original begin correlation, never canonical membership.
const bootstrap = z
  .strictObject({
    version: z.literal(3),
    sourceConversationId: id,
    begin: begin.optional(),
    target: ConversationJoiningTargetIntentSchema.optional(),
    review: schema.nullable(),
  })
  .superRefine((value, context) => {
    const group = value.begin?.collaborationId ?? value.target?.collaborationId;
    if (
      !group ||
      (value.begin &&
        value.target &&
        value.begin.collaborationId !== value.target.collaborationId) ||
      (value.review &&
        (value.review.sourceConversationId !== value.sourceConversationId ||
          value.review.version !== 2 ||
          value.review.application.collaborationId !== group))
    )
      context.addIssue({ code: 'custom', message: 'Joining begin and review identity conflict' });
    if (
      value.target &&
      value.review?.version === 2 &&
      value.review.application.state === 'captured'
    ) {
      const selected = value.review.application.input.target;
      if (
        value.target.phase !== 'resolved' ||
        selected.repositoryWorkspaceId !== value.target.preview.requestId ||
        (value.review.reviewRequest.setup.sourceRepository !== undefined &&
          value.review.reviewRequest.setup.sourceRepository !== value.target.preview.repository) ||
        selected.permissionMode !== value.target.draft.settings.mode ||
        selected.accountId !== value.target.preview.accountId ||
        selected.model !== value.target.preview.model ||
        selected.runOn !== value.target.preview.ordinaryRuntime.runOn
      )
        context.addIssue({ code: 'custom', message: 'Captured fresh target identity conflicts' });
    }
  });
const stored = z.union([schema, bootstrap]);
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
  const readStored = () => {
    assertCurrent();
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    if (raw.length > 256 * 1024) throw new Error('Joining recovery size exceeded');
    const record = stored.parse(JSON.parse(raw));
    if (record.sourceConversationId !== sourceConversationId)
      throw new Error('Joining recovery source changed');
    return record;
  };
  const read = (): ConversationJoiningRecoveryRecord | null => {
    const record = readStored();
    return record?.version === 3 ? record.review : record;
  };
  const assertExpected = (expected: ConversationJoiningRecoveryRecord | null) => {
    if (!joiningReviewEqual(read(), expected))
      throw new Error('Joining recovery operation changed');
  };
  return {
    isCurrent,
    read,
    readBegin(): ConversationJoiningBeginRecord | null {
      const record = readStored();
      return record?.version === 3 ? (record.begin ?? null) : null;
    },
    retainBegin(raw: unknown, expected: ConversationJoiningBeginRecord | null) {
      const record = readStored();
      const current = record?.version === 3 ? (record.begin ?? null) : null;
      const parsed = begin.parse(raw);
      if (
        !joiningReviewEqual(current, expected) ||
        (current && !joiningReviewEqual(current, parsed)) ||
        (record && record.version !== 3) ||
        (record?.version === 3 && record.target && !record.begin)
      )
        throw new Error('Original joining setup must be recovered');
      const next = bootstrap.parse({
        version: 3,
        sourceConversationId,
        begin: parsed,
        ...(record?.version === 3 && record.target ? { target: record.target } : {}),
        review: record?.version === 3 ? record.review : null,
      });
      sessionStorage.setItem(key, JSON.stringify(next));
      return parsed;
    },
    readTarget(): ConversationJoiningTargetIntent | null {
      const record = readStored();
      return record?.version === 3 ? (record.target ?? null) : null;
    },
    retainTarget(
      raw: unknown,
      expected: ConversationJoiningTargetIntent | null,
      expectedReview: ConversationJoiningRecoveryRecord,
    ) {
      assertExpected(expectedReview);
      const record = readStored();
      const current = record?.version === 3 ? (record.target ?? null) : null;
      const review = record?.version === 3 ? record.review : record;
      const parsed = ConversationJoiningTargetIntentSchema.parse(raw);
      if (
        !joiningReviewEqual(current, expected) ||
        !review ||
        review.version !== 2 ||
        review.application.state !== 'capture_pending' ||
        review.submission ||
        parsed.collaborationId !== review.application.collaborationId
      )
        throw new Error('Original fresh target must be recovered');
      if (!current) {
        if (
          parsed.phase !== 'preview_pending' ||
          parsed.reviewRequestId !== review.reviewRequest.requestId
        )
          throw new Error('Original fresh target intent unavailable');
      } else {
        const fields = (value: ConversationJoiningTargetIntent) => ({
          ...value,
          phase: 'preview_pending',
        });
        const phases = ['preview_pending', 'previewed', 'prepare_pending', 'resolved'];
        const same = joiningReviewEqual(fields(current), fields(parsed));
        if (
          same
            ? phases.indexOf(parsed.phase) < phases.indexOf(current.phase)
            : current.phase !== 'resolved' ||
              parsed.phase !== 'preview_pending' ||
              parsed.preview.requestId === current.preview.requestId ||
              parsed.draft.id === current.draft.id ||
              parsed.reviewRequestId !== review.reviewRequest.requestId
        )
          throw new Error('Original fresh target intent must be recovered');
      }
      const next = bootstrap.parse({
        version: 3,
        sourceConversationId,
        ...(record?.version === 3 && record.begin ? { begin: record.begin } : {}),
        target: parsed,
        review,
      });
      const encoded = JSON.stringify(next);
      if (encoded.length > 256 * 1024) throw new Error('Joining recovery size exceeded');
      sessionStorage.setItem(key, encoded);
      return parsed;
    },
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
      const previous = readStored();
      if (
        previous?.version === 3 &&
        previous.target &&
        previous.target.phase !== 'resolved' &&
        previous.review &&
        previous.review.reviewRequest.requestId !== record.reviewRequest.requestId
      )
        throw new Error('The original fresh target must be checked before changing this review');
      const encoded = JSON.stringify(
        previous?.version === 3 ? bootstrap.parse({ ...previous, review: record }) : record,
      );
      if (encoded.length > 256 * 1024) throw new Error('Joining recovery size exceeded');
      sessionStorage.setItem(key, encoded);
      return record;
    },
    clear(expected: ConversationJoiningRecoveryRecord) {
      assertExpected(expected);
      if (expected.join?.state !== 'linked') throw new Error('Joining is not linked');
      const previous = readStored();
      if (previous?.version === 3 && previous.begin)
        sessionStorage.setItem(
          key,
          JSON.stringify({ version: 3, sourceConversationId, begin: previous.begin, review: null }),
        );
      else sessionStorage.removeItem(key);
    },
  };
}
