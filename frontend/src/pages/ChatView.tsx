import { useCallback, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { ChatArea } from '../components/ChatArea';
import { ChatInput } from '../components/ChatInput';
import { VoiceSettings } from '../components/VoiceSettings';
import { MitzoLogo } from '../components/MitzoLogo';
import { wsSend } from '../lib/ws-pool';
import { SCROLL_RESTORE_DELAY_MS, LAST_SESSION_KEY } from '../lib/constants';
import { useChatSession } from '../hooks/useChatSession';
import { useChatMessages } from '../hooks/useChatMessages';
import { useChatConnection } from '../hooks/useChatConnection';
import { useChatActions } from '../hooks/useChatActions';
import { usePermission } from '../hooks/usePermission';
import { useVoice } from '../hooks/useVoice';
import { useAutoSpeak } from '../hooks/useAutoSpeak';
import { useTokenState } from '../hooks/useTokenState';

export function ChatView() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [sessionState, sessionActions, poolKey] = useChatSession(
    sessionId,
    searchParams.get('extraTools') ? 'auto' : 'agent',
  );

  const voice = useVoice();
  const { tokenState, handleTokenMessage } = useTokenState(sessionState.currentSessionId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  const handleSessionExpired = useCallback(
    (staleId: string | undefined) => {
      sessionActions.setCurrentSessionId(undefined);
      if (staleId) {
        localStorage.removeItem(LAST_SESSION_KEY);
      }
      if (sessionId) {
        navigate('/chat', { replace: true });
      }
    },
    [sessionId, navigate, sessionActions],
  );

  // When a session ID is assigned mid-conversation (started from /chat),
  // update the URL so refreshes and back-navigation land on /chat/:id
  // and can restore messages from cache or the API.
  // Uses replaceState to avoid a React Router remount that would kill
  // the live streaming view.
  const handleSessionAssigned = useCallback(
    (id: string) => {
      sessionActions.setCurrentSessionId(id);
      if (!sessionId && window.location.pathname === '/chat') {
        window.history.replaceState(null, '', `/chat/${id}`);
      }
    },
    [sessionId, sessionActions],
  );

  const handleSessionRenamed = useCallback((name: string) => {
    document.title = `${name} — Mitzo`;
  }, []);

  const {
    state: msgState,
    dispatch,
    pendingSend,
    handleWsMessage,
  } = useChatMessages(
    poolKey,
    sessionState.currentSessionId,
    handleSessionAssigned,
    handleSessionExpired,
    forceScrollToBottom,
    handleSessionRenamed,
  );

  // Restore messages when navigating to an existing session.
  // Fetch from the API (single source of truth — no localStorage cache).
  useEffect(() => {
    if (!sessionId) return;

    const controller = new AbortController();

    fetch(`/api/sessions/${sessionId}/messages`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((msgs: unknown[]) => {
        if (controller.signal.aborted) return;
        const apiMsgs = msgs as import('../types/chat').FinishedMessage[];
        if (apiMsgs.length > 0) {
          dispatch({ type: 'RESTORE', messages: apiMsgs });
          setTimeout(forceScrollToBottom, SCROLL_RESTORE_DELAY_MS);
        }
      })
      .catch(() => {});

    return () => controller.abort();
  }, [sessionId, dispatch, forceScrollToBottom]);

  const { connected } = useChatConnection(poolKey, handleWsMessage, handleTokenMessage);

  const { handlePermission } = usePermission(poolKey, () => {
    dispatch({ type: 'PERMISSION_TIMEOUT', permId: msgState.permission?.permId ?? '' });
  });

  useAutoSpeak({
    messages: msgState.messages,
    running: msgState.running,
    ttsEnabled: voice.ttsEnabled,
    ttsAvailable: voice.ttsAvailable,
    speak: voice.speak,
  });

  const { sendMessage, interruptMessage, handleStop } = useChatActions({
    poolKey,
    sessionState,
    searchParams,
    dispatch,
    pendingSend,
    forceScrollToBottom,
    voice,
    running: msgState.running,
  });

  function handleModeChange(newMode: 'ask' | 'agent' | 'auto') {
    sessionActions.setMode(newMode);
    if (msgState.running) {
      wsSend(poolKey, { type: 'set_mode', mode: newMode });
    }
  }

  const initialPrompt = searchParams.get('prompt') || undefined;

  return (
    <div className="chat-page">
      <header className="chat-header">
        <MitzoLogo />
        {!connected && (
          <span
            className="chat-header-offline"
            title={msgState.running ? 'Reconnecting — session still active' : 'Reconnecting...'}
          >
            !
          </span>
        )}
        <select
          className="chat-model-select"
          value={sessionState.model}
          onChange={(e) => sessionActions.setModel(e.target.value)}
          disabled={msgState.running}
        >
          <option value="claude-sonnet-4-6">Sonnet</option>
          <option value="claude-opus-4-6">Opus</option>
          <option value="claude-haiku-4-5">Haiku</option>
        </select>
        <div className="mode-pills">
          {(['ask', 'agent', 'auto'] as const).map((m) => (
            <button
              key={m}
              className={`mode-pill${sessionState.mode === m ? ' mode-pill--active' : ''}`}
              onClick={() => handleModeChange(m)}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <VoiceSettings
          ttsAvailable={voice.ttsAvailable}
          ttsEnabled={voice.ttsEnabled}
          speaking={voice.speaking}
          voices={voice.voices}
          selectedVoice={voice.selectedVoice}
          onToggle={() => voice.setTtsEnabled(!voice.ttsEnabled)}
          onVoiceChange={voice.setVoice}
        />
      </header>

      <ChatArea
        messages={msgState.messages}
        current={msgState.current}
        running={msgState.running}
        permission={msgState.permission}
        onPermissionRespond={handlePermission}
        scrollRef={scrollRef}
      />

      <ChatInput
        onSend={sendMessage}
        onStop={handleStop}
        onInterrupt={interruptMessage}
        running={msgState.running}
        initialText={initialPrompt}
        voice={voice}
        branch={msgState.branch || undefined}
        isWorktree={msgState.isWorktree}
        wtId={msgState.wtId || undefined}
        tokenState={tokenState}
      />
    </div>
  );
}
