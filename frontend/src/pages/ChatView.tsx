import { usePendingLaunch } from '../hooks/usePendingLaunch';
import { SymposiumReviewEntry } from '../components/SymposiumReviewPanel';
import { AddReviewerSheet } from '../components/AddReviewerSheet';
import { NewSymposium } from '../components/NewSymposium';
import { PermissionModePicker } from '../components/PermissionModePicker';
import { StatusBar } from '../components/StatusBar';
import { WorkspaceControls } from '../components/WorkspaceControls';
import type { WorkspaceSummary } from '../types/workspace';
import { CodexQueueStatus } from '../components/CodexQueueStatus';
import { WebSearchConsent } from '../components/WebSearchConsent';
import { AccountModelPicker, type AccountSelection } from '../components/AccountModelPicker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { SymposiumConversation } from '../components/SymposiumConversation';
import { SymposiumDirectorPanel } from '../components/SymposiumDirectorPanel';
import { ChatInput } from '../components/ChatInput';
import { VoiceSettings } from '../components/VoiceSettings';
import { useMessages, useConnection, useTokens, useMitzoStore } from '@mitzo/client/hooks';
import { LAST_SESSION_KEY } from '../lib/constants';
import { getPreferredModel, setPreferredModel } from '../lib/model-preference';
import { useVoice } from '../hooks/useVoice';
import { useProgressByToolId } from '../hooks/useProgress';
import { onKeyboardToggle } from '../lib/keyboard';
import type { ImageAttachment } from '../types/chat';

export function ChatView() {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(
    () =>
      onKeyboardToggle((visible) => {
        setKeyboardOpen(visible);
        if (visible) {
          requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current!.scrollHeight });
          });
        }
      }),
    [],
  );
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // Store state
  const messages = useMessages();
  const historyLoading = useMitzoStore((s) => s.historyLoading);
  const historyError = useMitzoStore((s) => s.historyError);
  const connection = useConnection();
  const tokens = useTokens();
  const sendError = useMitzoStore((s) => s.sendError);
  const sendStatus = useMitzoStore((s) => s.sendStatus);
  const activeSessionId = useMitzoStore((s) => s.sessions.active);
  const modeChangeReady = useMitzoStore((s) => s.modeChangeReady);

  // Select individual action functions — stable references
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
  } = usePendingLaunch();

  const connected = connection.status === 'connected';

  // Local model state — persisted to localStorage, sent in payload
  const [modelState, setModelState] = useState(getPreferredModel);
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummary | null>(null);
  const [accountSelection, setAccountSelection] = useState<AccountSelection | null>(null);
  const setModel = useCallback(
    (id: string) => {
      setModelState(id);
      setPreferredModel(id);
      storeSetModel(id);
    },
    [storeSetModel],
  );

  const selectAccount = useCallback(
    (selection: AccountSelection | null) => {
      setAccountSelection(selection);
      if (selection) setModel(selection.model);
    },
    [setModel],
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
    } else if (!sessionId && (activeSessionId || resetFailedDraftOnMount.current)) {
      // Ignore the old ID while waiting for the new one, even when reset and
      // assignment are batched without an intermediate render.
      storeNewSession();
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      awaitingNewSession.current
    ) {
      awaitingNewSession.current = false;
      navigate(`/chat/${activeSessionId}`, { replace: true });
    }
  }, [activeSessionId, sessionId, navigate]);

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
    if (!activeSessionId && !accountSelection) return false;
    // For new sessions (no activeSessionId) the store bootstraps a WS on
    // demand inside sendMessage(), so we must not block on connection status.
    // Only gate on connection for existing sessions where a WS should already
    // be open.
    if (activeSessionId && connection.status !== 'connected') {
      storeDispatchMessages({ type: 'CONNECTION_LOST' });
      return false;
    }
    voice.stopSpeaking();
    // Codex supports per-turn model changes. The server ignores these fields for
    // sessions bound to other providers and rejects cross-account rebinding.
    const options = {
      images,
      contextBlocks: ctxBlocks,
      ...(accountSelection ?? {}),
      mode,
      cwd: searchParams.get('cwd') ?? undefined,
      extraTools: searchParams.get('extraTools') ?? undefined,
      ...(!activeSessionId && !isolation ? { isolation: false } : {}),
    };
    const queued = launching ? sendLaunch(options) : storeSendMessage(text, options);
    forceScrollToBottom();
    return queued;
  }

  function handleInterrupt(text: string, images?: ImageAttachment[], ctxBlocks?: string[]): void {
    voice.stopSpeaking();
    // Preserve the same per-turn Codex selection when interrupting an active turn.
    storeInterruptMessage(text, { images, contextBlocks: ctxBlocks, ...(accountSelection ?? {}) });
    forceScrollToBottom();
  }

  const handleStop = useCallback(() => {
    storeStopGeneration();
    // Optimistic update — server confirms via session_state_changed event,
    // but we set idle immediately for responsive UI on the stop button.
    storeDispatchMessages({ type: 'SESSION_STATE_CHANGED', state: 'idle' });
  }, [storeStopGeneration, storeDispatchMessages]);

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

  const initialPrompt = searchParams.get('prompt') || undefined;

  return (
    <div className={`chat-page workspace-chat${keyboardOpen ? ' keyboard-open' : ''}`}>
      <div className="chat-mobile-topbar">
        <div className="conversation-heading">
          <Link to="/sessions" aria-label="Back to chats">
            ← Chats
          </Link>
          <h1>{activeSessionId ? 'Conversation' : 'New chat'}</h1>
          <button
            onClick={() => {
              storeNewSession();
              navigate('/chat');
            }}
          >
            New chat
          </button>
        </div>
        <WorkspaceControls
          attention={!!launch}
          summary={workspaceSummary}
          status={!connected ? 'Reconnecting' : messages.running ? 'Working' : 'Ready'}
        >
          <div className="chat-account-bar">
            <AccountModelPicker
              key={chatDraftRevision}
              disabled={messages.running}
              sessionId={activeSessionId}
              preferredModel={modelState}
              onChange={selectAccount}
              onSummaryChange={setWorkspaceSummary}
            />
          </div>
          <header className="chat-header">
            {!connected && (
              <span
                className="chat-header-offline"
                title={messages.running ? 'Reconnecting — session still active' : 'Reconnecting...'}
              >
                !
              </span>
            )}

            {!keyboardOpen && (
              <>
                <PermissionModePicker
                  mode={mode}
                  onChange={handleModeChange}
                  disabled={modeChangeReady === false}
                />
                {activeSessionId && (
                  <button
                    className="session-close-btn"
                    onClick={storeCloseSession}
                    title="Close session"
                  >
                    &times;
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
          {activeSessionId && (
            <div className="mobile-session-context">
              <StatusBar
                connected={connected}
                sessionId={activeSessionId}
                branch={messages.branch || undefined}
                isWorktree={messages.isWorktree}
                wtId={messages.wtId || undefined}
              />
            </div>
          )}

          <div className="workspace-session-settings">
            <WebSearchConsent
              key={activeSessionId ?? 'new'}
              sessionId={activeSessionId}
              mode={mode}
              connected={connected}
              connectionId={connectionId}
              running={messages.running}
            />
            {activeSessionId && (
              <p className="symposium-review-help">
                AI review · Add a read-only reviewer, approve and send its request, then read the
                findings.
              </p>
            )}
            <div className="workspace-session-actions">
              {activeSessionId && <AddReviewerSheet sessionId={activeSessionId} />}
              {activeSessionId && (
                <SymposiumReviewEntry key={activeSessionId} sessionId={activeSessionId} />
              )}
            </div>
            {activeSessionId && <SymposiumDirectorPanel sessionId={activeSessionId} />}
          </div>
        </WorkspaceControls>
      </div>

      {(sendError || sendStatus) && (
        <div
          role={sendError ? 'alert' : 'status'}
          className={
            sendError ? 'chat-delivery-status chat-delivery-error' : 'chat-delivery-status'
          }
        >
          {sendError || sendStatus}
        </div>
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
      {!activeSessionId && !sessionId && <NewSymposium />}
      <SymposiumConversation
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
            {launch && (
              <div role="status" className="chat-account-bar">
                <p>
                  Which account and model should handle this task? Check Workspace above, then send.
                </p>
                <details className="chat-launch-prompt">
                  <summary>Review launch prompt</summary>
                  <p>{launch.prompt}</p>
                </details>
                <button
                  disabled={!accountSelection || messages.running || launchSending}
                  onClick={() => handleSend(launch.prompt, undefined, undefined, true)}
                >
                  Send launch prompt
                </button>
                <button onClick={dismissLaunch}>Dismiss launch</button>
              </div>
            )}
            <CodexQueueStatus sessionId={activeSessionId} />
            <ChatInput
              onSend={handleSend}
              onStop={handleStop}
              onInterrupt={handleInterrupt}
              running={messages.running}
              initialText={initialPrompt}
              sendDisabledReason={
                !activeSessionId && !accountSelection
                  ? 'Select an account before sending.'
                  : undefined
              }
              voice={voice}
              branch={messages.branch || undefined}
              isolation={isolation}
              onIsolationChange={!activeSessionId ? setIsolation : undefined}
              isWorktree={messages.isWorktree}
              wtId={messages.wtId || undefined}
              sessionId={activeSessionId ?? undefined}
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
  );
}
