import type { MitzoApiClient } from '@mitzo/client';
import {
  CollaborationApplicationReviewInputSchema,
  CollaborationApplicationReviewRequestSchema,
  CollaborationJoinInputSchema,
  CollaborationSnapshotReferenceSchema,
  SessionCollaborationIdSchema,
} from '@mitzo/protocol';
import { getApiBaseUrl } from './api-fetch';
import type { ApplicationConversationJoiningOwner } from './conversation-joining-review';

const selectionIntent = CollaborationApplicationReviewInputSchema.shape.selection.omit({
  boundary: true,
  expectedMembershipRevision: true,
});
const unavailable = () => new Error('Application review owner unavailable');

/** An observational adapter for an explicitly selected existing association.
 * Public target selectors confer no preparation, capacity or execution authority.
 * The caller supplies the real typed client and existing verified-login getter;
 * there is no workspace preparation, association creation or runtime installation.
 */
export function createConversationJoiningApplicationOwner(options: {
  api: MitzoApiClient;
  sourceConversationId: string;
  collaborationId: string;
  getClientId(): string | undefined;
  getVerifiedAuthScope(): string | undefined;
}): ApplicationConversationJoiningOwner {
  const { api, getClientId, getVerifiedAuthScope } = options;
  const sourceConversationId = selectionIntent.shape.sourceConversationId.parse(
    options.sourceConversationId,
  );
  const collaborationId = SessionCollaborationIdSchema.parse(options.collaborationId);
  const authScope = getVerifiedAuthScope();
  if (!authScope) throw unavailable();
  const base = getApiBaseUrl();
  const assertCurrent = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (getVerifiedAuthScope() !== authScope || getApiBaseUrl() !== base) throw unavailable();
  };
  return {
    kind: 'application',
    sourceConversationId,
    collaborationId,
    async captureReview(request, signal) {
      assertCurrent(signal);
      if (typeof request.joiningBrief !== 'string') throw unavailable();
      const { setup } = request;
      if (!setup.agent) throw unavailable();
      // Parse independent public intent before either read. In particular, the
      // source's workspace/mode and catalog defaults never fill missing fields.
      const target = CollaborationApplicationReviewInputSchema.shape.target.parse({
        runOn: setup.runOn,
        accountId: setup.selection?.accountId,
        model: setup.selection?.model,
        reasoningEffort: setup.selection?.reasoningEffort ?? null,
        agent: setup.agent,
        repositoryWorkspaceId: setup.repositoryWorkspaceId,
        permissionMode: setup.permissionMode,
      });
      const selection = selectionIntent.parse({
        requestId: request.requestId,
        sourceConversationId,
        mode: setup.context,
        messageIds: setup.messageIds,
        artifacts: setup.artifacts,
        purpose: setup.purpose,
        joiningBrief: request.joiningBrief,
      });
      const previousSnapshot =
        request.previousSnapshot === undefined
          ? undefined
          : CollaborationSnapshotReferenceSchema.parse(request.previousSnapshot);
      const previousSource =
        request.previousSource === undefined
          ? undefined
          : CollaborationApplicationReviewInputSchema.shape.selection
              .pick({ boundary: true, expectedMembershipRevision: true })
              .parse(request.previousSource);
      if (previousSource && !previousSnapshot) throw unavailable();
      const [source, view] = await Promise.all([
        api.getDurableSessionTranscript(sourceConversationId, signal),
        api.collaborations.view(collaborationId, signal),
      ]);
      assertCurrent(signal);
      const boundary = previousSource?.boundary ?? source.boundary;
      const membershipRevision =
        previousSource?.expectedMembershipRevision ?? view.membershipRevision;
      // The boundary is an event cursor; trailing metadata need not introduce a
      // visible message. Its anchor must still be the last message in that prefix.
      const prefix = source.messages.filter((message) => message.sequence <= boundary.sequence);
      const messageIds = new Set(prefix.map((message) => message.messageId));
      if (
        source.sourceConversationId !== sourceConversationId ||
        view.collaborationId !== collaborationId ||
        !view.participantSessionIds.includes(sourceConversationId) ||
        view.unavailableParticipantSessionIds.includes(sourceConversationId) ||
        view.membershipRevision !== membershipRevision ||
        boundary.sequence > source.boundary.sequence ||
        (boundary.messageId === null
          ? boundary.sequence !== 0
          : prefix.at(-1)?.messageId !== boundary.messageId) ||
        new Set(selection.messageIds).size !== selection.messageIds.length ||
        selection.messageIds.some((id) => !messageIds.has(id))
      )
        throw unavailable();
      return CollaborationApplicationReviewInputSchema.parse({
        selection: {
          ...selection,
          boundary,
          expectedMembershipRevision: membershipRevision,
        },
        target,
        ...(previousSnapshot === undefined ? {} : { previousSnapshot }),
      });
    },
    async review(input, signal) {
      assertCurrent(signal);
      const captured = CollaborationApplicationReviewInputSchema.parse(input);
      if (captured.selection.sourceConversationId !== sourceConversationId) throw unavailable();
      const clientId =
        CollaborationApplicationReviewRequestSchema.shape.clientId.parse(getClientId());
      const result = await api.collaborations.review(collaborationId, clientId, captured, signal);
      // This is a post-response drift check, not atomic revocation/dispatch ordering.
      assertCurrent(signal);
      return result;
    },
    async confirm(input) {
      assertCurrent();
      const result = await api.collaborations.prepareJoin(
        collaborationId,
        CollaborationJoinInputSchema.parse(input),
      );
      assertCurrent();
      return result;
    },
    async recover(joinId, signal) {
      assertCurrent(signal);
      const result = await api.collaborations.recoverJoin(collaborationId, joinId, signal);
      assertCurrent(signal);
      return result;
    },
  };
}
