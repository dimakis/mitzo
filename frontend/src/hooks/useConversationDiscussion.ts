import { useMemo, useCallback } from 'react';
import { MitzoApiClient } from '@mitzo/client';
import { apiFetch, currentVerifiedAuthSessionId } from '../lib/api-fetch';
import { conversationResponders } from '../lib/conversation-presentation';
import type { ConversationAgent } from '../components/ConversationAgents';
import type { useConversationJoiningApplication } from './useConversationJoiningApplication';
import { useConversationPresentation } from './useConversationPresentation';

const api = new MitzoApiClient(apiFetch);

/** Read/policy/recipient composition only. The ordinary source transcript is
 * preserved until its canonical presentation cutover contract exists. */
export function useConversationDiscussion(options: {
  joining: ReturnType<typeof useConversationJoiningApplication>;
  source: ConversationAgent | null;
  draftId?: string;
}) {
  const { joining, source, draftId } = options;
  const membership = joining.membership;
  const requested =
    !!source &&
    !!membership &&
    membership.participantSessionIds.includes(source.id) &&
    membership.participantSessionIds.length > 1;
  const sourceId = source?.id,
    sourceName = source?.name;
  const names = useMemo(
    () => (sourceId && sourceName ? { [sourceId]: sourceName } : {}),
    [sourceId, sourceName],
  );
  const presentation = useConversationPresentation({
    api: api.collaborations,
    collaborationId: requested ? membership.collaborationId : null,
    authScope: joining.authScope,
    getVerifiedAuthScope: currentVerifiedAuthSessionId,
    isCurrent: joining.isCurrent,
    draftId: requested ? draftId : undefined,
    names,
  });
  const view = presentation.projection?.view;
  const matched =
    requested &&
    !!view &&
    view.collaborationId === membership.collaborationId &&
    view.membershipRevision >= membership.revision &&
    view.participantSessionIds.includes(source.id);
  const agents: ConversationAgent[] | undefined = requested
    ? (matched ? view.participantSessionIds : membership.participantSessionIds).map((id) => {
        const policy = matched ? view.policies.find((value) => value.sessionId === id) : undefined;
        const unavailable = matched && view.unavailableParticipantSessionIds.includes(id);
        return {
          ...(id === source.id ? source : { id, name: `Agent · ${id}` }),
          state: unavailable
            ? 'Session unavailable'
            : matched
              ? 'Shared discussion'
              : 'Discussion sharing not checked',
          ...(policy && !unavailable
            ? { policy: { reads: policy.readsFutureDiscussion, replies: policy.repliesByDefault } }
            : {}),
        };
      })
    : undefined;
  // Legacy text-only drafts retain their existing owner. Show actual Defaults
  // without pretending an unbound rich draft exists or silently migrating text.
  const { isCurrent: readIsCurrent, loading, error, draft } = presentation;
  const scopeIsCurrent = joining.isCurrent;
  const canChooseRecipients = useCallback(
    () =>
      matched && readIsCurrent() && scopeIsCurrent() && !loading && !error && (!draftId || !!draft),
    [matched, readIsCurrent, scopeIsCurrent, loading, error, draftId, draft],
  );
  const responderState = matched
    ? (presentation.composerResponders ?? {
        ...conversationResponders(view, { kind: 'default' }, names),
        disabled: !canChooseRecipients(),
        onChange: () => false,
      })
    : undefined;
  const responders = responderState
    ? { ...responderState, disabled: responderState.disabled || !canChooseRecipients() }
    : undefined;
  return {
    requested,
    canChooseRecipients,
    collaborationId: requested ? membership.collaborationId : undefined,
    presentation,
    agents,
    responders,
    policyDisabled: !matched || presentation.policyDisabled,
    unavailableReason: !requested
      ? undefined
      : !matched
        ? (presentation.error ??
          'Check this shared conversation before changing discussion sharing.')
        : (presentation.policyError ??
          (presentation.policyDisabled
            ? 'Check discussion sharing before changing it.'
            : undefined)),
    recipientReason:
      requested && !draftId && !presentation.draft
        ? undefined
        : (presentation.draftError ?? presentation.recipientError ?? undefined),
  };
}
