import { useEffect, useMemo, useRef, useState } from 'react';
import type { MitzoApiClient } from '@mitzo/client';
import {
  CollaborationForwardPrepareInputSchema,
  CollaborationPromptReviewInputSchema,
  type CollaborationForwardRead,
  type CollaborationPromptReviewResult,
  type CollaborationView,
} from '@mitzo/protocol';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';
import { getChatDraft, saveChatDraft, type ChatDraft } from '../lib/chat-drafts';

type Journal = NonNullable<ChatDraft['collaborationForward']>;

/** Context-only forwarding reuses the inspected snapshot selectors. Neither
 * preparation, confirmation nor recovery requests an ordinary model turn. */
export function useConversationForwarding(options: {
  api: MitzoApiClient;
  clientId?: string;
  draftId?: string;
  authScope?: string;
  getVerifiedAuthScope(): string | undefined;
  view?: CollaborationView;
  review?: CollaborationPromptReviewResult;
  reviewCurrent: boolean;
  refresh(): Promise<unknown> | void;
}) {
  const { api, clientId, draftId, authScope, getVerifiedAuthScope, view, review, refresh } =
    options;
  const group = view?.collaborationId;
  const owner = useMemo(
    () => ({ api, clientId, draftId, authScope, group }),
    [api, clientId, draftId, authScope, group],
  );
  const current = useRef(owner);
  current.current = owner;
  const blocked = useRef(false);
  const operation = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<{
    owner: object;
    journal?: Journal;
    observation?: CollaborationForwardRead;
    originalReview?: CollaborationPromptReviewResult;
    busy?: boolean;
    error?: string;
  }>({ owner });
  const valid = () =>
    current.current === owner &&
    !blocked.current &&
    !!authScope &&
    getVerifiedAuthScope() === authScope;
  const publish = (patch: Partial<typeof state>) => {
    if (valid()) setState((s) => ({ ...(s.owner === owner ? s : { owner }), ...patch, owner }));
  };
  useEffect(() => {
    let epoch = 0;
    blocked.current = false;
    const restore = () => {
      if (current.current !== owner || !authScope || getVerifiedAuthScope() !== authScope) return;
      blocked.current = false;
      setState({
        owner,
        journal: draftId ? getChatDraft(draftId)?.collaborationForward : undefined,
      });
    };
    const lost = () => {
      epoch++;
      blocked.current = true;
      operation.current?.abort();
      operation.current = undefined;
      setState({ owner });
    };
    const restored = () => {
      const generation = epoch;
      queueMicrotask(() => {
        if (generation === epoch) restore();
      });
    };
    restore();
    window.addEventListener(AUTH_LOST_EVENT, lost);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    return () => {
      epoch++;
      operation.current?.abort();
      operation.current = undefined;
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
    };
  }, [owner, authScope, draftId, getVerifiedAuthScope]);
  const visible = state.owner === owner && valid() ? state : { owner };
  const journal = visible.journal;
  const scoped = !!journal && journal.authScope === authScope && journal.collaborationId === group;
  const persist = (next?: Journal) => {
    const draft = draftId ? getChatDraft(draftId) : undefined;
    if (!valid() || !draft || !saveChatDraft({ ...draft, collaborationForward: next }))
      throw Error('Could not retain forwarding recovery. No new request was sent.');
    publish({ journal: next });
  };
  const perform = (action: (signal: AbortSignal, fresh: () => boolean) => Promise<void>) => {
    if (!valid() || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const fresh = () => valid() && operation.current === controller && !controller.signal.aborted;
    publish({ busy: true, error: undefined });
    void action(controller.signal, fresh)
      .catch((cause: unknown) => {
        if (fresh())
          publish({
            error:
              cause instanceof Error
                ? cause.message
                : 'Forwarding is unavailable. Check the original request.',
          });
      })
      .finally(() => {
        if (operation.current === controller) {
          operation.current = undefined;
          publish({ busy: false });
        }
      });
  };
  const observe = (record: Journal, result: CollaborationForwardRead) => {
    if (
      result.requestId !== record.input.selection.requestId ||
      JSON.stringify(result.selection) !== JSON.stringify(record.input.selection) ||
      result.note !== record.input.note ||
      (record.confirmation &&
        (result.forwardId !== record.confirmation.forward.forwardId ||
          result.packetSha256 !== record.confirmation.forward.packetSha256 ||
          result.selectionFingerprint !== record.confirmation.forward.selectionFingerprint)) ||
      (result.confirmation && result.confirmation.requestId !== record.confirmation?.requestId)
    )
      throw Error('The forwarding receipt does not match the original request.');
    let next = record;
    if (result.state === 'prepared' && result.packetSha256 && !record.confirmation) {
      next = {
        ...record,
        confirmation: {
          requestId: createBrowserId(),
          expectedMembershipRevision: record.input.selection.target.expectedMembershipRevision,
          forward: {
            forwardId: result.forwardId,
            packetSha256: result.packetSha256,
            selectionFingerprint: result.selectionFingerprint,
          },
          requestReply: false,
        },
      };
      persist(next);
    }
    publish({ observation: result });
    return next;
  };
  const prepare = () =>
    perform(async (signal, fresh) => {
      if (
        !group ||
        !clientId ||
        !authScope ||
        !view ||
        journal ||
        !review ||
        !options.reviewCurrent
      )
        throw Error('Inspect the current reviewed context before preparing a forward.');
      const snapshot = review.snapshot;
      const input = CollaborationForwardPrepareInputSchema.parse({
        selection: {
          requestId: createBrowserId(),
          target: {
            collaborationId: group,
            expectedMembershipRevision: review.expectedMembershipRevision,
            sessionIds: review.recipientSessionIds,
          },
          sourceConversationId: snapshot.sourceConversationId,
          boundary: snapshot.boundary,
          messages: snapshot.messages.map(({ messageId, sequence, blocks }) => ({
            messageId,
            sequence,
            blocks: blocks.map(({ blockId, sha256 }) => ({ blockId, sha256 })),
          })),
          artifacts: snapshot.artifacts.map(({ artifactId, revision, sha256 }) => ({
            kind: 'transcript_reference',
            artifactId,
            revision,
            sha256,
          })),
        },
        note: snapshot.joiningBrief || snapshot.purpose,
      });
      const record: Journal = {
        collaborationId: group,
        authScope,
        input,
        reviewInput: CollaborationPromptReviewInputSchema.parse({
          selection: {
            requestId: createBrowserId(),
            sourceConversationId: snapshot.sourceConversationId,
            boundary: snapshot.boundary,
            expectedMembershipRevision: review.expectedMembershipRevision,
            mode: 'selected',
            messageIds: snapshot.messages.map((message) => message.messageId),
            artifacts: snapshot.artifacts.map(({ artifactId, revision, sha256 }) => ({
              artifactId,
              revision,
              sha256,
            })),
            purpose: snapshot.purpose,
            joiningBrief: snapshot.joiningBrief,
          },
          recipientSessionIds: review.recipientSessionIds,
          expectedPolicySequence: review.expectedPolicySequence,
        }),
        confirmationAttempted: false,
      };
      persist(record);
      const result = await api.collaborations.prepareForward(group, clientId, input, signal);
      if (fresh()) observe(record, result);
    });
  const check = () =>
    perform(async (signal, fresh) => {
      if (!group || !clientId || !journal || !scoped)
        throw Error('Forwarding recovery is unavailable for this login.');
      const result = await api.collaborations.observeForwardPreparation(
        group,
        journal.input.selection.requestId,
        clientId,
        signal,
      );
      if (!fresh()) return;
      if (!result)
        throw Error(
          'The original preparation is not yet recorded. Check again; nothing was forwarded.',
        );
      observe(journal, result);
      if (result.state === 'confirmed') await refresh();
    });
  const matchesOriginal = (candidate: CollaborationPromptReviewResult | undefined) => {
    const review = candidate;
    return (
      !!review &&
      scoped &&
      review.expectedMembershipRevision ===
        journal.input.selection.target.expectedMembershipRevision &&
      JSON.stringify(review.recipientSessionIds) ===
        JSON.stringify(journal.input.selection.target.sessionIds) &&
      review.snapshot.sourceConversationId === journal.input.selection.sourceConversationId &&
      JSON.stringify(review.snapshot.boundary) ===
        JSON.stringify(journal.input.selection.boundary) &&
      JSON.stringify(
        review.snapshot.messages.map(({ messageId, sequence, blocks }) => ({
          messageId,
          sequence,
          blocks: blocks.map(({ blockId, sha256 }) => ({ blockId, sha256 })),
        })),
      ) === JSON.stringify(journal.input.selection.messages) &&
      JSON.stringify(
        review.snapshot.artifacts.map(({ artifactId, revision, sha256 }) => ({
          artifactId,
          revision,
          sha256,
          kind: 'transcript_reference',
        })),
      ) === JSON.stringify(journal.input.selection.artifacts) &&
      (review.snapshot.joiningBrief || review.snapshot.purpose) === journal.input.note
    );
  };
  const inspect = () =>
    perform(async (signal, fresh) => {
      if (!group || !clientId || !scoped || !journal?.reviewInput)
        throw Error(
          'The original review is unavailable. Inspect the exact source selection again.',
        );
      publish({ originalReview: undefined });
      const result = await api.collaborations.reviewPrompt(
        group,
        clientId,
        journal.reviewInput,
        signal,
      );
      if (!fresh()) return;
      if (!matchesOriginal(result))
        throw Error('The inspected context does not match the original forward.');
      publish({ originalReview: result });
    });
  const originalReviewCurrent =
    matchesOriginal(visible.originalReview) &&
    !visible.originalReview?.requiresReview &&
    visible.originalReview?.expectedPolicySequence === view?.policySequence &&
    ['ready', 'unverified'].includes(visible.originalReview?.snapshot.capacity.status ?? '');
  const reviewedSelectionCurrent =
    (options.reviewCurrent && matchesOriginal(review)) || originalReviewCurrent;
  const canConfirm =
    !!journal?.confirmation &&
    reviewedSelectionCurrent &&
    visible.observation?.state === 'prepared' &&
    view?.membershipRevision === journal.input.selection.target.expectedMembershipRevision;
  const confirm = () =>
    perform(async (signal, fresh) => {
      if (!canConfirm || !group || !clientId || !journal?.confirmation)
        throw Error('Check the original request and inspect its exact context before forwarding.');
      persist({ ...journal, confirmationAttempted: true });
      publish({ observation: undefined });
      await api.collaborations.confirmForward(group, clientId, journal.confirmation, signal);
      if (!fresh()) return;
      const result = await api.collaborations.forward(
        group,
        journal.confirmation.forward.forwardId,
        clientId,
        signal,
      );
      if (!fresh()) return;
      observe({ ...journal, confirmationAttempted: true }, result);
      await refresh();
    });
  const clear = () => {
    if (
      !valid() ||
      !scoped ||
      visible.busy ||
      (journal?.confirmationAttempted && visible.observation?.state !== 'confirmed')
    )
      return;
    try {
      persist();
      publish({ observation: undefined, originalReview: undefined, error: undefined });
    } catch (cause) {
      publish({
        error: cause instanceof Error ? cause.message : 'Could not clear the forwarding receipt.',
      });
    }
  };
  return {
    busy: !!visible.busy,
    retained: !!journal,
    observation: visible.observation,
    originalReview: visible.originalReview,
    originalRecipients: scoped ? journal.input.selection.target.sessionIds : [],
    canInspect: valid() && scoped && !!journal?.reviewInput && !visible.busy,
    error: visible.error,
    uncertain: !!journal?.confirmationAttempted && visible.observation?.state !== 'confirmed',
    canPrepare:
      valid() &&
      !journal &&
      !!review &&
      options.reviewCurrent &&
      review.snapshot.messages.length + review.snapshot.artifacts.length > 0,
    canConfirm: valid() && canConfirm && !visible.busy,
    canClear:
      valid() &&
      scoped &&
      !visible.busy &&
      (!journal?.confirmationAttempted || visible.observation?.state === 'confirmed'),
    prepare,
    confirm,
    check,
    inspect,
    clear,
  };
}
