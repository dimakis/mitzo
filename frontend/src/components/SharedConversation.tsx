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
import { CollaborationApiError, MitzoApiClient } from '@mitzo/client';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import {
  CollaborationBeginSchema,
  ChatImagesSchema,
  SessionCollaborationIdSchema,
  type CollaborationMessage,
  type MessageReplyContext,
} from '@mitzo/protocol';
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
import { useConversationSteering } from '../hooks/useConversationSteering';
import {
  useConversationStopping,
  type ConversationStopTarget,
} from '../hooks/useConversationStopping';
import { ComposerStatusProvider } from './ComposerStatus';
import { useComposerStatusSink } from '../lib/composer-status-context';
import { useConversationProgress } from '../hooks/useConversationProgress';
import { useConversationPromptContext } from '../hooks/useConversationPromptContext';
import { useConversationForwarding } from '../hooks/useConversationForwarding';
import {
  ConversationPromptContext,
  ConversationPromptContextButton,
} from './ConversationPromptContext';
import { ConversationAgents } from './ConversationAgents';
import { CollaborationTranscript } from './CollaborationTranscript';
import { SeatColorProvider } from './SeatColorProvider';
import { ChatInput } from './ChatInput';
import { ChatStatusMessage } from './ChatStatusMessage';
import { ChatArea, type ChatAreaProps } from './ChatArea';
import { useSessionOverview } from '../hooks/useSessionOverview';
import { sessionActivityLabel } from '../lib/session-activity';
import {
  SharedConversationComposerContext,
  type SharedConversationComposerRouting,
} from '../lib/shared-conversation-composer';

const applicationApi = new MitzoApiClient(apiFetch);
const EMPTY_CONTEXT: string[] = [];
type Host = ReturnType<typeof useSharedConversation>;
const Context = createContext<Host | null>(null);
/**
 * A new chat is selected before its durable session row exists, so source setup
 * refuses it as unavailable_recipient until startup completes. Retry that refusal
 * on a bounded schedule (~90s total) instead of holding the transcript and
 * composer behind a permanent error; setup itself stays observational.
 */
const SOURCE_SETUP_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 30000];
const SOURCE_SETUP_UNAVAILABLE_MESSAGE =
  'This conversation is not available for collaboration checks yet. Refresh to check again.';
function sourceSetupStartupRefusal(cause: unknown): boolean {
  return cause instanceof CollaborationApiError && cause.code === 'unavailable_recipient';
}

/** One owner above the responsive screens; resizing does not retire joining or send identity. */
export function OrdinarySharedConversationHost({
  sourceConversationId,
  children,
}: {
  sourceConversationId: string | null;
  children: ReactNode;
}) {
  const clientId = useMitzoStore((s) => s.connection?.clientId) ?? undefined;
  // Absent creation evidence (including partial store projections) keeps the
  // history gate closed.
  const startedHere = useMitzoStore(
    (s) =>
      !!sourceConversationId &&
      (s.startedSession as { id: string } | null | undefined)?.id === sourceConversationId,
  );
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
      startedHere={startedHere}
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
  return (
    <Context.Provider value={value}>
      <SeatColorProvider roster={value.presentation.projection?.view.seatOrder}>
        {children}
      </SeatColorProvider>
    </Context.Provider>
  );
}
function useSharedConversation({
  sourceConversationId,
  api,
  clientId,
  authScope,
  getVerifiedAuthScope,
  startedHere = false,
}: {
  sourceConversationId: string;
  api: MitzoApiClient;
  clientId?: string;
  authScope?: string;
  getVerifiedAuthScope(): string | undefined;
  /** This client created the source conversation by sending from a new chat. */
  startedHere?: boolean;
}) {
  // The association belongs to the conversation and login, not to one transport.
  // A stream reconnect assigns a new client ID and re-checks the source in the
  // background; it must not discard the confirmed association and blank the
  // already-rendered transcript while that check is pending.
  const owner = useMemo(
    () => ({ api, sourceConversationId, authScope }),
    [api, sourceConversationId, authScope],
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
  // A chat this client just created has its collaboration setup refused until
  // the session row persists, but it cannot already be part of a discussion, so
  // its own transcript stays visible meanwhile. Creation is the store's explicit
  // record of a send without a session, never inferred from an id transition:
  // opening an existing chat from an empty view must keep the history gate.
  const startedInView = !!sourceConversationId && startedHere;
  const [associationState, setAssociation] = useState<{
    owner: object;
    group?: string;
    begun?: boolean;
    shared?: boolean;
    historySource?: string;
    ordinaryHistory?: boolean;
    error?: string;
  }>({ owner });
  const association = associationState.owner === owner ? associationState : { owner };
  const [attempt, setAttempt] = useState(0);
  const startupRetries = useRef<{ owner: object; count: number }>({ owner, count: 0 });
  if (startupRetries.current.owner !== owner) startupRetries.current = { owner, count: 0 };
  const [savedDraft, setDraft] = useState<{ owner: object; id: string }>();
  const draftId = savedDraft?.owner === owner ? savedDraft.id : undefined;
  useEffect(() => {
    if (!sourceConversationId || !clientId || !authScope || getVerifiedAuthScope() !== authScope)
      return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setAssociation((previous) => ({
      ...(previous.owner === owner ? previous : { owner }),
      error: undefined,
    }));
    void api.collaborations
      .sourceSetup(sourceConversationId, clientId, controller.signal)
      .then((setup) => {
        if (controller.signal.aborted || getVerifiedAuthScope() !== authScope) return;
        startupRetries.current.count = 0;
        if (setup.state === 'ordinary_history') {
          setAssociation({ owner, ordinaryHistory: true });
          return;
        }
        if (setup.state === 'participant_history') {
          setAssociation({
            owner,
            group: setup.collaboration.collaborationId,
            begun: true,
            historySource: setup.originalConversationId,
          });
          return;
        }
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
        if (controller.signal.aborted) return;
        const retries = startupRetries.current;
        const startupRefusal = sourceSetupStartupRefusal(cause);
        if (
          startupRefusal &&
          retries.owner === owner &&
          retries.count < SOURCE_SETUP_RETRY_DELAYS_MS.length
        ) {
          // Remain resolving: the source is most likely still starting.
          const delay = SOURCE_SETUP_RETRY_DELAYS_MS[retries.count++];
          console.info('Collaboration source setup deferred', {
            code: 'collaboration_source_setup_unavailable',
            stage: 'source_setup',
            sessionId: sourceConversationId,
            retry: retries.count,
            delayMs: delay,
          });
          retryTimer = setTimeout(() => setAttempt((n) => n + 1), delay);
          return;
        }
        console.warn('Collaboration source setup failed', {
          code: startupRefusal
            ? 'collaboration_source_setup_unavailable'
            : 'collaboration_source_setup_failed',
          stage: 'source_setup',
          sessionId: sourceConversationId,
          status: cause instanceof CollaborationApiError ? cause.status : undefined,
          retries: retries.count,
        });
        setAssociation((previous) => ({
          ...(previous.owner === owner ? previous : { owner }),
          error: startupRefusal
            ? SOURCE_SETUP_UNAVAILABLE_MESSAGE
            : cause instanceof Error
              ? cause.message
              : 'Collaboration unavailable.',
        }));
      });
    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
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
    if (
      association.historySource ||
      !association.group ||
      !clientId ||
      !authScope ||
      getVerifiedAuthScope() !== authScope
    )
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
      // Inspection never begins sharing. The existing catalog requires retained membership.
      loadArtifacts: association.begun ? applicationOwner.loadArtifacts : undefined,
      artifactsUnavailableReason: association.begun
        ? undefined
        : 'Retained artifacts are unavailable until this conversation has an existing shared association. Opening starting context does not create one.',
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
    association.historySource,
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
    sharedMessages: presentation.projection
      ? [
          ...(presentation.projection.earlierMessages ?? []),
          ...presentation.projection.view.messages,
        ]
      : undefined,
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
    requestReply: promptContext.form.requestReply,
    requestReplyTo: (ids, note) =>
      sending.send('Please respond to the forwarded message: ' + note, undefined, undefined, ids),
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
  const active = !association.historySource && sharedMode.current.active;
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
    api: api.collaborations,
    authScope,
    getVerifiedAuthScope,
    presentSourceName,
    presentation,
    sending,
    progress,
    promptContext,
    forwarding,
    shareMessage: (messageId: string) => {
      if (promptContext.busy || promptContext.attached || forwarding.retained || sending.pending)
        return;
      const shared = [
        ...(presentation.projection?.earlierMessages ?? []),
        ...(view?.messages ?? []),
      ].find(
        (m) =>
          m.messageId === messageId ||
          m.projectionId === messageId ||
          (m.source?.conversationId === sourceConversationId && m.source.messageId === messageId),
      );
      promptContext.edit({
        ...promptContext.form,
        mode: 'selected',
        purpose: promptContext.form.purpose || 'Send selected messages',
        sourceConversationId: shared ? view!.collaborationId : sourceConversationId,
        messageIds: [shared?.messageId ?? messageId],
        requestReply: false,
        shareRecipientIds: promptContext.form.shareRecipientIds ?? [],
      });
      promptContext.showSource(shared ? view!.collaborationId : sourceConversationId);
    },
    joiningOwner,
    names,
    active,
    historySource: association.historySource,
    resolving:
      !association.ordinaryHistory &&
      !!sourceConversationId &&
      !!clientId &&
      !!authScope &&
      (!association.group || (association.begun && !view)) &&
      !association.error,
    error: association.error,
    // Unanswered setup for a chat started in this view does not hide its transcript.
    provisionalOrdinary: startedInView && !association.group && !association.historySource,
    /** A source check already classified this conversation for the current owner. */
    confirmed: !!association.ordinaryHistory || !!association.group,
    retry: () => {
      // Setup and the retained conversation read have different owners. Repeating
      // unchanged setup does not rerun a failed read of the same collaboration.
      if (association.error) {
        startupRetries.current = { owner, count: 0 };
        setAttempt((n) => n + 1);
      } else void refresh();
    },
  };
}

export function SharedConversationAgents(props: ComponentProps<typeof ConversationAgents>) {
  const host = useContext(Context);
  const { activities } = useSessionOverview();
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
        const activity = activities.find((a) => a.sessionId === id);
        return {
          ...existing,
          id,
          historySessionId: id !== props.scope ? id : undefined,
          name: existing?.name ?? names[id] ?? id,
          state: view.unavailableParticipantSessionIds.includes(id)
            ? 'Unavailable'
            : activity
              ? sessionActivityLabel(activity)
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
      addressedReadingOnly={host.active}
      joiningOwner={host.joiningOwner}
      unavailableReason={
        host.error ?? (host.historySource ? 'Reply in the shared conversation.' : undefined)
      }
      policyUnavailableReason={
        host.historySource
          ? 'Discussion sharing is managed in the shared conversation.'
          : presentation.policyDisabled
            ? 'Refresh discussion sharing before changing it.'
            : undefined
      }
      policyFeedback={
        presentation.policyError ? <p role="alert">{presentation.policyError}</p> : undefined
      }
      onPolicyChange={
        host.historySource || presentation.policyDisabled
          ? undefined
          : (id, policy) => void presentation.setPolicy(id, policy)
      }
    />
  );
}
interface SharedConversationBodyProps {
  sourceConversationId: string;
  chat: ChatAreaProps;
  children: ReactNode;
  ordinaryHistory?: ReactNode;
  ordinaryComposer?: ReactNode;
  beforeTranscript?: ReactNode;
  ordinaryTools?: ReactNode;
}
export function SharedConversationBody(props: SharedConversationBodyProps) {
  const sink = useComposerStatusSink();
  return sink ? (
    <SharedConversationBodyContent {...props} />
  ) : (
    <ComposerStatusProvider>
      <SharedConversationBodyContent {...props} />
    </ComposerStatusProvider>
  );
}
function SharedConversationBodyContent({
  sourceConversationId,
  chat,
  children,
  ordinaryHistory,
  ordinaryComposer,
  beforeTranscript,
  ordinaryTools,
}: SharedConversationBodyProps) {
  const host = useContext(Context);
  const [sendFailure, setSendFailure] = useState<string>();
  const [reply, setReply] = useState<{ source: string; value: MessageReplyContext | null }>();
  const view = host?.presentation.projection?.view;
  const originalHistory =
    isValidElement<ChatAreaProps>(ordinaryHistory) && ordinaryHistory.type === ChatArea
      ? ordinaryHistory.props
      : chat;
  const selectedIds = host?.presentation.resolvedResponderIds ?? [];
  const stopTargets = new Map<string, ConversationStopTarget>();
  const commands = new Map<string, string>();
  for (const message of [
    ...(host?.presentation.projection?.earlierMessages ?? []),
    ...(view?.messages ?? []),
  ])
    for (const delivery of message.deliveries) {
      if (
        delivery.purpose === 'reply' &&
        delivery.commandId &&
        !['completed', 'failed', 'interrupted'].includes(delivery.outcome ?? '')
      ) {
        if (!stopTargets.has(delivery.sessionId))
          stopTargets.set(delivery.sessionId, {
            messageId: message.messageId,
            deliveryId: delivery.deliveryId,
            sessionId: delivery.sessionId,
            commandId: delivery.commandId,
            name: host?.names[delivery.sessionId] ?? 'Agent',
          });
        if (delivery.status === 'delivered' && !commands.has(delivery.sessionId))
          commands.set(delivery.sessionId, delivery.commandId);
      }
    }
  let originalCommand: string | undefined;
  if (originalHistory.running) {
    for (let index = originalHistory.messages.length - 1; index >= 0; index--) {
      const message = originalHistory.messages[index];
      if (message.role === 'user' && message.commandState === 'running') {
        originalCommand = message.messageId;
        break;
      }
    }
  }
  if (originalCommand) commands.set(sourceConversationId, originalCommand);
  const steeringTargets = selectedIds.flatMap((sessionId) => {
    const commandId = commands.get(sessionId);
    return commandId ? [{ sessionId, commandId, name: host?.names[sessionId] ?? 'Agent' }] : [];
  });
  const steering = useConversationSteering({
    group: host?.active ? view?.collaborationId : undefined,
    authScope: host?.authScope,
    getVerifiedAuthScope: host?.getVerifiedAuthScope ?? (() => undefined),
    memberIds: view?.participantSessionIds ?? [],
    targets: steeringTargets,
  });
  const stopping = useConversationStopping({
    api: host?.api ?? applicationApi.collaborations,
    group: host?.active ? view?.collaborationId : undefined,
    authScope: host?.authScope,
    getVerifiedAuthScope: host?.getVerifiedAuthScope ?? (() => undefined),
    membershipRevision: view?.membershipRevision,
    memberIds: view?.participantSessionIds ?? [],
    targets: selectedIds.flatMap((id) => (stopTargets.get(id) ? [stopTargets.get(id)!] : [])),
  });
  if (!host || host.sourceConversationId !== sourceConversationId) return children;
  const { presentation, sending, progress, promptContext, forwarding, names } = host;
  const { draft, projection, composerResponders } = presentation;
  // This route inspects one existing participant's provider history. Canonical
  // prompts replace its native packets without importing other agents' replies.
  const forHistory = (message: CollaborationMessage) =>
    message.author === 'operator'
      ? message.deliveries.some((delivery) => delivery.sessionId === sourceConversationId)
      : message.source?.conversationId === sourceConversationId;
  const displayedProjection =
    host.historySource && projection
      ? {
          ...projection,
          earlierMessages: projection.earlierMessages?.filter(forHistory),
          view: {
            ...projection.view,
            participantSessionIds: [sourceConversationId],
            messages: projection.view.messages.filter(forHistory),
          },
        }
      : projection;
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
            (ordinaryHistory.props.messages.some((m) => m.messageId === message.messageId) ||
              [...(projection?.earlierMessages ?? []), ...(view?.messages ?? [])].some(
                (m) => m.projectionId === message.messageId,
              )),
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
  if (host.active) history.onReply = (value) => setReply({ source: sourceConversationId, value });
  const replySourceAuthor = reply?.value
    ? [...(projection?.earlierMessages ?? []), ...(view?.messages ?? [])].find(
        (m) => m.projectionId === reply.value?.messageId,
      )?.author
    : undefined;
  const composer: ComponentProps<typeof ChatInput> = {
    ...(reply?.source === sourceConversationId
      ? {
          replyTarget: reply.value ?? undefined,
          replyAuthor:
            replySourceAuthor && replySourceAuthor !== 'operator'
              ? names[replySourceAuthor.sessionId]
              : undefined,
          onClearReply: () => setReply({ source: sourceConversationId, value: null }),
        }
      : {}),
    savedChatDraft: draft ?? undefined,
    sessionId: draft?.id,
    textOnly: false,
    tokenOwnerName: names[sourceConversationId] ?? 'Original agent',
    tokenParticipants: view?.participantSessionIds.map((id) => ({
      id,
      name: names[id] ?? 'Agent',
      unavailable: view.unavailableParticipantSessionIds.includes(id),
    })),
    boundedFirstCommand: true,
    guardedConversation: false,
    recipientRecovery: !sending.pending && !presentation.error,
    validateSend: undefined,
    targetedSteering: true,
    sharedControl: {
      label: selectedIds.map((id) => names[id] ?? 'Agent').join(', ') || 'selected agents',
      sourceSelected: selectedIds.includes(sourceConversationId),
      sourceHandled:
        !!originalCommand && stopTargets.get(sourceConversationId)?.commandId === originalCommand,
    },
    interruptLabel: 'Steer current turn',
    interruptDisabledReason:
      steering.reason ??
      (steeringTargets.length !== selectedIds.length
        ? 'Select agents with active turns before steering.'
        : undefined),
    onInterrupt: (text, images, _context, delivered) => {
      void steering.steer(text, images).then(
        (accepted) => delivered?.(accepted ? 'accepted' : 'failed'),
        () => {
          setSendFailure('Steering could not be prepared. Your draft is retained.');
          delivered?.('failed');
        },
      );
    },
    running: selectedIds.some((id) => stopTargets.has(id)) || !!sending.pending,
    onStop: () => {
      void stopping
        .stop()
        .then(() => presentation.refresh())
        .catch(() =>
          setSendFailure('Stop recovery could not be checked. Keep the original request.'),
        );
      const unresolved = selectedIds.filter((id) => !stopTargets.has(id));
      if (unresolved.length) void sending.stop(unresolved);
    },
    collaboration: (
      <ConversationPromptContextButton flow={promptContext} disabled={!!sending.pending} />
    ),
    responders: composerResponders
      ? {
          ...composerResponders,
          inline: true,
          iconOnly: true,
          members: composerResponders.members.map((member) => ({
            ...member,
            name: names[member.id] ?? member.name,
          })),
          disabled: composerResponders.disabled,
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
    onSend: (text, images, context, delivered, _assigned, _draft, replyTo) => {
      if (context?.length || sending.disabledReason) return false;
      const attachments = ChatImagesSchema.safeParse(
        images?.map(({ data, mediaType }) => ({ data, mediaType })) ?? [],
      );
      if (!attachments.success) {
        setSendFailure(
          'These images could not be sent. Use supported image attachments within the size limit. Your draft is retained.',
        );
        delivered?.('failed');
        return false;
      }
      setSendFailure(undefined);
      const replySource = replyTo
        ? [...(projection?.earlierMessages ?? []), ...(view?.messages ?? [])].find(
            (m) =>
              m.projectionId === replyTo.messageId ||
              (m.source?.conversationId === sourceConversationId &&
                m.source.messageId === replyTo.messageId),
          )
        : undefined;
      if (replyTo && !replySource) {
        setSendFailure(
          'The original reply source is unavailable. Refresh the discussion or remove the reply quote.',
        );
        return false;
      }
      void sending
        .send(text, attachments.data.length ? attachments.data : undefined, replySource?.messageId)
        .then(
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
  const surface = (
    <>
      {beforeTranscript}
      {ordinaryComposer || ordinaryHistory || host.active ? (
        <CollaborationTranscript
          {...history}
          ordinary={{
            ...history,
            sessionId: sourceConversationId,
            // Only an unclassified source defers its ordinary history. A re-check or
            // transient failure after a confirmed check keeps the rendered transcript;
            // its error remains visible on the composer with a Refresh action. A chat
            // just created in this view cannot already be in a discussion.
            ...(!projection &&
            (host.active ||
              host.historySource ||
              ((host.resolving || (host.error && !host.confirmed)) && !host.provisionalOrdinary))
              ? {
                  messages: [],
                  current: null,
                  currentByMessage: {},
                  // Deferred history is a loading state, not a transcript of cards only.
                  launchRequests: [],
                  beforeMessages: (
                    <p className="conversation-replay-status">
                      Checking retained discussion history…
                    </p>
                  ),
                }
              : {}),
          }}
          projection={
            host.active || host.historySource ? (displayedProjection ?? undefined) : undefined
          }
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
          error={
            host.error ??
            (host.joiningOwner || host.historySource ? presentation.error : null) ??
            progress.error
          }
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
      <ChatStatusMessage error={sending.error} />
      {host.active && (
        <ChatStatusMessage
          error={progress.error}
          action={{ label: 'Refresh conversation', onClick: () => void presentation.refresh() }}
        />
      )}
      {sending.pending && (sending.stopStatus || sending.pending.stopRequested) && (
        <ChatStatusMessage
          status={
            sending.stopStatus ?? 'Stop was requested. Check the original request; do not resend.'
          }
        />
      )}
      <ChatStatusMessage error={sendFailure} />
      <ChatStatusMessage
        status={
          steering.message ??
          (steering.pending ? 'A correction needs its original receipt checked.' : undefined)
        }
        action={
          steering.pending
            ? {
                label: 'Check original correction',
                onClick: () => void steering.check(),
                disabled: steering.busy,
              }
            : undefined
        }
      >
        {steering.outcomes.length > 0 && (
          <details className="conversation-delivery-details">
            <summary>Agent correction results</summary>
            <ul>
              {steering.outcomes.map((target) => (
                <li key={target.sessionId}>
                  {target.name}:{' '}
                  {target.status === 'stale_target' ? 'Turn finished' : target.status}
                </li>
              ))}
            </ul>
          </details>
        )}
      </ChatStatusMessage>
      <ChatStatusMessage
        status={
          stopping.message ??
          (stopping.pending ? 'A Stop request needs its original receipt checked.' : undefined)
        }
        action={
          stopping.pending
            ? {
                label: 'Check original Stop',
                onClick: () => void stopping.check(),
                disabled: stopping.busy,
              }
            : undefined
        }
      >
        {stopping.outcomes.length > 0 && (
          <details className="conversation-delivery-details">
            <summary>Agent Stop results</summary>
            <ul>
              {stopping.outcomes.map((record) => (
                <li key={record.input.requestId}>
                  {record.name}: {record.status}
                </li>
              ))}
            </ul>
          </details>
        )}
      </ChatStatusMessage>
    </>
  );
  return (
    <ConversationBodyRouting
      sessionId={sourceConversationId}
      originalConversationId={host.historySource}
      routing={
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
      {surface}
    </ConversationBodyRouting>
  );
}

/** Qualified inspection keeps the existing history/draft owner but cannot
 * dispatch to a participant through this relationship-selection route. */
function ConversationBodyRouting({
  children,
  ...props
}: {
  sessionId: string;
  originalConversationId?: string;
  routing: SharedConversationComposerRouting;
  children: ReactNode;
}) {
  const routed = useInRouterContext();
  // Legacy embedded consumers need no router for their ordinary controls. A
  // qualified history relation still cannot turn that fallback into send authority.
  if (!routed)
    return (
      <SharedConversationComposerContext.Provider
        value={
          props.originalConversationId
            ? {
                sourceConversationId: props.sessionId,
                props: {
                  onSend: () => false,
                  onInterrupt: undefined,
                  sendDisabledReason: 'Open the shared conversation from Chats to reply.',
                },
              }
            : props.routing
        }
      >
        {children}
      </SharedConversationComposerContext.Provider>
    );
  return <RoutedConversationBodyRouting {...props}>{children}</RoutedConversationBodyRouting>;
}
function RoutedConversationBodyRouting({
  sessionId,
  originalConversationId,
  routing,
  children,
}: {
  sessionId: string;
  originalConversationId?: string;
  routing: SharedConversationComposerRouting;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <SharedConversationComposerContext.Provider
      value={
        originalConversationId
          ? {
              sourceConversationId: sessionId,
              props: {
                onSend: () => false,
                onInterrupt: undefined,
                sendDisabledReason:
                  'This is the agent’s retained history. Reply in the shared conversation.',
                sendDisabledAction: {
                  label: 'Open shared conversation',
                  onClick: () => navigate('/chat/' + encodeURIComponent(originalConversationId)),
                },
              },
            }
          : routing
      }
    >
      {children}
    </SharedConversationComposerContext.Provider>
  );
}
