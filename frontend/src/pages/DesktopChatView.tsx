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
import { OutputContributorPanel } from '../components/OutputContributorPanel';
import { useOutputContributors } from '../hooks/useOutputContributors';
import { PermissionModePicker } from '../components/PermissionModePicker';
import { WorkspaceControls } from '../components/WorkspaceControls';
import type { WorkspaceSummary } from '../types/workspace';
import { AccountModelPicker, type AccountSelection } from '../components/AccountModelPicker';
import { CodexQueueStatus } from '../components/CodexQueueStatus';
import { WebSearchConsent } from '../components/WebSearchConsent';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
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
  const [searchParams] = useSearchParams();
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
  const storeDispatchMessages = useMitzoStore((s) => s.dispatchMessages);
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

  const connected = connection.status === 'connected';

  // Local model state — persisted to localStorage, sent in payload
  const [summaryForSession, setSummaryForSession] = useState<{
    sessionId: string | null;
    summary: WorkspaceSummary | null;
  } | null>(null);
  const workspaceSummary =
    summaryForSession?.sessionId === activeSessionId ? summaryForSession.summary : null;
  const setWorkspaceSummary = useCallback(
    (summary: WorkspaceSummary | null) => {
      setSummaryForSession({ sessionId: activeSessionId, summary });
    },
    [activeSessionId],
  );
  const isSymposium = workspaceSummary?.sessionType === 'symposium';
  const ordinaryControls = !activeSessionId || workspaceSummary?.sessionType === 'chat';
  const outputContributors = useOutputContributors(
    activeSessionId,
    workspaceSummary?.sessionType === 'chat' && (!sessionId || sessionId === activeSessionId),
    `${messages.messages.length}:${messages.running}`,
  );
  const [accountSelection, setAccountSelection] = useState<AccountSelection | null>(null);
  const repositoryScope = `${repositoryHandoff.present ? repositoryHandoff.scope : ''}:${chatDraftRevision}:${accountSelection?.accountId ?? ''}:${accountSelection?.model ?? ''}`;
  const [repositoryChoice, setRepositoryChoice] = useState<{
    scope: string;
    selection: RepositoryChatSelection | null;
  } | null>(null);
  const repositorySelection =
    repositoryChoice?.scope === repositoryScope
      ? repositoryChoice.selection
      : repositoryHandoff.present
        ? { blocked: true }
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
      setAccountSelection(selection);
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
      setModel,
      storeSetModel,
      activeSessionId,
      repositoryHandoff.present,
      repositoryHandoff.lastAssignedConversationId,
      launch?.briefing,
      briefingChat.selectionLocked,
    ],
  );

  const mode = useMitzoStore((s) => s.config.mode);
  useEffect(() => {
    if (!activeSessionId && searchParams.get('extraTools')) storeSetMode('auto');
  }, [activeSessionId, searchParams, storeSetMode]);
  const [isolation, setIsolation] = useState(true);

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
  ): boolean {
    if (repositoryHandoffReason || (repositoryHandoff.present && launching)) return false;
    if (launch?.briefing && !launching) return false;
    if (!activeSessionId && agentProfileBlocked) return false;
    if (launching && activeSessionId) return sendLaunch();
    if (!activeSessionId && (!accountSelection || repositorySelection?.blocked)) return false;
    if (activeSessionId && connection.status !== 'connected') {
      storeDispatchMessages({ type: 'CONNECTION_LOST' });
      return false;
    }
    voice.stopSpeaking();
    const options = {
      images,
      contextBlocks: ctxBlocks,
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
            attention={!!launch || repositoryHandoff.present}
            summary={workspaceSummary}
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
                  key={chatDraftRevision}
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
                  onChange={selectAccount}
                  onSummaryChange={setWorkspaceSummary}
                  disabled={
                    messages.running || repositoryHandoff.loading || briefingChat.selectionLocked
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
                    disabled={modeChangeReady === false}
                  />
                  {!activeSessionId && (
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
                key={`agent-profile:${chatDraftRevision}`}
                sessionId={activeSessionId}
                search={searchParams.toString()}
                onChange={onAgentProfileChange}
                disabled={messages.running}
              />
              {ordinaryControls && (
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
                {activeSessionId && <AddAgentSheet sessionId={activeSessionId} />}
                {activeSessionId && (
                  <SymposiumReviewEntry key={activeSessionId} sessionId={activeSessionId} />
                )}
              </div>
              {activeSessionId && <SymposiumDirectorPanel sessionId={activeSessionId} />}
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
            ordinaryAfterMessages={
              outputContributors ? <OutputContributorPanel {...outputContributors} /> : null
            }
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
                  accountSelection?.accountId &&
                  (!repositoryHandoff.present ||
                    (repositoryHandoff.preparation &&
                      accountSelection.accountId === repositoryHandoff.preparation.accountId &&
                      accountSelection.model === repositoryHandoff.preparation.model)) && (
                    <RepositoryChatPicker
                      key={repositoryScope}
                      accountId={accountSelection.accountId}
                      model={accountSelection.model}
                      initialPreparationId={repositoryHandoff.preparation?.id}
                      onChange={(selection) => {
                        setRepositoryChoice({ scope: repositoryScope, selection });
                        if (repositoryHandoff.present && !selection)
                          navigate('/chat', { replace: true });
                      }}
                    />
                  )}
                <CodexQueueStatus sessionId={activeSessionId} />
                <ChatInput
                  key={
                    repositoryHandoff.present
                      ? `${repositoryHandoff.scope}:${repositoryHandoff.preparation ? 'loaded' : 'loading'}`
                      : undefined
                  }
                  sendDisabledReason={
                    (launch?.briefing
                      ? 'Send the reviewed briefing prompt first, then ask a follow-up.'
                      : undefined) ??
                    repositoryHandoffReason ??
                    (!activeSessionId ? agentProfileBlocked : undefined) ??
                    (!activeSessionId && repositorySelection?.blocked
                      ? 'Prepare or remove the repository before sending.'
                      : !activeSessionId && !accountSelection
                        ? 'Select an account before sending.'
                        : undefined)
                  }
                  onSend={handleSend}
                  onStop={handleStop}
                  onInterrupt={handleInterrupt}
                  running={repositoryHandoff.present ? false : messages.running}
                  draftControl={repositoryHandoff.present ? repositoryDraftControl : undefined}
                  draftStorageKey={
                    repositoryHandoff.present
                      ? repositoryPromptDraftKey(repositoryHandoff.id ?? '')
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
                  onIsolationChange={!activeSessionId ? setIsolation : undefined}
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
