import {
  createContext,
  useCallback,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from 'react';
import { MitzoApiClient } from '@mitzo/client';
import { useMitzoStore } from '@mitzo/client/hooks';
import { CollaborationBeginSchema, SessionCollaborationIdSchema } from '@mitzo/protocol';
import {
  apiFetch,
  currentVerifiedAuthSessionId,
  AUTH_RESTORED_EVENT,
  AUTH_LOST_EVENT,
} from '../lib/api-fetch';
import { createChatDraft, getChatDraft, saveChatDraft } from '../lib/chat-drafts';
import { createBrowserId } from '../lib/browser-crypto';
import { createConversationJoiningApplicationOwner } from '../lib/conversation-joining-application-owner';
import { useConversationPresentation } from '../hooks/useConversationPresentation';
import { useConversationSending } from '../hooks/useConversationSending';
import { useConversationProgress } from '../hooks/useConversationProgress';
import { useConversationPromptContext } from '../hooks/useConversationPromptContext';
import { useConversationForwarding } from '../hooks/useConversationForwarding';
import {
  ConversationPromptContext,
  ConversationPromptContextButton,
} from './ConversationPromptContext';
import { ConversationAgents } from './ConversationAgents';
import { CollaborationTranscript } from './CollaborationTranscript';
import { ChatInput } from './ChatInput';
import { ChatStatusMessage } from './ChatStatusMessage';
import { ChatArea, type ChatAreaProps } from './ChatArea';
import { SharedConversationComposerContext } from '../lib/shared-conversation-composer';

const applicationApi = new MitzoApiClient(apiFetch);
const EMPTY_CONTEXT: string[] = [];
type Host = ReturnType<typeof useSharedConversation>;
const Context = createContext<Host | null>(null);

/** One owner above the responsive screens; resizing does not retire joining or send identity. */
export function OrdinarySharedConversationHost({
  sourceConversationId,
  children,
}: {
  sourceConversationId: string | null;
  children: ReactNode;
}) {
  const clientId = useMitzoStore((s) => s.connection?.clientId) ?? undefined;
  const [authScope, setAuthScope] = useState<string>();
  useEffect(() => {
    if (!clientId) return;
    // Startup/login already owns authentication. Observe its proof and events;
    // mounting an ordinary chat must not start a second auth/recovery operation.
    const verify = () => setAuthScope(currentVerifiedAuthSessionId());
    const lost = () => setAuthScope(undefined);
    verify();
    window.addEventListener(AUTH_RESTORED_EVENT, verify);
    window.addEventListener(AUTH_LOST_EVENT, lost);
    return () => {
      window.removeEventListener(AUTH_RESTORED_EVENT, verify);
      window.removeEventListener(AUTH_LOST_EVENT, lost);
    };
  }, [clientId]);
  return (
    <SharedConversationHost
      sourceConversationId={sourceConversationId ?? ''}
      api={applicationApi}
      clientId={clientId}
      authScope={authScope}
      getVerifiedAuthScope={currentVerifiedAuthSessionId}
    >
      {children}
    </SharedConversationHost>
  );
}
export function SharedConversationHost({
  children,
  ...options
}: Parameters<typeof useSharedConversation>[0] & { children: ReactNode }) {
  const value = useSharedConversation(options);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
function useSharedConversation({
  sourceConversationId,
  api,
  clientId,
  authScope,
  getVerifiedAuthScope,
}: {
  sourceConversationId: string;
  api: MitzoApiClient;
  clientId?: string;
  authScope?: string;
  getVerifiedAuthScope(): string | undefined;
}) {
  const owner = useMemo(
    () => ({ api, sourceConversationId, clientId, authScope }),
    [api, sourceConversationId, clientId, authScope],
  );
  const [sourceDisplay, setSourceDisplay] = useState<{ id: string; name: string }>();
  const presentSourceName = useCallback(
    (name: string) => {
      setSourceDisplay((previous) =>
        previous?.id === sourceConversationId && previous.name === name
          ? previous
          : { id: sourceConversationId, name },
      );
    },
    [sourceConversationId],
  );
  const [associationState, setAssociation] = useState<{
    owner: object;
    group?: string;
    begun?: boolean;
    shared?: boolean;
    error?: string;
  }>({ owner });
  const association = associationState.owner === owner ? associationState : { owner };
  const [attempt, setAttempt] = useState(0);
  const [savedDraft, setDraft] = useState<{ owner: object; id: string }>();
  const draftId = savedDraft?.owner === owner ? savedDraft.id : undefined;
  useEffect(() => {
    if (!sourceConversationId || !clientId || !authScope || getVerifiedAuthScope() !== authScope)
      return;
    const controller = new AbortController();
    setAssociation((previous) => ({
      ...(previous.owner === owner ? previous : { owner }),
      error: undefined,
    }));
    void api.collaborations
      .sourceSetup(sourceConversationId, clientId, controller.signal)
      .then((setup) => {
        if (controller.signal.aborted || getVerifiedAuthScope() !== authScope) return;
        if (setup.state === 'unavailable')
          throw Error('This conversation’s collaboration needs review. No new group was created.');
        const key = 'mitzo-shared-begin:' + authScope + ':' + sourceConversationId;
        let group: string;
        if (setup.state === 'selected') group = setup.collaboration.collaborationId;
        else {
          const retained = sessionStorage.getItem(key);
          group = retained ? SessionCollaborationIdSchema.parse(retained) : createBrowserId();
          sessionStorage.setItem(key, group);
          if (sessionStorage.getItem(key) !== group)
            throw Error('Could not retain this collaboration identity.');
        }
        setAssociation({
          owner,
          group,
          begun: setup.state === 'selected',
          shared:
            setup.state === 'selected' &&
            setup.collaboration.participantSessionIds.some((id) => id !== sourceConversationId),
        });
        const id = 'shared:' + group;
        if (!getChatDraft(id)) {
          const draft = createChatDraft();
          if (
            !saveChatDraft({
              ...draft,
              id,
              settings: {
                ...draft.settings,
                collaborationResponders: {
                  collaborationId: group,
                  responders: { kind: 'selected', sessionIds: [sourceConversationId] },
                },
              },
            })
          )
            throw Error('Could not retain this shared draft.');
        }
        setDraft({ owner, id });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setAssociation((previous) => ({
            ...(previous.owner === owner ? previous : { owner }),
            error: cause instanceof Error ? cause.message : 'Collaboration unavailable.',
          }));
      });
    return () => controller.abort();
  }, [owner, api, sourceConversationId, clientId, authScope, getVerifiedAuthScope, attempt]);
  const presentation = useConversationPresentation({
    api: api.collaborations,
    collaborationId: association.begun ? (association.group ?? null) : null,
    authScope,
    getVerifiedAuthScope,
    draftId,
  });
  const view = presentation.projection?.view;
  const refresh = presentation.refresh;
  const joiningOwner = useMemo(() => {
    if (!association.group || !clientId || !authScope || getVerifiedAuthScope() !== authScope)
      return undefined;
    const group = association.group;
    const applicationOwner = createConversationJoiningApplicationOwner({
      api,
      sourceConversationId,
      collaborationId: group,
      getClientId: () => clientId,
      getVerifiedAuthScope,
    });
    return {
      ...applicationOwner,
      async captureReview(...args: Parameters<typeof applicationOwner.captureReview>) {
        // Only this explicit review action begins the relationship; no session or model is allocated.
        if (!association.begun)
          await api.collaborations.begin(
            group,
            CollaborationBeginSchema.parse({ requestId: group, sessionId: sourceConversationId }),
          );
        setAssociation((s) => (s.owner === owner && s.group === group ? { ...s, begun: true } : s));
        return applicationOwner.captureReview(...args);
      },
      async confirm(...args: Parameters<typeof applicationOwner.confirm>) {
        const join = await applicationOwner.confirm(...args);
        void refresh();
        return join;
      },
      async recover(...args: Parameters<typeof applicationOwner.recover>) {
        const join = await applicationOwner.recover(...args);
        void refresh();
        return join;
      },
    };
  }, [
    association.group,
    owner,
    association.begun,
    clientId,
    authScope,
    getVerifiedAuthScope,
    api,
    sourceConversationId,
    refresh,
  ]);
  const names = useMemo(
    () =>
      Object.fromEntries([
        [
          sourceConversationId,
          sourceDisplay?.id === sourceConversationId ? sourceDisplay.name : 'Current agent',
        ],
        ...(view?.joinedParticipants?.map((p) => [p.sessionId, p.name]) ?? []),
      ]),
    [sourceConversationId, sourceDisplay, view?.joinedParticipants],
  );
  const promptContext = useConversationPromptContext({
    api,
    sourceConversationId,
    clientId,
    view,
    responders: presentation.responderIntent,
    draftId,
    authScope,
    getVerifiedAuthScope,
  });
  const forwarding = useConversationForwarding({
    api,
    clientId,
    draftId,
    authScope,
    getVerifiedAuthScope,
    view,
    review: promptContext.review,
    reviewCurrent: promptContext.canAttach,
    refresh: presentation.refresh,
  });
  const sending = useConversationSending({
    api: api.collaborations,
    view,
    responders: presentation.responderIntent,
    draftId,
    authScope,
    getVerifiedAuthScope,
    refresh: presentation.refresh,
    snapshot: promptContext.snapshot,
    contextDisabledReason: promptContext.disabledReason,
    onAccepted: promptContext.consume,
  });
  const sharedMode = useRef({ sourceConversationId, active: false });
  if (sharedMode.current.sourceConversationId !== sourceConversationId)
    sharedMode.current = { sourceConversationId, active: false };
  if (
    association.shared ||
    sending.pending ||
    view?.joins.some((join) => join.state === 'linked') ||
    view?.participantSessionIds.some((id) => id !== sourceConversationId)
  )
    sharedMode.current.active = true;
  // Losing a participant cannot hand a retained operation back to ordinary send.
  const active = sharedMode.current.active;
  const progress = useConversationProgress({
    api: api.collaborations,
    // Existing collaboration observation survives a temporary singleton. Its
    // authorized view still owns later remote joins; active only controls UI.
    view,
    authScope,
    getVerifiedAuthScope,
    refreshTranscript: presentation.observeTranscript,
  });
  return {
    sourceConversationId,
    presentSourceName,
    presentation,
    sending,
    progress,
    promptContext,
    forwarding,
    shareMessage: (messageId: string) => {
      if (promptContext.busy || promptContext.attached || forwarding.retained || sending.pending)
        return;
      promptContext.edit({
        ...promptContext.form,
        mode: 'selected',
        purpose: promptContext.form.purpose || 'Send selected messages',
        messageIds: [...new Set([...promptContext.form.messageIds, messageId])],
        shareRecipientIds: promptContext.form.shareRecipientIds ?? [],
      });
      promptContext.show();
    },
    joiningOwner,
    names,
    active,
    resolving:
      !!sourceConversationId &&
      !!clientId &&
      !!authScope &&
      (!association.group || (association.begun && !view)) &&
      !association.error,
    error: association.error,
    retry: () => {
      // Setup and the retained conversation read have different owners. Repeating
      // unchanged setup does not rerun a failed read of the same collaboration.
      if (association.error) setAttempt((n) => n + 1);
      else void refresh();
    },
  };
}

export function SharedConversationAgents(props: ComponentProps<typeof ConversationAgents>) {
  const host = useContext(Context);
  const presentSourceName =
    host && host.sourceConversationId === props.scope ? host.presentSourceName : undefined;
  const sourceName = props.agents.find((agent) => agent.id === props.scope)?.name;
  useEffect(() => {
    if (sourceName) presentSourceName?.(sourceName);
  }, [presentSourceName, sourceName]);
  if (!host || host.sourceConversationId !== props.scope) return <ConversationAgents {...props} />;
  const { presentation, names } = host;
  const view = presentation.projection?.view;
  const agents = view
    ? view.participantSessionIds.map((id) => {
        const existing = props.agents.find((a) => a.id === id);
        const policy = view.policies.find((p) => p.sessionId === id);
        return {
          ...existing,
          id,
          name: existing?.name ?? names[id] ?? id,
          state: view.unavailableParticipantSessionIds.includes(id)
            ? 'Unavailable'
            : id === props.scope
              ? 'Current conversation'
              : 'Joined',
          policy: policy
            ? { reads: policy.readsFutureDiscussion, replies: policy.repliesByDefault }
            : undefined,
        };
      })
    : props.agents;
  return (
    <ConversationAgents
      {...props}
      agents={agents}
      showParticipantNames={host.active || props.showParticipantNames}
      joiningOwner={host.joiningOwner}
      unavailableReason={host.error}
      policyUnavailableReason={
        presentation.policyDisabled ? 'Refresh discussion sharing before changing it.' : undefined
      }
      policyFeedback={
        presentation.policyError ? <p role="alert">{presentation.policyError}</p> : undefined
      }
      onPolicyChange={
        presentation.policyDisabled
          ? undefined
          : (id, policy) => void presentation.setPolicy(id, policy)
      }
    />
  );
}
export function SharedConversationBody({
  sourceConversationId,
  chat,
  children,
  ordinaryHistory,
  ordinaryComposer,
  beforeTranscript,
  ordinaryTools,
}: {
  sourceConversationId: string;
  chat: ChatAreaProps;
  children: ReactNode;
  ordinaryHistory?: ReactNode;
  ordinaryComposer?: ReactNode;
  beforeTranscript?: ReactNode;
  ordinaryTools?: ReactNode;
}) {
  const host = useContext(Context);
  const [sendFailure, setSendFailure] = useState<string>();
  if (!host || host.sourceConversationId !== sourceConversationId) return children;
  const { presentation, sending, progress, promptContext, forwarding, names } = host;
  const { draft, projection, composerResponders } = presentation;
  const canShare =
    !sending.pending && !promptContext.busy && !promptContext.attached && !forwarding.retained;
  const history =
    isValidElement<ChatAreaProps>(ordinaryHistory) && ordinaryHistory.type === ChatArea
      ? {
          ...ordinaryHistory.props,
          onShareMessage:
            host.active && projection ? host.shareMessage : ordinaryHistory.props.onShareMessage,
          canShareMessage: (message: ChatAreaProps['messages'][number]) =>
            canShare &&
            ordinaryHistory.props.messages.some((m) => m.messageId === message.messageId),
          shareInActions: true,
        }
      : {
          ...chat,
          beforeMessages: (
            <>
              {chat.beforeMessages}
              {ordinaryHistory}
            </>
          ),
        };
  const composer: ComponentProps<typeof ChatInput> = {
    savedChatDraft: draft ?? undefined,
    sessionId: draft?.id,
    textOnly: true,
    tokenOwnerName: names[sourceConversationId] ?? 'Original agent',
    boundedFirstCommand: true,
    guardedConversation: false,
    recipientRecovery: !sending.pending && !presentation.error,
    validateSend: undefined,
    onInterrupt: undefined,
    running: !!sending.pending,
    onStop: () => void sending.stop(),
    collaboration: (
      <ConversationPromptContextButton flow={promptContext} disabled={!!sending.pending} />
    ),
    responders: composerResponders
      ? {
          ...composerResponders,
          iconOnly: true,
          members: composerResponders.members.map((member) => ({
            ...member,
            name: names[member.id] ?? member.name,
          })),
          disabled: !!sending.pending || composerResponders.disabled,
        }
      : undefined,
    sendDisabledReason: presentation.error ?? sending.disabledReason,
    sendDisabledAction: {
      label: sending.pending ? 'Check original request' : 'Refresh conversation',
      onClick: () => {
        if (sending.pending) void sending.check();
        else {
          void presentation.refresh();
          void sending.check();
        }
      },
    },
    onSend: (text, images, context, delivered) => {
      if (images?.length || context?.length || sending.disabledReason) return false;
      setSendFailure(undefined);
      void sending.send(text).then(
        (ok) => delivered?.(ok ? 'accepted' : 'failed'),
        (cause) => {
          setSendFailure(
            cause instanceof Error
              ? cause.message
              : 'Could not send this prompt. Your draft is retained.',
          );
          delivered?.('failed');
        },
      );
      return true;
    },
  };
  // Never move the ordinary input or change its draft/session key on joining.
  // Only this context's dispatch controls change; source.running cannot own them.
  const routing = { ...composer };
  delete routing.savedChatDraft;
  delete routing.sessionId;
  return (
    <SharedConversationComposerContext.Provider
      value={
        host.active
          ? { sourceConversationId, props: routing }
          : host.resolving || host.error
            ? {
                sourceConversationId,
                props: {
                  sendDisabledReason: host.error ?? 'Checking discussion recipients…',
                  sendDisabledAction: host.error
                    ? { label: 'Refresh collaboration', onClick: host.retry }
                    : undefined,
                },
              }
            : null
      }
    >
      {beforeTranscript}
      {ordinaryComposer || ordinaryHistory || host.active ? (
        <CollaborationTranscript
          {...history}
          ordinary={{ ...history, sessionId: sourceConversationId }}
          projection={host.active ? (projection ?? undefined) : undefined}
          progress={progress.progress}
          names={names}
          onRefresh={() => void presentation.refresh()}
        />
      ) : (
        children
      )}
      {ordinaryTools}
      {!host.active && (
        <ChatStatusMessage
          error={host.error ?? (host.joiningOwner ? presentation.error : null) ?? progress.error}
          action={{ label: 'Refresh collaboration', onClick: host.retry }}
        />
      )}
      {forwarding.retained && (
        <ChatStatusMessage
          status={
            forwarding.observation?.state === 'confirmed'
              ? 'Message sharing is recorded.'
              : forwarding.uncertain
                ? 'Message delivery is uncertain. Check the original send.'
                : 'A message send is saved for review.'
          }
          action={{ label: 'Review message delivery', onClick: promptContext.show }}
        />
      )}
      <ConversationPromptContext
        flow={promptContext}
        forwarding={forwarding}
        names={names}
        disabled={!!sending.pending}
        showTrigger={false}
        shareTargets={projection?.view.participantSessionIds.map((id) => ({
          id,
          name: names[id] ?? id,
          unavailable: projection.view.unavailableParticipantSessionIds.includes(id),
        }))}
      />
      {ordinaryComposer ??
        (host.active && draft && (
          <div className="conversation-composer">
            {promptContext.attached && (
              <div className="conversation-joining-context" role="status">
                <small>Reviewed context attached: {promptContext.form.purpose}</small>
                <button
                  type="button"
                  disabled={!!sending.pending || promptContext.busy}
                  onClick={promptContext.remove}
                >
                  Remove prompt context
                </button>
              </div>
            )}
            <ChatInput {...composer} externalContextBlocks={EMPTY_CONTEXT} />
          </div>
        ))}
      {sending.error && <p role="alert">{sending.error}</p>}
      {host.active && progress.error && <p role="alert">{progress.error}</p>}
      {sending.pending && (sending.stopStatus || sending.pending.stopRequested) && (
        <p role="status">
          {sending.stopStatus ?? 'Stop was requested. Check the original request; do not resend.'}
        </p>
      )}
      {sendFailure && <p role="alert">{sendFailure}</p>}
    </SharedConversationComposerContext.Provider>
  );
}
