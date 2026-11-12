import { useEffect, useMemo, useRef, useState } from 'react';
import type { MitzoApiClient } from '@mitzo/client';
import {
  CollaborationPromptReviewInputSchema,
  type CollaborationDurableTranscript,
  type CollaborationMessageInput,
  type CollaborationPromptReviewResult,
  type CollaborationView,
} from '@mitzo/protocol';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { getChatDraft, saveChatDraft, type ChatDraft } from '../lib/chat-drafts';
import { createBrowserId } from '../lib/browser-crypto';
import { resolveConversationResponders } from '../lib/conversation-presentation';

type Record = NonNullable<ChatDraft['collaborationContext']>;
export type PromptContextForm = Record['form'];
const emptyForm = (): PromptContextForm => ({
  mode: 'selected',
  purpose: '',
  brief: '',
  messageIds: [],
});
export function useConversationPromptContext(options: {
  api: MitzoApiClient;
  sourceConversationId: string;
  clientId?: string;
  view?: CollaborationView;
  responders: CollaborationMessageInput['responders'] | null;
  draftId?: string;
  authScope?: string;
  getVerifiedAuthScope(): string | undefined;
}) {
  const {
    api,
    sourceConversationId,
    clientId,
    view,
    responders,
    draftId,
    authScope,
    getVerifiedAuthScope,
  } = options;
  const group = view?.collaborationId;
  const owner = useMemo(
    () => ({ api, sourceConversationId, clientId, group, draftId, authScope }),
    [api, sourceConversationId, clientId, group, draftId, authScope],
  );
  const current = useRef(owner);
  current.current = owner;
  const blocked = useRef(false);
  const epoch = useRef(0);
  const operation = useRef<{ owner: object; controller: AbortController } | undefined>(undefined);
  const [state, setState] = useState<{
    owner: object;
    open?: boolean;
    record?: Record;
    source?: CollaborationDurableTranscript;
    review?: CollaborationPromptReviewResult;
    busy?: boolean;
    error?: string;
    blocked?: boolean;
    retirementFailed?: boolean;
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
    const advanceEpoch = () => {
      epoch.current++;
    };
    advanceEpoch();
    blocked.current = false;
    const record = draftId ? getChatDraft(draftId)?.collaborationContext : undefined;
    setState({ owner, record });
    const lost = () => {
      blocked.current = true;
      advanceEpoch();
      operation.current?.controller.abort();
      operation.current = undefined;
      setState({ owner, blocked: true });
    };
    const restored = () => {
      const generation = epoch.current;
      queueMicrotask(() => {
        if (
          generation !== epoch.current ||
          current.current !== owner ||
          !authScope ||
          getVerifiedAuthScope() !== authScope
        )
          return;
        epoch.current++;
        blocked.current = false;
        setState({
          owner,
          record: draftId ? getChatDraft(draftId)?.collaborationContext : undefined,
        });
      });
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    return () => {
      advanceEpoch();
      if (operation.current?.owner === owner) {
        operation.current.controller.abort();
        operation.current = undefined;
      }
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
    };
  }, [owner, draftId, authScope, getVerifiedAuthScope]);
  const visible =
    state.owner === owner && !state.blocked && getVerifiedAuthScope() === authScope
      ? state
      : { owner };
  const record = visible.record;
  const scoped = !!record && record.collaborationId === group && record.authScope === authScope;
  const form = scoped ? record.form : emptyForm();
  const recipients =
    view && responders
      ? [
          ...new Set([
            ...resolveConversationResponders(view, responders),
            ...view.policies.filter((p) => p.readsFutureDiscussion).map((p) => p.sessionId),
          ]),
        ].sort()
      : [];
  const audienceCurrent =
    !!record?.input &&
    record.input.selection.expectedMembershipRevision === view?.membershipRevision &&
    record.input.expectedPolicySequence === view?.policySequence &&
    JSON.stringify(record.input.recipientSessionIds) === JSON.stringify(recipients);
  const persist = (next?: Record) => {
    if (!valid()) throw Error('Sign in again before reviewing context.');
    const draft = draftId ? getChatDraft(draftId) : undefined;
    if (!draft || !saveChatDraft({ ...draft, collaborationContext: next }))
      throw Error('Could not retain the context review. Your draft is preserved.');
    publish({ record: next, error: undefined });
  };
  const perform = async (action: (signal: AbortSignal, fresh: () => boolean) => Promise<void>) => {
    if (!valid() || operation.current?.owner === owner) return;
    const active = { owner, controller: new AbortController() };
    operation.current = active;
    const fresh = () =>
      valid() && operation.current === active && !active.controller.signal.aborted;
    publish({ busy: true, error: undefined });
    try {
      await action(active.controller.signal, fresh);
    } catch (cause) {
      if (fresh())
        publish({
          error:
            cause instanceof Error
              ? cause.message
              : 'Context review is unavailable. Check the retained review.',
        });
    } finally {
      if (operation.current === active) {
        operation.current = undefined;
        if (valid()) publish({ busy: false });
      }
    }
  };
  const show = () => {
    publish({ open: true });
    void perform(async (signal, fresh) => {
      const source = await api.getDurableSessionTranscript(sourceConversationId, signal);
      if (!fresh()) return;
      if (source.sourceConversationId !== sourceConversationId)
        throw Error('The context source changed.');
      publish({ source });
    });
  };
  const edit = (next: PromptContextForm) => {
    if (!group || !authScope || visible.busy) return;
    try {
      persist({ collaborationId: group, authScope, form: next, attached: false });
      publish({ review: undefined });
    } catch (cause) {
      publish({ error: cause instanceof Error ? cause.message : 'Could not retain context.' });
    }
  };
  const review = (refreeze = false) =>
    void perform(async (signal, fresh) => {
      if (!group || !clientId || !authScope || !view || !recipients.length || !scoped)
        throw Error('Choose recipients and enter a purpose before reviewing context.');
      let input = refreeze ? undefined : record.input;
      if (!input) {
        const source = await api.getDurableSessionTranscript(sourceConversationId, signal);
        if (!fresh()) return;
        input = CollaborationPromptReviewInputSchema.parse({
          selection: {
            requestId: createBrowserId(),
            sourceConversationId,
            boundary: source.boundary,
            expectedMembershipRevision: view.membershipRevision,
            mode: form.mode,
            messageIds: form.mode === 'selected' ? form.messageIds : [],
            artifacts: [],
            purpose: form.purpose,
            joiningBrief: form.brief,
          },
          recipientSessionIds: recipients,
          expectedPolicySequence: view.policySequence,
        });
        publish({ source });
        // Retain selectors before POST. Lost responses recover this exact review;
        // no snapshot text, command or new agent is stored in the browser journal.
        persist({ ...record, input, snapshot: undefined, attached: false });
      }
      const reviewed = await api.collaborations.reviewPrompt(group, clientId, input, signal);
      if (!fresh()) return;
      if (
        reviewed.snapshot.sourceConversationId !== sourceConversationId ||
        reviewed.snapshot.purpose !== input.selection.purpose.trim() ||
        reviewed.snapshot.joiningBrief !== input.selection.joiningBrief ||
        reviewed.snapshot.mode !== input.selection.mode ||
        JSON.stringify(reviewed.snapshot.boundary) !== JSON.stringify(input.selection.boundary) ||
        reviewed.expectedMembershipRevision !== input.selection.expectedMembershipRevision ||
        reviewed.expectedPolicySequence !== input.expectedPolicySequence ||
        JSON.stringify(reviewed.recipientSessionIds) !== JSON.stringify(input.recipientSessionIds)
      )
        throw Error('The returned review does not match this context request.');
      persist({
        ...record,
        input,
        snapshot: { snapshotId: reviewed.snapshot.snapshotId, sha256: reviewed.snapshot.sha256 },
        attached: false,
      });
      publish({ review: reviewed, retirementFailed: false });
    });
  const reviewUsable =
    scoped &&
    audienceCurrent &&
    visible.review &&
    !visible.review.requiresReview &&
    ['ready', 'unverified'].includes(visible.review.snapshot.capacity.status) &&
    visible.review.snapshot.snapshotId === record.snapshot?.snapshotId &&
    visible.review.snapshot.sha256 === record.snapshot?.sha256;
  const attach = () => {
    if (!reviewUsable || !record || visible.busy) return;
    try {
      persist({ ...record, attached: true });
      publish({ open: false });
    } catch (cause) {
      publish({
        error: cause instanceof Error ? cause.message : 'Could not attach reviewed context.',
      });
    }
  };
  const remove = () => {
    if (visible.busy) return;
    try {
      persist();
      publish({ review: undefined, retirementFailed: false });
    } catch (cause) {
      publish({ error: cause instanceof Error ? cause.message : 'Could not remove context.' });
    }
  };
  const consume = (input: CollaborationMessageInput) => {
    if (!valid() || !input.snapshot || !scoped) return;
    const latest = draftId ? getChatDraft(draftId)?.collaborationContext : undefined;
    if (
      !latest?.attached ||
      latest.authScope !== authScope ||
      latest.collaborationId !== group ||
      latest.input?.selection.requestId !== record.input?.selection.requestId ||
      latest.snapshot?.snapshotId !== input.snapshot.snapshotId ||
      latest.snapshot.sha256 !== input.snapshot.sha256
    )
      return;
    try {
      persist();
      publish({ review: undefined, retirementFailed: false });
    } catch (cause) {
      publish({
        retirementFailed: true,
        error:
          cause instanceof Error
            ? cause.message
            : 'Could not retire the accepted context. Remove it before another prompt.',
      });
    }
  };
  const disabledReason =
    record?.attached && (!scoped || !reviewUsable || visible.retirementFailed)
      ? 'Check or review the attached context again before sending.'
      : undefined;
  return {
    open: !!visible.open,
    busy: !!visible.busy,
    form,
    source: visible.source,
    review: visible.review,
    error: visible.error,
    hasRetainedReview: scoped && !!record.input,
    recipients,
    attached: scoped && !!record.attached,
    hasRetainedContext: !!record,
    canAttach: !!reviewUsable && !visible.busy,
    snapshot: scoped && record.attached && reviewUsable ? record.snapshot : undefined,
    disabledReason,
    unavailable: !valid() || !group || !clientId || !recipients.length,
    show,
    edit,
    reviewContext: review,
    attach,
    remove,
    consume,
    close: () => {
      operation.current?.controller.abort();
      operation.current = undefined;
      publish({ open: false, busy: false });
    },
  };
}
