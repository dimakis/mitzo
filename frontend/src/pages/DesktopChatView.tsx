import { useExplicitLocalChat } from '../hooks/useExplicitLocalChat';
import { ChatExecutionPicker } from '../components/ChatExecutionPicker';
import { buildLocalFirstCommand } from '../lib/explicit-local-chat';
import { createBrowserId } from '../lib/browser-crypto';
import { useNewChatDraft, useChatDraftSearch } from '../hooks/useNewChatDraft';
import { CHAT_DRAFTS_CHANGED, getChatDraft, chatDraftStorageKey } from '../lib/chat-drafts';
import { useBriefingChat } from '../hooks/useBriefingChat';
import { BriefingChatBanner } from '../components/BriefingChatBanner';
import { ChatAgentProfilePicker } from '../components/ChatAgentProfilePicker';
import type { AgentProfileSelection } from '@mitzo/protocol';
import { UiIcon } from '../components/UiIcon';
import {
  savedRepositoryDraft,
  repositoryDraftKey,
  consumeRepositoryDraft,
  repositoryPromptDraftKey,
} from '../lib/repository-draft';
import {
  RepositoryChatPicker,
  type RepositoryChatSelection,
} from '../components/RepositoryChatPicker';
import { usePendingLaunch } from '../hooks/usePendingLaunch';
import {
  useRepositoryChatPreparation,
  repositoryChatSendDisabledReason,
} from '../hooks/useRepositoryChatPreparation';
import { RepositoryChatDraftNotice } from '../components/RepositoryChatDraftNotice';
import { SymposiumReviewEntry } from '../components/SymposiumReviewPanel';
import { AddAgentSheet } from '../components/AddReviewerSheet';
import { PermissionModePicker } from '../components/PermissionModePicker';
import { SessionAccess } from '../components/SessionAccess';
import { WorkspaceControls } from '../components/WorkspaceControls';
import type { WorkspaceSummary } from '../types/workspace';
import { AccountModelPicker, type AccountSelection } from '../components/AccountModelPicker';
import { CodexQueueStatus } from '../components/CodexQueueStatus';
import { WebSearchConsent } from '../components/WebSearchConsent';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { DesktopShell } from '../components/DesktopShell';
import { SessionPanel } from '../components/SessionPanel';
import { CommandCenter } from '../components/CommandCenter';
import { SymposiumConversation } from '../components/SymposiumConversation';
import { SymposiumDirectorPanel } from '../components/SymposiumDirectorPanel';
import { ChatInput, type ChatInputDraftControl } from '../components/ChatInput';
import { ScrollFab } from '../components/ScrollFab';
import { StatusBar } from '../components/StatusBar';
import { VoiceSettings } from '../components/VoiceSettings';
import { useMessages, useConnection, useTokens, useMitzoStore } from '@mitzo/client/hooks';
import { LAST_SESSION_KEY } from '../lib/constants';
import { getPreferredModel, setPreferredModel } from '../lib/model-preference';
import { useVoice } from '../hooks/useVoice';
import { useProgressByToolId } from '../hooks/useProgress';
import type { ImageAttachment } from '../types/chat';

export function DesktopChatView() {
  const [profileToolsTarget, setProfileToolsTarget] = useState<HTMLDivElement | null>(null);
  const { sessionId } = useParams<{ sessionId?: string }>();
  const searchParams = useChatDraftSearch(!sessionId);
  const [agentProfile, setAgentProfile] = useState<AgentProfileSelection | null>(null);
  const [agentProfileBlocked, setAgentProfileBlocked] = useState<string | undefined>();
  const onAgentProfileChange = useCallback(
    (selection: AgentProfileSelection | null, reason?: string) => {
      setAgentProfile(selection);
      setAgentProfileBlocked(reason);
    },
    [],
  );
  const navigate = useNavigate();

  // Store state
  const messages = useMessages();
  const sendError = useMitzoStore((s) => s.sendError);
  const sendStatus = useMitzoStore((s) => s.sendStatus);
  const historyLoading = useMitzoStore((s) => s.historyLoading);
  const historyError = useMitzoStore((s) => s.historyError);
  const connection = useConnection();
  const tokens = useTokens();
  const activeSessionId = useMitzoStore((s) => s.sessions.active);
  const briefingChat = useBriefingChat(activeSessionId);
  const preparationId = searchParams.get('repositoryPreparation');
  const repositoryHandoff = useRepositoryChatPreparation(preparationId, sessionId);
  const repositoryDraftControl = useRef<ChatInputDraftControl | null>(null);
  const modeChangeReady = useMitzoStore((s) => s.modeChangeReady);

  // Select individual action functions — stable references, no new-object trap
  const storeInterruptMessage = useMitzoStore((s) => s.interruptMessage);
  const storeStopGeneration = useMitzoStore((s) => s.stopGeneration);
  const storeRespondToPermission = useMitzoStore((s) => s.respondToPermission);
  const storeExpirePermission = useMitzoStore((s) => s.expirePermission);
  const storeSwitchSession = useMitzoStore((s) => s.switchSession);
  const chatDraftRevision = useMitzoStore((s) => s.chatDraftRevision);
  const storeNewSession = useMitzoStore((s) => s.newSession);
  const storeCloseSession = useMitzoStore((s) => s.closeSession);
  const storeSetMode = useMitzoStore((s) => s.setMode);
  const storeSetModel = useMitzoStore((s) => s.setModel);
  const connectionId = useMitzoStore((s) => s.connection.clientId);
  const storeFetchSessionMeta = useMitzoStore((s) => s.fetchSessionMeta);
  const sessionContext = useMitzoStore((s) => s.messages.sessionContext);
  const bootContext = useMitzoStore((s) => s.messages.bootContext);
  const progressByToolId = useProgressByToolId();

  const {
    launch,
    launchSending,
    dismissLaunch,
    sendMessage: storeSendMessage,
    sendLaunch,
    registrationError,
    registrationSaving,
    retryRegistration,
  } = usePendingLaunch();

  const draftEnabled = !sessionId && !activeSessionId && !repositoryHandoff.present && !launch;
  const newChatDraft = useNewChatDraft(searchParams.get('draft'), chatDraftRevision, draftEnabled);
  const localCommand = useMitzoStore((s) => s.localCommand);
  const localTransportAvailable = useMitzoStore((s) => s.localFirstCommandTransportAvailable);
  const sendLocalFirstCommand = useMitzoStore((s) => s.sendLocalFirstCommand);
  const recoverLocalCommand = useMitzoStore((s) => s.recoverLocalCommand);
  const localRuntime = useExplicitLocalChat(
    newChatDraft.draft.id,
    newChatDraft.draft.settings.runtimeSelection,
    activeSessionId,
    !launch && !repositoryHandoff.present,
    searchParams.toString(),
  );
  const explicitNew = localRuntime.visible && !activeSessionId;
  const localBound =
    localRuntime.bound || (!!activeSessionId && localCommand?.sessionId === activeSessionId);
  const localFirstCommand = explicitNew && localRuntime.selectedLocal;

  const missingDraftReason = newChatDraft.missing
    ? 'This draft is unavailable. Open Drafts or start a new chat.'
    : undefined;
  const draftSearch = new URLSearchParams(searchParams);
  draftSearch.delete('draft');
  draftSearch.delete('prompt');
  const settingsSearch = draftSearch.toString();

  const connected = connection.status === 'connected';

  // Local model state — persisted to localStorage, sent in payload
  const [summaryForSession, setSummaryForSession] = useState<{
    sessionId: string | null;
    summary: WorkspaceSummary | null;
  } | null>(null);
  const workspaceSummary =
    summaryForSession?.sessionId === (activeSessionId ?? newChatDraft.draft.id)
      ? summaryForSession.summary
      : null;
  const setWorkspaceSummary = useCallback(
    (summary: WorkspaceSummary | null) => {
      setSummaryForSession({ sessionId: activeSessionId ?? newChatDraft.draft.id, summary });
    },
    [activeSessionId, newChatDraft.draft.id],
  );
  const isSymposium = workspaceSummary?.sessionType === 'symposium';
  const ordinaryControls = !activeSessionId || workspaceSummary?.sessionType === 'chat';
  const accountScope = !sessionId && !activeSessionId ? newChatDraft.draft.id : activeSessionId;
  const [accountChoice, setAccountChoice] = useState<{
    scope: string | null;
    selection: AccountSelection | null;
  } | null>(null);
  const accountSelection = explicitNew
    ? localRuntime.intent.account
    : accountChoice?.scope === accountScope
      ? accountChoice.selection
      : null;
  const [stagedAccountChoice, setStagedAccountChoice] = useState<{
    scope: string | null;
    selection: AccountSelection;
  } | null>(null);
  const stagedAccountSelection =
    stagedAccountChoice?.scope === accountScope ? stagedAccountChoice.selection : null;
  const saveStagedAccount = useCallback(
    (selection: AccountSelection) => {
      setStagedAccountChoice({ scope: accountScope, selection });
    },
    [accountScope],
  );
  const retainedDraftAccount = useRef<{ scope: string | null; selection: AccountSelection | null }>(
    { scope: accountScope, selection: newChatDraft.draft.settings.selection },
  );
  if (retainedDraftAccount.current.scope !== accountScope)
    retainedDraftAccount.current = {
      scope: accountScope,
      selection: newChatDraft.draft.settings.selection,
    };
  if (accountSelection) retainedDraftAccount.current.selection = accountSelection;
  const repositoryAccountSelection = draftEnabled
    ? (accountSelection ?? stagedAccountSelection ?? retainedDraftAccount.current.selection)
    : accountSelection;
  const repositoryScope = `${repositoryHandoff.present ? repositoryHandoff.scope : newChatDraft.draft.id}:${chatDraftRevision}:${repositoryAccountSelection?.accountId ?? ''}:${repositoryAccountSelection?.model ?? ''}`;
  const [repositoryChoice, setRepositoryChoice] = useState<{
    scope: string;
    selection: RepositoryChatSelection | null;
  } | null>(null);
  const [repositoryAccountError, setRepositoryAccountError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const repositoryAccountReason =
    repositoryAccountError?.scope === newChatDraft.draft.id
      ? repositoryAccountError.message
      : undefined;
  const [removedRepositoryScope, setRemovedRepositoryScope] = useState<string | null>(null);
  const initialRepositoryId =
    draftEnabled && removedRepositoryScope !== newChatDraft.draft.id
      ? newChatDraft.draft.settings.repositoryWorkspaceId
      : undefined;
  const repositorySelection =
    repositoryChoice?.scope === repositoryScope
      ? repositoryChoice.selection
      : repositoryHandoff.present
        ? { blocked: true }
        : draftEnabled
          ? initialRepositoryId
            ? { blocked: true, repositoryWorkspaceId: initialRepositoryId }
            : null
          : accountSelection?.accountId &&
              savedRepositoryDraft(accountSelection.accountId, accountSelection.model)
            ? { blocked: true }
            : null;
  const repositoryHandoffReason =
    (repositoryHandoff.present && (messages.running || sendStatus)
      ? 'Waiting for repository conversation confirmation…'
      : undefined) ??
    repositoryChatSendDisabledReason(
      repositoryHandoff,
      activeSessionId,
      accountSelection,
      repositorySelection,
    );

  const [modelState, setModelState] = useState(getPreferredModel);
  const setModel = useCallback(
    (id: string) => {
      setModelState(id);
      setPreferredModel(id);
      storeSetModel(id);
    },
    [storeSetModel],
  );

  const restoredRepositoryBinding = useRef<string | null>(null);
  const selectAccount = useCallback(
    (selection: AccountSelection | null) => {
      if (repositoryHandoff.present && activeSessionId) return;
      const binding = repositoryAccountSelection ?? newChatDraft.draft.settings.selection;
      if (
        draftEnabled &&
        repositorySelection?.repositoryWorkspaceId &&
        selection &&
        binding &&
        (binding.accountId !== selection.accountId || binding.model !== selection.model)
      ) {
        setRepositoryAccountError({
          scope: newChatDraft.draft.id,
          message: 'Remove the repository preparation before changing account or model.',
        });
        return;
      }
      if (selection) setRepositoryAccountError(null);
      setAccountChoice({ scope: accountScope, selection });
      if (selection) {
        if (
          !!launch?.briefing ||
          briefingChat.selectionLocked ||
          repositoryHandoff.present ||
          (activeSessionId !== null &&
            activeSessionId === repositoryHandoff.lastAssignedConversationId &&
            restoredRepositoryBinding.current !== activeSessionId)
        ) {
          // Preserve browser defaults once while the assigned binding hydrates.
          // Later explicit model choices use the ordinary preference path.
          if (!repositoryHandoff.present) restoredRepositoryBinding.current = activeSessionId;
          setModelState(selection.model);
          storeSetModel(selection.model);
        } else setModel(selection.model);
      }
    },
    [
      accountScope,
      repositoryAccountSelection,
      draftEnabled,
      newChatDraft.draft,
      repositorySelection?.repositoryWorkspaceId,
      setModel,
      storeSetModel,
      activeSessionId,
      repositoryHandoff.present,
      repositoryHandoff.lastAssignedConversationId,
      launch?.briefing,
      briefingChat.selectionLocked,
    ],
  );

  const storeMode = useMitzoStore((s) => s.config.mode);
  const initialDraftMode = newChatDraft.restored
    ? newChatDraft.draft.settings.mode
    : searchParams.get('extraTools')
      ? 'auto'
      : storeMode;
  const [draftOptions, setDraftOptions] = useState({
    id: newChatDraft.draft.id,
    mode: initialDraftMode,
    isolation: newChatDraft.restored ? newChatDraft.draft.settings.isolation : true,
  });
  const mode = !draftEnabled
    ? storeMode
    : draftOptions.id === newChatDraft.draft.id
      ? draftOptions.mode
      : initialDraftMode;
  const isolation =
    draftOptions.id === newChatDraft.draft.id
      ? draftOptions.isolation
      : newChatDraft.restored
        ? newChatDraft.draft.settings.isolation
        : true;
  const setIsolation = useCallback(
    (value: boolean | ((old: boolean) => boolean)) => {
      setDraftOptions({
        id: newChatDraft.draft.id,
        mode,
        isolation: typeof value === 'function' ? value(isolation) : value,
      });
    },
    [newChatDraft.draft.id, mode, isolation],
  );
  const restoredOptionsScope = useRef<string | null>(null);
  useEffect(() => {
    if (!draftEnabled || restoredOptionsScope.current === newChatDraft.draft.id) return;
    restoredOptionsScope.current = newChatDraft.draft.id;
    setDraftOptions({ id: newChatDraft.draft.id, mode: initialDraftMode, isolation });
    if (initialDraftMode !== storeMode && modeChangeReady !== false) storeSetMode(initialDraftMode);
  }, [
    newChatDraft.draft.id,
    draftEnabled,
    initialDraftMode,
    isolation,
    storeMode,
    modeChangeReady,
    storeSetMode,
  ]);
  const savedChatDraft = useMemo(
    () =>
      draftEnabled && !newChatDraft.missing
        ? {
            ...newChatDraft.draft,
            settings: {
              runtimeSelection: explicitNew
                ? localRuntime.intent
                : newChatDraft.draft.settings.runtimeSelection,
              selection: explicitNew
                ? localRuntime.intent.account
                : (repositoryAccountSelection ?? newChatDraft.draft.settings.selection),
              summary: workspaceSummary ?? newChatDraft.draft.settings.summary,
              mode,
              isolation,
              repositoryWorkspaceId: repositorySelection?.repositoryWorkspaceId ?? null,
              search: settingsSearch,
            },
          }
        : undefined,
    [
      draftEnabled,
      newChatDraft.draft,
      newChatDraft.missing,
      repositoryAccountSelection,
      workspaceSummary,
      mode,
      isolation,
      repositorySelection?.repositoryWorkspaceId,
      explicitNew,
      localRuntime.intent,
      settingsSearch,
    ],
  );
  const saveDraftSettings = newChatDraft.saveSettings;
  useEffect(() => {
    if (savedChatDraft) saveDraftSettings(savedChatDraft.settings);
  }, [savedChatDraft, saveDraftSettings]);
  const releaseDraftReference = newChatDraft.releaseReference;
  useEffect(() => {
    if (!draftEnabled || newChatDraft.missing) return;
    const retainUrl = () => {
      const saved = getChatDraft(newChatDraft.draft.id);
      const referencedId = searchParams.get('draft');
      if (saved && referencedId === newChatDraft.draft.id) return;
      if (!saved && referencedId !== newChatDraft.draft.id) return;
      const params = new URLSearchParams(searchParams);
      if (saved) params.set('draft', newChatDraft.draft.id);
      else {
        // An emptied draft has no persistent owner. Keep this mounted composer’s
        // settings, but reload must open a blank chat rather than a missing ID.
        releaseDraftReference();
        params.delete('draft');
        params.delete('prompt');
      }
      const query = params.toString();
      navigate(`/chat${query ? `?${query}` : ''}`, { replace: true });
    };
    retainUrl();
    window.addEventListener(CHAT_DRAFTS_CHANGED, retainUrl);
    return () => window.removeEventListener(CHAT_DRAFTS_CHANGED, retainUrl);
  }, [
    draftEnabled,
    newChatDraft.draft.id,
    newChatDraft.missing,
    searchParams,
    navigate,
    releaseDraftReference,
  ]);

  const voice = useVoice();
  const scrollRef = useRef<HTMLDivElement>(null);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  const awaitingNewSession = useRef(false);
  const clearedSessionId = useRef<string | null>(null);
  const resetFailedDraftOnMount = useRef(
    !sessionId && !activeSessionId && !messages.running && messages.messages.length > 0,
  );

  // Sync route param → store session
  useEffect(() => {
    awaitingNewSession.current = !sessionId;
    clearedSessionId.current = !sessionId ? activeSessionId : null;
    if (sessionId && sessionId !== activeSessionId) {
      storeSwitchSession(sessionId);
    } else if (
      !sessionId &&
      (preparationId !== null || activeSessionId || resetFailedDraftOnMount.current)
    ) {
      storeNewSession();
    }
  }, [sessionId, preparationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist active session to localStorage
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem(LAST_SESSION_KEY, activeSessionId);
    }
  }, [activeSessionId]);

  // Navigate away when session expires (store clears active while route still has :id)
  const hadSession = useRef(false);
  useEffect(() => {
    if (activeSessionId) hadSession.current = true;
    if (sessionId && !activeSessionId && hadSession.current) {
      hadSession.current = false;
      localStorage.removeItem(LAST_SESSION_KEY);
      navigate('/chat', { replace: true });
    }
  }, [activeSessionId, sessionId, navigate]);

  // When store assigns a session (new conversation), update URL
  useEffect(() => {
    if (!sessionId && !activeSessionId) awaitingNewSession.current = true;
    if (
      activeSessionId &&
      activeSessionId !== clearedSessionId.current &&
      !sessionId &&
      awaitingNewSession.current &&
      (!repositoryHandoff.present || repositoryHandoff.assignedConversationId === activeSessionId)
    ) {
      awaitingNewSession.current = false;
      navigate(`/chat/${activeSessionId}`, { replace: true });
    }
  }, [
    activeSessionId,
    sessionId,
    navigate,
    repositoryHandoff.present,
    repositoryHandoff.assignedConversationId,
  ]);

  // Hydrate branch/worktree/token state from persisted metadata
  useEffect(() => {
    if (sessionId) {
      storeFetchSessionMeta(sessionId);
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──────────────────────────────────────────────────────────────

  function handleSend(
    text: string,
    images?: ImageAttachment[],
    ctxBlocks?: string[],
    launching = false,
    onDelivery?: import('@mitzo/client').SendMessageOptions['onDelivery'],
    onSessionAssigned?: import('@mitzo/client').SendMessageOptions['onSessionAssigned'],
  ): boolean {
    if (localBound) return false;
    if (explicitNew) {
      if (
        !localFirstCommand ||
        localRuntime.reason ||
        (localCommand && localCommand.state !== 'consumed') ||
        !repositorySelection?.repositoryWorkspaceId ||
        repositorySelection.blocked ||
        ctxBlocks?.length ||
        launching ||
        missingDraftReason ||
        repositoryAccountReason
      )
        return false;
      const command = buildLocalFirstCommand(localRuntime.intent, localRuntime.inventory, {
        clientMsgId: createBrowserId(),
        repositoryWorkspaceId: repositorySelection.repositoryWorkspaceId,
        mode,
        text,
        images: images?.map(({ data, mediaType }) => ({ data, mediaType })),
      });
      if (!command) return false;
      return sendLocalFirstCommand(command, {
        draftId: newChatDraft.draft.id,
        onDelivery,
        onSessionAssigned: (assignedId) => {
          if (accountSelection?.accountId)
            consumeRepositoryDraft(
              repositoryDraftKey(accountSelection.accountId, accountSelection.model),
              repositorySelection.repositoryWorkspaceId!,
            );
          onSessionAssigned?.(assignedId);
        },
      });
    }
    if (localRuntime.reason) return false;
    if (
      missingDraftReason ||
      repositoryAccountReason ||
      repositoryHandoffReason ||
      (repositoryHandoff.present && launching)
    )
      return false;
    if (launch?.briefing && !launching) return false;
    if (!activeSessionId && agentProfileBlocked) return false;
    if (launching && activeSessionId) return sendLaunch();
    if (!activeSessionId && (!accountSelection || repositorySelection?.blocked)) return false;
    // Prompt delivery has its own authenticated outbox and acknowledgement;
    // event-stream recovery must not block an existing conversation's input.
    voice.stopSpeaking();
    const options = {
      images,
      contextBlocks: ctxBlocks,
      ...(onDelivery ? { onDelivery } : {}),
      ...(accountSelection ?? {}),
      ...(!activeSessionId && repositorySelection?.repositoryWorkspaceId
        ? {
            repositoryWorkspaceId: repositorySelection.repositoryWorkspaceId,
            onSessionAssigned: (assignedId: string) => {
              if (repositoryHandoff.present) {
                if (!repositoryHandoff.markAssigned(assignedId)) return;
                const promptKey = repositoryPromptDraftKey(repositoryHandoff.id!);
                if (repositoryDraftControl.current?.storageKey === promptKey)
                  repositoryDraftControl.current.clear();
                else {
                  try {
                    localStorage.removeItem(promptKey);
                  } catch {
                    /* Optional browser storage. */
                  }
                }
              }
              if (accountSelection?.accountId)
                consumeRepositoryDraft(
                  repositoryDraftKey(accountSelection.accountId, accountSelection.model),
                  repositorySelection.repositoryWorkspaceId!,
                );
            },
          }
        : {}),
      mode,
      cwd: searchParams.get('cwd') ?? undefined,
      extraTools: searchParams.get('extraTools') ?? undefined,
      ...(!activeSessionId && agentProfile ? { agentProfile } : {}),
      ...(!activeSessionId && !isolation ? { isolation: false } : {}),
    };
    if (onSessionAssigned) {
      const originalAssignment = options.onSessionAssigned;
      options.onSessionAssigned = (assignedId: string) => {
        originalAssignment?.(assignedId);
        onSessionAssigned(assignedId);
      };
    }
    try {
      const queued = launching ? sendLaunch(options) : storeSendMessage(text, options);
      forceScrollToBottom();
      // The legacy wrapper reports queued even when the transport rejects it.
      // Keep the reviewed prompt until this exact launch assigns a conversation.
      return repositoryHandoff.present ? false : queued;
    } catch (error) {
      if (!repositoryHandoff.present) throw error;
      // A thrown transport may already have sent bytes; retain its pending fence.
      return false;
    }
  }

  function handleInterrupt(
    text: string,
    images?: ImageAttachment[],
    ctxBlocks?: string[],
    onDelivery?: import('@mitzo/client').SendMessageOptions['onDelivery'],
  ): void {
    if (localBound || explicitNew) {
      onDelivery?.('failed');
      return;
    }
    if (repositoryHandoff.present) return;
    voice.stopSpeaking();
    storeInterruptMessage(text, {
      images,
      contextBlocks: ctxBlocks,
      onDelivery,
      ...(accountSelection ?? {}),
    });
    forceScrollToBottom();
  }

  const handleStop = useCallback(() => {
    storeStopGeneration();
    // Only server state confirms completion; a rejected Stop must retain the active turn.
  }, [storeStopGeneration]);

  function handlePermission(
    permId: string,
    decision: 'once' | 'always' | 'deny',
    _toolName: string,
    answers?: import('@mitzo/protocol').QuestionAnswers,
  ) {
    storeRespondToPermission(permId, decision, answers);
  }

  function handleModeChange(newMode: 'ask' | 'agent' | 'auto') {
    if (draftEnabled) setDraftOptions({ id: newChatDraft.draft.id, mode: newMode, isolation });
    storeSetMode(newMode);
  }

  const handleSelectSession = useCallback((id: string) => navigate(`/chat/${id}`), [navigate]);
  const handleNewChat = useCallback(() => {
    storeNewSession();
    navigate('/chat');
  }, [navigate, storeNewSession]);

  return (
    <DesktopShell
      rightDefaultCollapsed
      left={
        <SessionPanel
          activeSessionId={activeSessionId ?? undefined}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
        />
      }
      center={
        <div className="desktop-chat-center workspace-chat">
          {briefingChat.isBriefing && <h1>{briefingChat.name}</h1>}
          <BriefingChatBanner
            name={briefingChat.name}
            initialSelection={
              accountSelection ??
              launch?.accountSelection ??
              (briefingChat.binding
                ? { accountId: briefingChat.binding.accountId, model: briefingChat.binding.model }
                : undefined)
            }
            source={briefingChat.source}
            registrationError={registrationError}
            registrationSaving={registrationSaving}
            retryRegistration={retryRegistration}
            lookupError={briefingChat.error}
            retryLookup={briefingChat.retry}
            lookupLoading={briefingChat.loading}
          />
          <WorkspaceControls
            actions={
              <SessionAccess
                sessionId={repositoryHandoff.present ? undefined : (activeSessionId ?? undefined)}
                selection={accountSelection}
                connected={connected}
              />
            }
            attention={!!launch || repositoryHandoff.present}
            summary={
              explicitNew
                ? {
                    profile:
                      localRuntime.inventory?.accounts.find(
                        (a) => a.account.accountId === localRuntime.intent.account?.accountId,
                      )?.label ?? 'Choose account',
                    model: localRuntime.intent.account?.model,
                    thinking: localRuntime.intent.account?.reasoningEffort ?? undefined,
                    location: localRuntime.intent.execution.location,
                  }
                : workspaceSummary
            }
            status={
              isSymposium
                ? 'Agent chat'
                : activeSessionId && !ordinaryControls
                  ? 'Loading conversation settings'
                  : !connected
                    ? 'Reconnecting'
                    : messages.running
                      ? 'Working'
                      : activeSessionId
                        ? 'Ready'
                        : 'New chat'
            }
          >
            <header className="desktop-chat-header">
              {!connected && (
                <span
                  className="chat-header-offline"
                  title={
                    messages.running ? 'Reconnecting — session still active' : 'Reconnecting...'
                  }
                >
                  !
                </span>
              )}
              {!repositoryHandoff.present || activeSessionId || repositoryHandoff.preparation ? (
                <AccountModelPicker
                  controlled={
                    explicitNew
                      ? {
                          accounts: (localRuntime.inventory?.accounts ?? []).map((a) => ({
                            ...a,
                            id: a.account.accountId,
                          })),
                          selection: localRuntime.intent.account,
                          onChange: (selection) =>
                            localRuntime.update({
                              ...localRuntime.intent,
                              account: selection,
                              capabilityRevision: null,
                            }),
                        }
                      : undefined
                  }
                  key={`${chatDraftRevision}:${newChatDraft.draft.id}`}
                  initialSelection={
                    draftEnabled ? (newChatDraft.draft.settings.selection ?? undefined) : undefined
                  }
                  lockAccountModel={draftEnabled && !!repositorySelection?.repositoryWorkspaceId}
                  requiredSelection={
                    !activeSessionId && repositoryHandoff.preparation
                      ? {
                          accountId: repositoryHandoff.preparation.accountId,
                          model: repositoryHandoff.preparation.model,
                        }
                      : !activeSessionId
                        ? launch?.accountSelection
                        : undefined
                  }
                  sessionId={activeSessionId}
                  preferredModel={modelState}
                  onDraftSelectionChange={draftEnabled ? saveStagedAccount : undefined}
                  onChange={selectAccount}
                  onSummaryChange={setWorkspaceSummary}
                  disabled={
                    messages.running ||
                    localBound ||
                    repositoryHandoff.loading ||
                    briefingChat.selectionLocked
                  }
                />
              ) : (
                <span>Waiting for repository preparation…</span>
              )}
              {ordinaryControls && (
                <>
                  <PermissionModePicker
                    mode={mode}
                    onChange={handleModeChange}
                    disabled={localBound || modeChangeReady === false}
                  />
                  {!activeSessionId && !explicitNew && (
                    <button
                      className={`isolation-toggle${isolation ? ' isolation-toggle--active' : ''}`}
                      onClick={() => setIsolation((v) => !v)}
                      title={isolation ? 'Worktree isolation: ON' : 'Worktree isolation: OFF'}
                    >
                      {isolation ? '\u{1f512}' : '\u{1f513}'}
                    </button>
                  )}
                  {activeSessionId && (
                    <button
                      className="session-close-btn"
                      onClick={() => {
                        if (ordinaryControls) storeCloseSession();
                      }}
                      title="Close session"
                    >
                      <UiIcon name="close" size={16} />
                    </button>
                  )}
                  <VoiceSettings
                    ttsAvailable={voice.ttsAvailable}
                    voices={voice.voices}
                    selectedVoice={voice.selectedVoice}
                    onVoiceChange={voice.setVoice}
                  />
                </>
              )}
            </header>

            <div className="workspace-session-settings">
              <ChatAgentProfilePicker
                controlled={
                  explicitNew
                    ? {
                        versions: localRuntime.inventory?.agentProfiles ?? [],
                        selection: localRuntime.intent.agentProfile,
                        onChange: (agentProfile) =>
                          localRuntime.update({
                            ...localRuntime.intent,
                            agentProfile,
                            capabilityRevision: null,
                          }),
                      }
                    : undefined
                }
                key={`agent-profile:${chatDraftRevision}`}
                sessionId={activeSessionId}
                search={searchParams.toString()}
                onChange={onAgentProfileChange}
                disabled={messages.running || localBound}
              />
              <ChatExecutionPicker
                runtime={localRuntime}
                disabled={messages.running || (!!localCommand && localCommand.state !== 'consumed')}
              />
              {localCommand && (
                <div className="chat-agent-profile" role="status">
                  <span>
                    {localCommand.state === 'consumed'
                      ? 'Original Local command dispatched.'
                      : 'Local command retained. Review its original choices before recovery.'}
                  </span>
                  {localCommand.request && (
                    <span>
                      Account: {localCommand.request.runtime.account.accountId} · Model:{' '}
                      {localCommand.request.selection.model} · Thinking:{' '}
                      {localCommand.request.selection.thinking ?? 'not configurable'} · Agent
                      revision: {localCommand.request.selection.agent.revision} · Local target:{' '}
                      {localCommand.request.runtime.targetId}
                    </span>
                  )}
                  {localCommand.originDraftId && (
                    <Link to={`/chat?draft=${encodeURIComponent(localCommand.originDraftId)}`}>
                      Open original draft
                    </Link>
                  )}
                  {localCommand.sessionId && (
                    <Link to={`/chat/${localCommand.sessionId}`}>Open retained conversation</Link>
                  )}
                  <button
                    type="button"
                    disabled={
                      !connected ||
                      localCommand.state === 'consumed' ||
                      localCommand.state === 'blocked' ||
                      localCommand.state === 'pending'
                    }
                    onClick={() => recoverLocalCommand()}
                  >
                    Recover original Local command
                  </button>
                </div>
              )}

              {ordinaryControls && !explicitNew && !localBound && (
                <WebSearchConsent
                  key={activeSessionId ?? 'new'}
                  sessionId={activeSessionId}
                  mode={mode}
                  connected={connected}
                  connectionId={connectionId}
                  running={messages.running}
                />
              )}
              <div className="workspace-session-actions">
                {activeSessionId && !localBound && <AddAgentSheet sessionId={activeSessionId} />}
                {activeSessionId && !localBound && (
                  <SymposiumReviewEntry key={activeSessionId} sessionId={activeSessionId} />
                )}
              </div>
              {activeSessionId && !localBound && (
                <SymposiumDirectorPanel sessionId={activeSessionId} />
              )}
              <div ref={setProfileToolsTarget} />
            </div>
          </WorkspaceControls>

          {(sendError || sendStatus) && (
            <div role={sendError ? 'alert' : 'status'}>{sendError || sendStatus}</div>
          )}
          {(historyLoading || (sessionId && sessionId !== activeSessionId)) && (
            <div role="status">Loading conversation…</div>
          )}
          {historyError && (
            <div role="alert">
              {historyError}{' '}
              <button
                type="button"
                onClick={() => {
                  if (sessionId) void storeSwitchSession(sessionId);
                }}
              >
                Retry loading conversation
              </button>
            </div>
          )}
          <ScrollFab scrollRef={scrollRef} />
          <SymposiumConversation
            profileToolsTarget={profileToolsTarget}
            sessionId={activeSessionId}
            chat={{
              sessionId: sessionId || activeSessionId || undefined,
              messages: sessionId && sessionId !== activeSessionId ? [] : messages.messages,
              current: sessionId && sessionId !== activeSessionId ? null : messages.current,
              currentByMessage:
                sessionId && sessionId !== activeSessionId ? {} : messages.currentByMessage,
              running: messages.running,
              permission: messages.permission,
              onPermissionRespond: handlePermission,
              onPermissionExpire: storeExpirePermission,
              scrollRef,
              progressByToolId,
              voice,
            }}
            ordinaryComposer={
              <>
                <RepositoryChatDraftNotice handoff={repositoryHandoff} />
                {missingDraftReason && <div role="alert">{missingDraftReason}</div>}
                {repositoryAccountReason && <div role="alert">{repositoryAccountReason}</div>}
                {draftEnabled && repositorySelection?.repositoryWorkspaceId && (
                  <p role="status">Remove the repository preparation to change account or model.</p>
                )}
                {newChatDraft.settingsError && (
                  <div role="alert">Draft settings could not be saved on this device.</div>
                )}
                {launch && !repositoryHandoff.present && (
                  <div role="status" className="chat-account-bar">
                    <p>
                      Which account and model should handle this task? Check Workspace above, then
                      send.
                    </p>
                    <details className="chat-launch-prompt">
                      <summary>Review launch prompt</summary>
                      <p>{launch.prompt}</p>
                    </details>
                    <button
                      disabled={
                        launchSending ||
                        (!activeSessionId &&
                          (!accountSelection || messages.running || repositorySelection?.blocked))
                      }
                      onClick={() => handleSend(launch.prompt, undefined, undefined, true)}
                    >
                      {activeSessionId ? 'Review launch in new chat' : 'Send launch prompt'}
                    </button>
                    <button onClick={dismissLaunch}>Dismiss launch</button>
                  </div>
                )}
                {!activeSessionId &&
                  repositoryAccountSelection?.accountId &&
                  (!repositoryHandoff.present ||
                    (repositoryHandoff.preparation &&
                      repositoryAccountSelection.accountId ===
                        repositoryHandoff.preparation.accountId &&
                      repositoryAccountSelection.model ===
                        repositoryHandoff.preparation.model)) && (
                    <RepositoryChatPicker
                      key={repositoryScope}
                      accountId={repositoryAccountSelection.accountId}
                      model={repositoryAccountSelection.model}
                      draftScoped={draftEnabled}
                      initialPreparationId={
                        repositoryHandoff.preparation?.id ?? initialRepositoryId ?? undefined
                      }
                      onChange={(selection) => {
                        setRepositoryChoice({ scope: repositoryScope, selection });
                        if (!selection) {
                          setRepositoryAccountError(null);
                          setRemovedRepositoryScope(newChatDraft.draft.id);
                        }
                        if (repositoryHandoff.present && !selection)
                          navigate('/chat', { replace: true });
                      }}
                    />
                  )}
                {!localBound && <CodexQueueStatus sessionId={activeSessionId} />}
                <ChatInput
                  boundedFirstCommand={localFirstCommand || localBound}
                  savedChatDraft={savedChatDraft}
                  composerGeneration={chatDraftRevision}
                  key={
                    repositoryHandoff.present
                      ? `${repositoryHandoff.scope}:${repositoryHandoff.preparation ? 'loaded' : 'loading'}`
                      : undefined
                  }
                  sendDisabledReason={
                    localRuntime.reason ??
                    (explicitNew && localCommand && localCommand.state !== 'consumed'
                      ? 'Review the retained Local command before sending.'
                      : undefined) ??
                    (localFirstCommand && (!localTransportAvailable || !connected)
                      ? 'Local connection is unavailable. Reconnect before sending.'
                      : undefined) ??
                    (localFirstCommand && !repositorySelection?.repositoryWorkspaceId
                      ? 'Prepare a repository before sending the Local command.'
                      : undefined) ??
                    missingDraftReason ??
                    repositoryAccountReason ??
                    (launch?.briefing
                      ? 'Send the reviewed briefing prompt first, then ask a follow-up.'
                      : undefined) ??
                    repositoryHandoffReason ??
                    (!activeSessionId && !explicitNew ? agentProfileBlocked : undefined) ??
                    (!activeSessionId && repositorySelection?.blocked
                      ? 'Prepare or remove the repository before sending.'
                      : !activeSessionId && !accountSelection
                        ? 'Select an account before sending.'
                        : undefined)
                  }
                  onSend={(text, images, context, onDelivery, onSessionAssigned) =>
                    handleSend(text, images, context, false, onDelivery, onSessionAssigned)
                  }
                  onStop={handleStop}
                  onInterrupt={handleInterrupt}
                  running={repositoryHandoff.present ? false : messages.running}
                  draftControl={repositoryHandoff.present ? repositoryDraftControl : undefined}
                  draftStorageKey={
                    repositoryHandoff.present
                      ? repositoryPromptDraftKey(repositoryHandoff.id ?? '')
                      : newChatDraft.missing
                        ? chatDraftStorageKey(newChatDraft.draft.id)
                        : undefined
                  }
                  initialText={
                    repositoryHandoff.present
                      ? repositoryHandoff.preparation?.prompt
                      : searchParams.get('prompt') || undefined
                  }
                  voice={voice}
                  branch={messages.branch || undefined}
                  isolation={isolation}
                  onIsolationChange={!activeSessionId && !explicitNew ? setIsolation : undefined}
                  isWorktree={messages.isWorktree}
                  wtId={messages.wtId || undefined}
                  sessionId={repositoryHandoff.present ? undefined : (activeSessionId ?? undefined)}
                  tokenState={tokens}
                  messages={sessionId && sessionId !== activeSessionId ? [] : messages.messages}
                  current={sessionId && sessionId !== activeSessionId ? null : messages.current}
                  bootContext={bootContext}
                  sessionContext={sessionContext}
                />
              </>
            }
          />
        </div>
      }
      right={<CommandCenter />}
      statusBar={
        <StatusBar
          connected={connected}
          sessionId={activeSessionId ?? undefined}
          branch={messages.branch || undefined}
          isWorktree={messages.isWorktree}
          wtId={messages.wtId || undefined}
        />
      }
    />
  );
}
