import { expect } from 'vitest';
import { COLLABORATION_EXECUTION_DISABLED, createOrdinaryFreshPermission } from '@mitzo/protocol';
import { joiningTargetHarness } from './conversation-joining-target-harness';
import { joiningReviewFixture } from '../preview/conversation-joining-fixture';
import { sha256Hex } from '../lib/browser-crypto';

/** Strict recording HTTP only. Actual adapters, no real cookie/transport/EventStore,
 * provider, native capacity, inference, live account or filesystem qualification. */
export function joiningApplicationHarness(
  initialGroup: string | null = null,
  members = ['source-chat'],
) {
  const h = joiningTargetHarness('local', { retainReview: false });
  let group = initialGroup;
  let beginWait: Promise<Response> | undefined;
  let failBegin = false;
  const snapshot = joiningReviewFixture().snapshot;
  const membership = () => ({
    version: 1,
    collaborationId: group,
    revision: members.length,
    participantSessionIds: members,
  });
  h.extra((path, init) => {
    if (path === '/api/session-collaborations/source-setup')
      return Response.json(
        group
          ? { state: 'selected', sourceConversationId: 'source-chat', collaboration: membership() }
          : { state: 'unstarted', sourceConversationId: 'source-chat' },
      );
    if (path === '/api/session-collaborations/source-catalog')
      return Response.json({
        sourceConversationId: 'source-chat',
        boundary: snapshot.boundary,
        messages: snapshot.messages,
        artifacts: [],
        artifactCursor: null,
        artifactHasMore: false,
        retainedAvailability: 'available',
        unversionedRetainedReferences: false,
        sourceRepository: { repository: 'dimakis/mitzo' },
      });
    const begin = path.match(/^\/api\/session-collaborations\/([^/]+)\/begin$/);
    if (begin) {
      const body = JSON.parse(init!.body as string);
      expect(h.journal.readBegin()).toEqual({
        collaborationId: begin[1],
        requestId: body.requestId,
      });
      group = begin[1];
      if (failBegin) {
        failBegin = false;
        throw Error('Committed begin response lost');
      }
      return beginWait ?? Response.json(membership());
    }
    if (path === '/api/sessions/source-chat/messages')
      return Response.json({
        sourceConversationId: 'source-chat',
        boundary: snapshot.boundary,
        messages: snapshot.messages,
      });
    if (path.endsWith('/conversation'))
      return Response.json({
        version: 1,
        collaborationId: group,
        membershipRevision: members.length,
        participantSessionIds: members,
        unavailableParticipantSessionIds: [],
        cursor: 0,
        policySequence: 0,
        policies: [],
        messages: [],
        hasEarlierMessages: false,
        joins: [],
        execution: COLLABORATION_EXECUTION_DISABLED,
      });
    if (!path.endsWith('/reviews')) return undefined;
    const { clientId, ...input } = JSON.parse(init!.body as string);
    expect(clientId).toBeTruthy();
    const retained = h.journal.read();
    if (retained?.version !== 2 || retained.application.state !== 'captured')
      throw Error('Review not retained');
    expect(input).toEqual(retained.application.input);
    const result = joiningReviewFixture({
      snapshotId: input.selection.requestId,
      sha256: sha256Hex(input.selection.joiningBrief),
      boundary: input.selection.boundary,
      mode: input.selection.mode,
      messages:
        input.selection.mode === 'selected'
          ? snapshot.messages.filter((m) => input.selection.messageIds.includes(m.messageId))
          : snapshot.messages,
      artifacts: [],
      purpose: input.selection.purpose,
      joiningBrief: input.selection.joiningBrief,
      capacity: { status: 'unverified', reason: 'Native capacity remains unavailable' },
    });
    result.expectedMembershipRevision = members.length;
    result.artifactLabels = [];
    result.settings = {
      binding: h.runtime,
      repositoryWorkspaceId: input.target.repositoryWorkspaceId,
      selection: {
        version: 1,
        agent: input.target.agent,
        context: { source: 'none', revision: null },
        permission: createOrdinaryFreshPermission(input.target.permissionMode),
        model: input.target.model,
        thinking: input.target.reasoningEffort,
      },
    };
    return Response.json(result);
  });
  return {
    ...h,
    group: () => group,
    beginWait: (value: Promise<Response>) => {
      beginWait = value;
    },
    loseBegin: () => {
      failBegin = true;
    },
  };
}
