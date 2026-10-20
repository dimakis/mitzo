import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CollaborationApiError,
  applyCollaborationEvents,
  createCollaborationProjection,
  type CollaborationApiClient,
  type CollaborationProjection,
} from '@mitzo/client';
import {
  CollaborationMessageInputSchema,
  SessionCollaborationIdSchema,
  type CollaborationMessageInput,
  type CollaborationPolicy,
  type CollaborationPolicyUpdate,
  type CollaborationView,
} from '@mitzo/protocol';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import {
  CHAT_DRAFTS_CHANGED,
  getChatDraft,
  saveChatDraft,
  type ChatDraft,
} from '../lib/chat-drafts';
import { createBrowserId } from '../lib/browser-crypto';
import { conversationResponders } from '../lib/conversation-presentation';

type Responders = CollaborationMessageInput['responders'];
export interface ConversationPresentationOptions {
  collaborationId: string | null;
  api: CollaborationApiClient;
  /** Current non-secret login reference from the existing verified auth owner. */
  authScope?: string;
  /** Supply the existing owner's currentVerifiedAuthSessionId; never a second auth registry. */
  getVerifiedAuthScope?(): string | undefined;
  draftId?: string;
  names?: Readonly<Record<string, string>>;
}
interface PendingPolicy {
  input: CollaborationPolicyUpdate;
  uncertain: boolean;
  /** Matching mutation receipt; checkbox authority still comes from the view. */
  receipt?: CollaborationPolicy;
  needsRefresh: boolean;
}
interface ViewState {
  owner: object;
  projection: CollaborationProjection | null;
  draft: ChatDraft | null;
  loading: boolean;
  error: string | null;
  draftError: string | null;
  policyError: string | null;
  pendingPolicy: PendingPolicy | null;
  hasMoreEvents: boolean;
}
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Conversation unavailable';

/** One presentation controller around the real API/projection and ordinary draft owner.
 * It never calls send, queues work, allocates sessions or infers execution readiness.
 */
export function useConversationPresentation(options: ConversationPresentationOptions) {
  const { collaborationId, api, authScope, getVerifiedAuthScope, draftId, names } = options;
  const owner = useMemo(
    () => ({ collaborationId, api, authScope, getVerifiedAuthScope, draftId }),
    [collaborationId, api, authScope, getVerifiedAuthScope, draftId],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const mounted = useRef(true),
    blocked = useRef(false),
    epoch = useRef(0),
    readId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  // Ephemeral UI retry state only. The server owns durable policy request receipts.
  const pending = useRef<PendingPolicy | null>(null);
  const empty = useCallback(
    (): ViewState => ({
      owner,
      projection: null,
      draft: null,
      loading: false,
      error: null,
      draftError: null,
      policyError: null,
      pendingPolicy: null,
      hasMoreEvents: false,
    }),
    [owner],
  );
  const [state, setState] = useState<ViewState>(empty);
  const latest = useRef(state);
  latest.current = state;
  const valid = useCallback(() => {
    try {
      return (
        mounted.current &&
        currentOwner.current === owner &&
        !blocked.current &&
        !!authScope &&
        !!collaborationId &&
        SessionCollaborationIdSchema.safeParse(collaborationId).success &&
        getVerifiedAuthScope?.() === authScope
      );
    } catch {
      return false;
    }
  }, [owner, authScope, collaborationId, getVerifiedAuthScope]);
  const publish = useCallback(
    (patch: Partial<ViewState>) => {
      if (!mounted.current || currentOwner.current !== owner) return;
      setState((previous) => {
        const next = { ...(previous.owner === owner ? previous : empty()), ...patch, owner };
        latest.current = next;
        return next;
      });
    },
    [owner, empty],
  );
  const clearPrivate = useCallback(() => {
    if (currentOwner.current !== owner) return;
    blocked.current = true;
    epoch.current++;
    readId.current++;
    controller.current?.abort();
    pending.current = null;
    publish({ ...empty(), error: 'Sign in to verify this conversation.' });
  }, [owner, empty, publish]);
  const readDraft = useCallback(() => {
    if (!valid()) return;
    const draft = draftId ? getChatDraft(draftId) : null;
    const foreign = draft?.settings.collaborationResponders?.collaborationId;
    const previous = latest.current.owner === owner ? latest.current.draft : null;
    const content = (value: ChatDraft | null) =>
      value
        ? JSON.stringify({
            id: value.id,
            text: value.text,
            images: value.images,
            contextBlocks: value.contextBlocks,
            settings: value.settings,
          })
        : null;
    // ChatInput saves through this same owner. Ignore timestamp-only notifications
    // so returning its draft cannot cause a save -> notification -> render loop.
    const stableDraft = content(previous) === content(draft) ? previous : draft;
    publish(
      foreign && foreign !== collaborationId
        ? { draft: null, draftError: 'This draft belongs to another conversation.' }
        : {
            draft: stableDraft,
            draftError: draft ? null : 'The conversation draft is unavailable.',
          },
    );
  }, [valid, draftId, collaborationId, publish, owner]);
  const reconcile = useCallback((view: CollaborationView) => {
    const original = pending.current?.input;
    if (!original) return;
    const current = view.policies.find((policy) => policy.sessionId === original.sessionId);
    // An unchanged read cannot prove an in-flight mutation will not commit later.
    if (
      view.membershipRevision !== original.expectedMembershipRevision ||
      (current && current.revision > original.expectedRevision)
    )
      pending.current = null;
  }, []);
  const read = useCallback(
    async (events: boolean): Promise<{ error: string } | undefined> => {
      if (!valid()) {
        clearPrivate();
        return;
      }
      const starting = latest.current.owner === owner ? latest.current.projection : null;
      const identity = ++readId.current,
        generation = epoch.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const fresh = () =>
        valid() &&
        epoch.current === generation &&
        readId.current === identity &&
        !abort.signal.aborted;
      publish({ loading: true, error: null });
      try {
        let projection: CollaborationProjection,
          hasMoreEvents = false;
        if (events && starting && !starting.needsRefresh) {
          const page = await api.events(collaborationId!, starting.view.cursor, abort.signal);
          if (!fresh()) return;
          projection = applyCollaborationEvents(starting, page);
          hasMoreEvents = page.hasMore;
        } else {
          const view = await api.view(collaborationId!, abort.signal);
          if (!fresh()) return;
          if (
            view.collaborationId !== collaborationId ||
            (starting && view.cursor < starting.view.cursor)
          )
            throw new Error(
              'The conversation refresh does not match its current scope and cursor.',
            );
          projection = createCollaborationProjection(view);
        }
        if (!fresh()) return;
        if (!projection.needsRefresh) reconcile(projection.view);
        const error = projection.needsRefresh
          ? 'Refresh this conversation before changing its policy.'
          : null;
        publish({
          projection,
          loading: false,
          hasMoreEvents,
          error,
          pendingPolicy: pending.current,
          ...(pending.current ? {} : { policyError: null }),
        });
        readDraft();
        if (error) return { error };
      } catch (cause) {
        if (fresh()) {
          const error = message(cause);
          publish({ loading: false, error });
          return { error };
        }
      }
    },
    [valid, clearPrivate, owner, api, collaborationId, publish, reconcile, readDraft],
  );
  const refresh = useCallback(async () => {
    await read(false);
  }, [read]);
  const refreshEvents = useCallback(async () => {
    await read(true);
  }, [read]);
  useEffect(() => {
    mounted.current = true;
    blocked.current = false;
    epoch.current++;
    pending.current = null;
    publish(empty());
    const restored = () => {
      const generation = epoch.current;
      // The existing auth owner emits restoration before assigning its verified
      // cookie record. Check after that synchronous publication, never on a timer.
      queueMicrotask(() => {
        if (!mounted.current || currentOwner.current !== owner || epoch.current !== generation)
          return;
        blocked.current = false;
        if (valid()) {
          epoch.current++;
          void refresh();
        } else clearPrivate();
      });
    };
    const draftsChanged = () => readDraft();
    window.addEventListener(AUTH_LOST_EVENT, clearPrivate);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    window.addEventListener(CHAT_DRAFTS_CHANGED, draftsChanged);
    if (valid()) {
      readDraft();
      void refresh();
    } else clearPrivate();
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.removeEventListener(AUTH_LOST_EVENT, clearPrivate);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
      window.removeEventListener(CHAT_DRAFTS_CHANGED, draftsChanged);
    };
  }, [owner, valid, clearPrivate, refresh, readDraft, empty, publish]);
  const setResponders = useCallback(
    (raw: Responders): boolean => {
      if (!valid()) {
        clearPrivate();
        return false;
      }
      const parsed = CollaborationMessageInputSchema.shape.responders.safeParse(raw);
      const draft = draftId ? getChatDraft(draftId) : null;
      const scope = draft?.settings.collaborationResponders?.collaborationId;
      if (!parsed.success || !draft || (scope && scope !== collaborationId)) {
        publish({ draftError: 'Choose recipients in this conversation’s own draft.' });
        return false;
      }
      if (
        !saveChatDraft({
          ...draft,
          settings: {
            ...draft.settings,
            collaborationResponders: { collaborationId: collaborationId!, responders: parsed.data },
          },
        })
      ) {
        publish({ draftError: 'Could not save the recipient choice. Your draft stays here.' });
        return false;
      }
      readDraft();
      return true;
    },
    [valid, clearPrivate, draftId, collaborationId, publish, readDraft],
  );
  const submitPolicy = useCallback(
    async (original: PendingPolicy): Promise<boolean> => {
      const generation = epoch.current;
      if (!valid()) {
        clearPrivate();
        return false;
      }
      const fresh = () => valid() && generation === epoch.current && pending.current === original;
      publish({ pendingPolicy: original, policyError: null });
      try {
        const receipt = original.receipt ?? (await api.setPolicy(collaborationId!, original.input));
        if (!fresh()) return false;
        if (
          receipt.sessionId !== original.input.sessionId ||
          receipt.revision !== original.input.expectedRevision + 1 ||
          receipt.membershipRevision !== original.input.expectedMembershipRevision ||
          receipt.readsFutureDiscussion !== original.input.readsFutureDiscussion ||
          receipt.repliesByDefault !== original.input.repliesByDefault
        )
          throw new Error(
            'The policy receipt does not match this request. Refresh before continuing.',
          );
        original.receipt = receipt;
        original.uncertain = false;
        const confirmation = await read(false);
        if (fresh()) {
          // read() retains confirmed state and reports its own failures. A matching
          // PUT receipt alone must not strand the dialog in its saving state.
          original.needsRefresh = true;
          publish({
            pendingPolicy: original,
            policyError:
              confirmation?.error ??
              'The saved policy is not confirmed by the current view. Refresh discussion sharing.',
          });
          return false;
        }
        return valid() && generation === epoch.current && pending.current === null;
      } catch (cause) {
        if (!fresh()) return false;
        const definite =
          cause instanceof CollaborationApiError &&
          [400, 401, 403, 404, 409, 422].includes(cause.status);
        if (original.receipt) original.needsRefresh = true;
        else if (definite) pending.current = null;
        else original.uncertain = true;
        publish({ pendingPolicy: pending.current, policyError: message(cause) });
        return false;
      }
    },
    [valid, clearPrivate, api, collaborationId, read, publish],
  );
  const setPolicy = useCallback(
    async (sessionId: string, values: { reads: boolean; replies: boolean }): Promise<boolean> => {
      if (!valid()) {
        clearPrivate();
        return false;
      }
      const current = latest.current;
      const view = current.owner === owner ? current.projection?.view : undefined;
      const policy = view?.policies.find((policy) => policy.sessionId === sessionId);
      if (
        pending.current ||
        !view ||
        current.loading ||
        current.error ||
        current.policyError ||
        current.projection?.needsRefresh
      )
        return false;
      if (
        !policy ||
        !view.participantSessionIds.includes(sessionId) ||
        view.unavailableParticipantSessionIds.includes(sessionId)
      ) {
        publish({
          policyError:
            'Discussion sharing is unavailable for this agent. Refresh the conversation.',
        });
        return false;
      }
      const original: PendingPolicy = {
        uncertain: false,
        needsRefresh: false,
        input: {
          requestId: createBrowserId(),
          expectedMembershipRevision: view.membershipRevision,
          expectedRevision: policy.revision,
          sessionId,
          readsFutureDiscussion: values.reads,
          repliesByDefault: values.replies,
        },
      };
      pending.current = original;
      return submitPolicy(original);
    },
    [valid, clearPrivate, owner, submitPolicy, publish],
  );
  const retryPolicy = useCallback(
    async () => (pending.current ? submitPolicy(pending.current) : false),
    [submitPolicy],
  );

  const authorized = valid(),
    visible = state.owner === owner && authorized ? state : empty();
  const projection = visible.projection;
  const stored = visible.draft?.settings.collaborationResponders;
  const responderIntent: Responders | null = visible.draft
    ? (stored?.responders ?? { kind: 'default' })
    : null;
  const selection =
    projection && responderIntent
      ? conversationResponders(projection.view, responderIntent, names)
      : null;
  const recipientError =
    responderIntent?.kind === 'selected' && !responderIntent.sessionIds.length
      ? 'Use @ to choose who replies before sending.'
      : selection?.selectedIds.some(
            (id) =>
              !selection.members.some((member) => member.id === id && !member.unavailableReason),
          )
        ? 'A selected agent is unavailable. Choose who replies before sending.'
        : null;
  return {
    projection,
    draft: visible.draft,
    loading: visible.loading,
    error: authorized ? visible.error : 'Sign in to verify this conversation.',
    draftError: visible.draftError,
    policyError: visible.policyError,
    pendingPolicy: visible.pendingPolicy,
    hasMoreEvents: visible.hasMoreEvents,
    responderIntent,
    resolvedResponderIds: selection?.selectedIds ?? [],
    recipientError,
    sendDisabledReason:
      projection?.view.execution.reason ?? 'Verify this conversation before sending.',
    policyDisabled:
      !authorized ||
      !projection ||
      visible.loading ||
      !!visible.error ||
      !!visible.policyError ||
      !!visible.pendingPolicy ||
      projection.needsRefresh,
    composerResponders: selection
      ? {
          ...selection,
          disabled: !authorized || !visible.draft,
          onChange: (_ids: string[], intent?: Responders) =>
            intent ? setResponders(intent) : false,
        }
      : undefined,
    refresh,
    refreshEvents,
    setResponders,
    setPolicy,
    retryPolicy,
  };
}
