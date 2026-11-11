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
import { resolveConversationResponders } from '../lib/conversation-presentation';

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
  const recipientKey = JSON.stringify(
    view && responders ? resolveConversationResponders(view, responders) : [],
  );
  const recipients = useMemo(() => JSON.parse(recipientKey) as string[], [recipientKey]);
  const intentKey = JSON.stringify(responders);
  const group = view?.collaborationId;
  const owner = useMemo(
    () => ({
      api,
      group,
      recipients,
      intentKey,
      draftId,
      authScope,
      membershipRevision: view?.membershipRevision,
      policySequence: view?.policySequence,
    }),
    [
      api,
      group,
      recipients,
      intentKey,
      draftId,
      authScope,
      view?.membershipRevision,
      view?.policySequence,
    ],
  );
  const current = useRef(owner);
  current.current = owner;
  const mounted = useRef(true);
  const busy = useRef<object | undefined>(undefined);
  const stopping = useRef<{ owner: object; requestId: string } | undefined>(undefined);
  const pending = useRef<Pending | undefined>(undefined);
  const [state, setState] = useState<{
    owner: object;
    ready?: boolean;
    reason?: string;
    pending?: Pending;
    error?: string;
    stopStatus?: string;
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
      publish({ pending: value, stopStatus: undefined });
    },
    [draftId, publish],
  );
  const check = useCallback(async () => {
    if (!valid() || !group || busy.current === owner) return;
    busy.current = owner;
    try {
      const original = pending.current;
      if (original) {
        if (original.authScope !== authScope || original.collaborationId !== group)
          throw Error('The original request belongs to another login or conversation.');
        const { terminal } = await api.observeSend(group, original.input);
        if (!valid()) return;
        await refresh();
        if (!valid()) return;
        // Visible text is not proof that native effects have settled. Renew the
        // exact request after the refresh await before retiring its journal.
        if (!terminal) return;
        const confirmed = await api.observeSend(group, original.input);
        if (!valid() || !confirmed.terminal) return;
        retain();
      }
      if (!recipients.length) return;
      const results = await Promise.all(
        recipients.map((recipient) => api.recipientReadiness(group, recipient)),
      );
      if (!valid()) return;
      if (
        results.some(
          (result, index) =>
            result.sessionId !== recipients[index] ||
            result.collaborationId !== group ||
            result.membershipRevision !== view?.membershipRevision ||
            result.policySequence !== view?.policySequence,
        )
      )
        throw Error('The conversation changed. Refresh before sending.');
      const refused = results.find((result) => !result.ready);
      publish({ ready: !refused, reason: refused?.reason ?? undefined, error: undefined });
    } catch (cause) {
      if (valid())
        publish({
          ready: false,
          error: cause instanceof Error ? cause.message : 'Could not verify delivery.',
        });
    } finally {
      if (busy.current === owner) busy.current = undefined;
    }
  }, [
    valid,
    owner,
    group,
    recipients,
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
    publish({
      ready: undefined,
      reason: undefined,
      pending: original,
      error: undefined,
      stopStatus: undefined,
    });
    void check();
    const lost = () => {
      publish({ ready: false });
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
    ? 'Conversation unavailable.'
    : visible.pending
      ? 'Check the original request. Queued or uncertain work will not be resent.'
      : !recipients.length
        ? 'Choose who replies with @ or enable replies by default in Agents.'
        : !view || recipients.some((id) => view.unavailableParticipantSessionIds.includes(id))
          ? 'Refresh Agents and choose an available participant.'
          : (visible.error ??
            (visible.ready ? undefined : (visible.reason ?? 'Checking recipient readiness…')));
  const send = useCallback(
    async (text: string) => {
      if (
        disabledReason ||
        !valid() ||
        busy.current === owner ||
        pending.current ||
        !view ||
        !recipients.length ||
        !responders ||
        !group ||
        !authScope
      )
        return false;
      busy.current = owner;
      try {
        const original: Pending = {
          collaborationId: group,
          authScope,
          input: CollaborationMessageInputSchema.parse({
            requestId: createBrowserId(),
            expectedMembershipRevision: view.membershipRevision,
            expectedPolicySequence: view.policySequence,
            text,
            responders,
            snapshot: null,
          }),
        };
        retain(original);
        const receipt = await api.send(group, original.input);
        if (!valid()) return false;
        if (
          receipt.text !== text ||
          receipt.responders.length !== recipients.length ||
          !recipients.every((id) => receipt.responders.includes(id)) ||
          receipt.deliveries.filter((d) => d.purpose === 'reply').length !== recipients.length ||
          !recipients.every((id) =>
            receipt.deliveries.some((d) => d.purpose === 'reply' && d.sessionId === id),
          ) ||
          receipt.membershipRevision !== original.input.expectedMembershipRevision ||
          receipt.policySequence !== original.input.expectedPolicySequence
        )
          throw Error('The receipt does not match the original request. Check its outcome.');
        await refresh();
        return (
          valid() &&
          receipt.deliveries.some(
            (d) => d.purpose === 'reply' && ['queued', 'delivered'].includes(d.status),
          )
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
        if (busy.current === owner) busy.current = undefined;
      }
    },
    [
      disabledReason,
      valid,
      owner,
      view,
      recipients,
      responders,
      group,
      authScope,
      api,
      retain,
      refresh,
      publish,
    ],
  );
  const stop = useCallback(async () => {
    if (!valid() || !group) return;
    const original = pending.current;
    if (!original || original.authScope !== authScope || original.collaborationId !== group) return;
    if (
      stopping.current?.owner === owner &&
      stopping.current.requestId === original.input.requestId
    )
      return;
    const ownsRequest = () =>
      valid() && pending.current?.input.requestId === original.input.requestId;
    const operation = { owner, requestId: original.input.requestId };
    stopping.current = operation;
    try {
      // Persist control intent before any request; reloading never starts a new
      // send or automatically reissues a Stop with a different command identity.
      retain({ ...original, stopRequested: true });
      publish({ stopStatus: 'Requesting Stop for the original prompt…' });
      const result = await api.stopSend(group, original.input);
      if (!ownsRequest()) return;
      publish({
        stopStatus: result.recipients.some((r) => ['uncertain', 'unavailable'].includes(r.status))
          ? 'Stop could not be confirmed for every recipient. Check the original request; do not resend.'
          : 'Stop requested. Waiting for the original commands to settle.',
      });
      await refresh();
    } catch (cause) {
      if (ownsRequest())
        publish({
          stopStatus: 'Stop is uncertain. Check the original request; do not resend.',
          error: cause instanceof Error ? cause.message : 'Could not confirm Stop.',
        });
    } finally {
      if (stopping.current === operation) stopping.current = undefined;
    }
  }, [valid, group, owner, authScope, retain, publish, api, refresh]);
  return {
    disabledReason,
    error: visible.error,
    pending: visible.pending,
    stopStatus: visible.stopStatus,
    stop,
    check,
    send,
  };
}
