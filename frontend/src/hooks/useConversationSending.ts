import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CollaborationApiError, type CollaborationApiClient } from '@mitzo/client';
import {
  CollaborationMessageInputSchema,
  type CollaborationMessageInput,
  type CollaborationView,
} from '@mitzo/protocol';
import { getChatDraft, saveChatDraft, type ChatDraft } from '../lib/chat-drafts';
import { createBrowserId } from '../lib/browser-crypto';
import { AUTH_LOST_EVENT } from '../lib/api-fetch';

type Pending = NonNullable<ChatDraft['collaborationSend']>;
export function useConversationSending(options: {
  api: CollaborationApiClient;
  view?: CollaborationView;
  responders: CollaborationMessageInput['responders'] | null;
  draftId?: string;
  authScope?: string;
  getVerifiedAuthScope(): string | undefined;
  refresh(): Promise<CollaborationView | void>;
}) {
  const { api, view, draftId, authScope, getVerifiedAuthScope, refresh, responders } = options;
  const recipient =
    responders?.kind === 'selected' && responders.sessionIds.length === 1
      ? responders.sessionIds[0]
      : undefined;
  const group = view?.collaborationId;
  const owner = useMemo(
    () => ({
      api,
      group,
      recipient,
      draftId,
      authScope,
      membershipRevision: view?.membershipRevision,
      policySequence: view?.policySequence,
    }),
    [api, group, recipient, draftId, authScope, view?.membershipRevision, view?.policySequence],
  );
  const current = useRef(owner);
  current.current = owner;
  const mounted = useRef(true);
  const busy = useRef(false);
  const pending = useRef<Pending | undefined>(undefined);
  const [state, setState] = useState<{
    owner: object;
    ready?: boolean;
    reason?: string;
    pending?: Pending;
    error?: string;
  }>({ owner });
  const valid = useCallback(
    () =>
      mounted.current &&
      current.current === owner &&
      !!authScope &&
      getVerifiedAuthScope() === authScope,
    [owner, authScope, getVerifiedAuthScope],
  );
  const publish = useCallback(
    (patch: Partial<typeof state>) => {
      if (mounted.current && current.current === owner)
        setState((s) => ({ ...(s.owner === owner ? s : { owner }), ...patch, owner }));
    },
    [owner],
  );
  const retain = useCallback(
    (value?: Pending) => {
      const draft = draftId ? getChatDraft(draftId) : null;
      if (!draft || !saveChatDraft({ ...draft, collaborationSend: value }))
        throw Error('Could not retain the original request. Your draft stays here.');
      pending.current = value;
      publish({ pending: value });
    },
    [draftId, publish],
  );
  const check = useCallback(async () => {
    if (!valid() || !group || busy.current) return;
    busy.current = true;
    try {
      const original = pending.current;
      if (original) {
        if (original.authScope !== authScope || original.collaborationId !== group)
          throw Error('The original request belongs to another login or conversation.');
        const { message } = await api.observeSend(group, original.input);
        if (!valid()) return;
        const latest = await refresh();
        if (!valid()) return;
        // The original message stays retained until a terminal outcome is visible.
        if (
          message &&
          (message.deliveries.every((d) => ['failed', 'unavailable'].includes(d.status)) ||
            latest?.messages.some(
              (m) =>
                m.replyToDeliveryId &&
                message.deliveries.some((d) => d.deliveryId === m.replyToDeliveryId),
            ))
        )
          retain();
        return;
      }
      if (!recipient) return;
      const result = await api.recipientReadiness(group, recipient);
      if (!valid()) return;
      if (
        result.membershipRevision !== view?.membershipRevision ||
        result.policySequence !== view?.policySequence
      )
        throw Error('The conversation changed. Refresh before sending.');
      publish({ ready: result.ready, reason: result.reason ?? undefined, error: undefined });
    } catch (cause) {
      if (valid())
        publish({
          ready: false,
          error: cause instanceof Error ? cause.message : 'Could not verify delivery.',
        });
    } finally {
      busy.current = false;
    }
  }, [
    valid,
    group,
    recipient,
    api,
    authScope,
    refresh,
    view?.membershipRevision,
    view?.policySequence,
    retain,
    publish,
  ]);
  useEffect(() => {
    mounted.current = true;
    const original = draftId ? getChatDraft(draftId)?.collaborationSend : undefined;
    pending.current = original;
    publish({ ready: undefined, reason: undefined, pending: original, error: undefined });
    void check();
    const lost = () => {
      publish({ ready: false, reason: 'Sign in to verify this conversation.' });
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    return () => {
      mounted.current = false;
      window.removeEventListener(AUTH_LOST_EVENT, lost);
    };
  }, [owner, draftId, check, publish]);
  useEffect(() => {
    if (!state.pending || !valid()) return;
    const timer = window.setInterval(() => void check(), 2000);
    return () => window.clearInterval(timer);
  }, [state.pending, check, valid]);
  const visible = state.owner === owner ? state : { owner };
  const disabledReason = !valid()
    ? 'Sign in to verify this conversation.'
    : visible.pending
      ? 'Check the original request. Queued or uncertain work will not be resent.'
      : !recipient
        ? 'Use @ to choose one agent for this prompt.'
        : !view || view.unavailableParticipantSessionIds.includes(recipient)
          ? 'Refresh Agents and choose an available participant.'
          : (visible.error ??
            (visible.ready ? undefined : (visible.reason ?? 'Checking recipient readiness…')));
  const send = useCallback(
    async (text: string) => {
      if (
        disabledReason ||
        !valid() ||
        busy.current ||
        pending.current ||
        !view ||
        !recipient ||
        !group ||
        !authScope
      )
        return false;
      const original: Pending = {
        collaborationId: group,
        authScope,
        input: CollaborationMessageInputSchema.parse({
          requestId: createBrowserId(),
          expectedMembershipRevision: view.membershipRevision,
          expectedPolicySequence: view.policySequence,
          text,
          responders: { kind: 'selected', sessionIds: [recipient] },
          snapshot: null,
        }),
      };
      busy.current = true;
      try {
        retain(original);
        const receipt = await api.send(group, original.input);
        if (!valid()) return false;
        if (
          receipt.text !== text ||
          receipt.responders.length !== 1 ||
          receipt.responders[0] !== recipient ||
          receipt.membershipRevision !== original.input.expectedMembershipRevision
        )
          throw Error('The receipt does not match the original request. Check its outcome.');
        await refresh();
        return (
          valid() && receipt.deliveries.some((d) => ['queued', 'delivered'].includes(d.status))
        );
      } catch (cause) {
        if (valid()) {
          if (cause instanceof CollaborationApiError && cause.dispatchNotStarted) retain();
          publish({
            error:
              cause instanceof Error
                ? cause.message
                : 'Delivery is uncertain. Check the original request.',
          });
        }
        return false;
      } finally {
        busy.current = false;
      }
    },
    [disabledReason, valid, view, recipient, group, authScope, api, retain, refresh, publish],
  );
  return { disabledReason, error: visible.error, pending: visible.pending, check, send };
}
