import {
  createContext,
  useContext,
  useEffect,
  useMemo,
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
import { ConversationAgents } from './ConversationAgents';
import { CollaborationTranscript } from './CollaborationTranscript';
import { ChatInput } from './ChatInput';
import { ChatStatusMessage } from './ChatStatusMessage';
import type { ChatAreaProps } from './ChatArea';

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
  const [associationState, setAssociation] = useState<{
    owner: object;
    group?: string;
    begun?: boolean;
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
        setAssociation({ owner, group, begun: setup.state === 'selected' });
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
                  responders: { kind: 'selected', sessionIds: [] },
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
        [sourceConversationId, 'Current agent'],
        ...(view?.joinedParticipants?.map((p) => [p.sessionId, p.name]) ?? []),
      ]),
    [sourceConversationId, view?.joinedParticipants],
  );
  const sending = useConversationSending({
    api: api.collaborations,
    view,
    responders: presentation.responderIntent,
    draftId,
    authScope,
    getVerifiedAuthScope,
    refresh: presentation.refresh,
  });
  const active = !!view?.participantSessionIds.some((id) => id !== sourceConversationId);
  const progress = useConversationProgress({
    api: api.collaborations,
    view: active ? view : undefined,
    authScope,
    getVerifiedAuthScope,
    refreshTranscript: presentation.observeTranscript,
  });
  return {
    sourceConversationId,
    presentation,
    sending,
    progress,
    joiningOwner,
    names,
    active,
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
}: {
  sourceConversationId: string;
  chat: ChatAreaProps;
  children: ReactNode;
  ordinaryHistory?: ReactNode;
  ordinaryComposer?: ReactNode;
}) {
  const host = useContext(Context);
  const [sendFailure, setSendFailure] = useState<string>();
  if (!host || host.sourceConversationId !== sourceConversationId) return children;
  if (!host.active)
    return (
      <>
        {children}
        <ChatStatusMessage
          error={host.error ?? (host.joiningOwner ? host.presentation.error : null)}
          action={{ label: 'Refresh collaboration', onClick: host.retry }}
        />
      </>
    );
  const { presentation, sending, progress, names } = host;
  const { draft, projection, composerResponders } = presentation;
  return (
    <>
      {ordinaryHistory ?? children}
      {projection && (
        <CollaborationTranscript
          {...chat}
          scrollRef={undefined}
          current={null}
          currentByMessage={{}}
          running={false}
          permission={null}
          onPermissionRespond={() => {}}
          projection={projection}
          progress={progress.progress}
          names={names}
          beforeMessages={undefined}
          afterMessages={undefined}
          onRefresh={() => void presentation.refresh()}
        />
      )}
      {chat.running && ordinaryComposer
        ? ordinaryComposer
        : draft && (
            <div className="conversation-composer">
              <ChatInput
                savedChatDraft={draft}
                sessionId={draft.id}
                textOnly
                boundedFirstCommand
                externalContextBlocks={EMPTY_CONTEXT}
                running={!!sending.pending}
                onStop={() => void sending.stop()}
                collaboration={<></>}
                responders={
                  composerResponders
                    ? {
                        ...composerResponders,
                        members: composerResponders.members.map((member) => ({
                          ...member,
                          name: names[member.id] ?? member.name,
                        })),
                        disabled: !!sending.pending,
                      }
                    : undefined
                }
                sendDisabledReason={presentation.error ?? sending.disabledReason}
                sendDisabledAction={{
                  label: sending.pending ? 'Check original request' : 'Refresh conversation',
                  onClick: () => {
                    void presentation.refresh();
                    void sending.check();
                  },
                }}
                onSend={(text, images, context, delivered) => {
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
                }}
              />
            </div>
          )}
      {sending.error && <p role="alert">{sending.error}</p>}
      {progress.error && <p role="alert">{progress.error}</p>}
      {sending.pending && (sending.stopStatus || sending.pending.stopRequested) && (
        <p role="status">
          {sending.stopStatus ?? 'Stop was requested. Check the original request; do not resend.'}
        </p>
      )}
      {sendFailure && <p role="alert">{sendFailure}</p>}
    </>
  );
}
