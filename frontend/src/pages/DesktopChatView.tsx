import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { DesktopShell } from '../components/DesktopShell';
import { SessionPanel } from '../components/SessionPanel';
import { ContextPanel } from '../components/ContextPanel';
import { FileBrowserPanel } from '../components/FileBrowserPanel';
import { ChatArea } from '../components/ChatArea';
import { ChatInput } from '../components/ChatInput';
import { StatusBar } from '../components/StatusBar';
import { VoiceSettings } from '../components/VoiceSettings';
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
import { useSessionMeta } from '../hooks/useSessionMeta';
import type { FileRoot } from '../components/FileBrowserPanel';
import type { ContextBlockEntry } from '../components/ContextPicker';

export function DesktopChatView() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [contextBlocks, setContextBlocks] = useState<string[]>([]);

  // Shared config fetch for right-panel children
  const [configBlocks, setConfigBlocks] = useState<ContextBlockEntry[]>([]);
  const [fileRoots, setFileRoots] = useState<FileRoot[]>([]);
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/config', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        // Context blocks
        const entries: ContextBlockEntry[] = [];
        if (data.contextBlocks) {
          for (const [name, info] of Object.entries(
            data.contextBlocks as Record<string, { path: string; sizeBytes: number }>,
          )) {
            entries.push({ name, path: info.path, sizeBytes: info.sizeBytes });
          }
        }
        setConfigBlocks(entries);
        // File roots
        setFileRoots(data.fileViewerRoots ?? []);
        setConfigLoaded(true);
      })
      .catch(() => setConfigLoaded(true));
  }, []);

  const [sessionState, sessionActions, poolKey] = useChatSession(
    sessionId,
    searchParams.get('extraTools') ? 'auto' : 'agent',
  );

  const voice = useVoice();
  const { tokenState, tokenDispatch, handleTokenMessage } = useTokenState(
    sessionState.currentSessionId,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  const handleSessionExpired = useCallback(
    (staleId: string) => {
      // Clear both state and storage so the next send starts a fresh conversation
      // instead of retrying `resume` with a stale ID in a loop.
      sessionActions.setCurrentSessionId(undefined);
      localStorage.removeItem(LAST_SESSION_KEY);
      if (sessionId) navigate('/chat', { replace: true });
    },
    [sessionId, navigate, sessionActions],
  );

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

  // Clear + restore on session switch — abort previous fetch to prevent race condition
  useEffect(() => {
    dispatch({ type: 'CLEAR' });
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

  useSessionMeta(sessionId, dispatch, tokenDispatch);

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

  const handleToggleContext = useCallback((name: string) => {
    setContextBlocks((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }, []);

  const handleSelectSession = useCallback((id: string) => navigate(`/chat/${id}`), [navigate]);

  const handleNewChat = useCallback(() => navigate('/chat'), [navigate]);

  return (
    <DesktopShell
      left={
        <SessionPanel
          activeSessionId={sessionState.currentSessionId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
        />
      }
      center={
        <div className="desktop-chat-center">
          <header className="desktop-chat-header">
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
            initialText={searchParams.get('prompt') || undefined}
            voice={voice}
            branch={msgState.branch || undefined}
            isWorktree={msgState.isWorktree}
            wtId={msgState.wtId || undefined}
            sessionId={sessionState.currentSessionId}
            externalContextBlocks={contextBlocks}
            tokenState={tokenState}
          />
        </div>
      }
      right={
        <div className="desktop-right-panels">
          <ContextPanel
            selected={contextBlocks}
            onToggle={handleToggleContext}
            blocks={configBlocks}
            loaded={configLoaded}
          />
          <FileBrowserPanel roots={fileRoots} loaded={configLoaded} />
        </div>
      }
      statusBar={
        <StatusBar
          connected={connected}
          sessionId={sessionState.currentSessionId}
          branch={msgState.branch || undefined}
          isWorktree={msgState.isWorktree}
          wtId={msgState.wtId || undefined}
        />
      }
    />
  );
}
