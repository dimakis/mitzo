import { PermissionModePicker } from '../components/PermissionModePicker';
import { CodexQueueStatus } from '../components/CodexQueueStatus';
import { AccountModelPicker, type AccountSelection } from '../components/AccountModelPicker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { ChatArea } from '../components/ChatArea';
import { ChatInput } from '../components/ChatInput';
import { VoiceSettings } from '../components/VoiceSettings';
import { useMessages, useConnection, useTokens, useMitzoStore } from '@mitzo/client/hooks';
import { LAST_SESSION_KEY } from '../lib/constants';
import { getPreferredModel, setPreferredModel } from '../lib/model-preference';
import { useVoice } from '../hooks/useVoice';
import { useAutoSpeak } from '../hooks/useAutoSpeak';
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
  const connection = useConnection();
  const tokens = useTokens();
  const sendError = useMitzoStore((s) => s.sendError);
  const sendStatus = useMitzoStore((s) => s.sendStatus);
  const activeSessionId = useMitzoStore((s) => s.sessions.active);

  // Select individual action functions — stable references
  const storeSendMessage = useMitzoStore((s) => s.sendMessage);
  const storeInterruptMessage = useMitzoStore((s) => s.interruptMessage);
  const storeStopGeneration = useMitzoStore((s) => s.stopGeneration);
  const storeRespondToPermission = useMitzoStore((s) => s.respondToPermission);
  const storeSwitchSession = useMitzoStore((s) => s.switchSession);
  const storeNewSession = useMitzoStore((s) => s.newSession);
  const storeCloseSession = useMitzoStore((s) => s.closeSession);
  const storeSetMode = useMitzoStore((s) => s.setMode);
  const storeSetModel = useMitzoStore((s) => s.setModel);
  const storeDispatchMessages = useMitzoStore((s) => s.dispatchMessages);
  const storeFetchSessionMeta = useMitzoStore((s) => s.fetchSessionMeta);
  const pendingSession = useMitzoStore((s) => s.pendingSession);
  const setPendingSession = useMitzoStore((s) => s.setPendingSession);
  const clearPendingSession = useMitzoStore((s) => s.clearPendingSession);
  const sessionContext = useMitzoStore((s) => s.messages.sessionContext);
  const bootContext = useMitzoStore((s) => s.messages.bootContext);
  const progressByToolId = useProgressByToolId();

  const connected = connection.status === 'connected';

  // Local model state — persisted to localStorage, sent in payload
  const [modelState, setModelState] = useState(getPreferredModel);
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

  // Sync route param → store session
  useEffect(() => {
    awaitingNewSession.current = !sessionId && !activeSessionId;
    if (sessionId && sessionId !== activeSessionId) {
      storeSwitchSession(sessionId);
    } else if (!sessionId && activeSessionId) {
      // Keep the guard false for this render: the URL-sync effect below still
      // sees the stale active ID and must not navigate back to it. The render
      // after newSession clears the store arms the guard for the replacement ID.
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
    if (activeSessionId && !sessionId && awaitingNewSession.current) {
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

  // Auto-send pending session (from "Start Session" on inbox/todo items)
  const pendingConsumed = useRef<typeof pendingSession>(null);
  const [pausedLaunch, setPausedLaunch] = useState<typeof pendingSession>(null);
  const accountUnavailable = useCallback(() => {
    if (pendingSession) {
      setPausedLaunch(pendingSession);
      clearPendingSession();
    }
  }, [pendingSession, clearPendingSession]);
  useEffect(() => {
    if (!pendingSession || !accountSelection) return;
    // Guard against double-consumption of the same pending session
    const key = pendingSession;
    if (pendingConsumed.current === key) return;
    pendingConsumed.current = key;
    // Set the context block for display
    storeDispatchMessages({ type: 'SET_SESSION_CONTEXT', context: pendingSession.context });
    // Auto-send the prompt
    storeSendMessage(pendingSession.prompt, {
      ...(accountSelection ?? {}),
      mode,
      ...(pendingSession.telosTaskId ? { telosTaskId: pendingSession.telosTaskId } : {}),
      ...(pendingSession.agentName ? { agentName: pendingSession.agentName } : {}),
    });
    clearPendingSession();
    forceScrollToBottom();
  }, [pendingSession, accountSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  useAutoSpeak({
    messages: messages.messages,
    running: messages.running,
    ttsEnabled: voice.ttsEnabled,
    ttsAvailable: voice.ttsAvailable,
    speak: voice.speak,
  });

  // ── Actions ──────────────────────────────────────────────────────────────

  function handleSend(text: string, images?: ImageAttachment[], ctxBlocks?: string[]): boolean {
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
    storeSendMessage(text, {
      images,
      contextBlocks: ctxBlocks,
      ...(accountSelection ?? {}),
      mode,
      cwd: searchParams.get('cwd') ?? undefined,
      extraTools: searchParams.get('extraTools') ?? undefined,
      ...(!activeSessionId && !isolation ? { isolation: false } : {}),
    });
    forceScrollToBottom();
    return true;
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
            <PermissionModePicker mode={mode} onChange={handleModeChange} />
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
                onClick={storeCloseSession}
                title="Close session"
              >
                &times;
              </button>
            )}
            <VoiceSettings
              ttsAvailable={voice.ttsAvailable}
              ttsEnabled={voice.ttsEnabled}
              speaking={voice.speaking}
              voices={voice.voices}
              selectedVoice={voice.selectedVoice}
              onToggle={() => voice.setTtsEnabled(!voice.ttsEnabled)}
              onVoiceChange={voice.setVoice}
            />
          </>
        )}
      </header>
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
      <div className="chat-account-bar">
        <AccountModelPicker
          disabled={messages.running}
          sessionId={activeSessionId}
          preferredModel={modelState}
          onChange={selectAccount}
          onUnavailable={accountUnavailable}
        />
      </div>

      <CodexQueueStatus sessionId={activeSessionId} />
      <ChatArea
        messages={messages.messages}
        current={messages.current}
        running={messages.running}
        permission={messages.permission}
        onPermissionRespond={handlePermission}
        scrollRef={scrollRef}
        progressByToolId={progressByToolId}
        voice={voice}
      />

      {pausedLaunch && (
        <div role="status" className="chat-account-bar">
          <p>Launch paused. Select an account before sending.</p>
          <p>{pausedLaunch.prompt}</p>
          <button
            disabled={!accountSelection || messages.running}
            onClick={() => {
              setPendingSession(pausedLaunch);
              setPausedLaunch(null);
            }}
          >
            Send launch prompt
          </button>
          <button onClick={() => setPausedLaunch(null)}>Dismiss launch</button>
        </div>
      )}
      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onInterrupt={handleInterrupt}
        running={messages.running}
        initialText={initialPrompt}
        sendDisabledReason={
          !activeSessionId && !accountSelection ? 'Select an account before sending.' : undefined
        }
        voice={voice}
        branch={messages.branch || undefined}
        isWorktree={messages.isWorktree}
        wtId={messages.wtId || undefined}
        sessionId={activeSessionId ?? undefined}
        tokenState={tokens}
        messages={messages.messages}
        current={messages.current}
        bootContext={bootContext}
        sessionContext={sessionContext}
      />
    </div>
  );
}
