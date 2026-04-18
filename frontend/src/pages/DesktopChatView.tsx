import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { DesktopShell } from '../components/DesktopShell';
import { SessionPanel } from '../components/SessionPanel';
import { ContextPanel } from '../components/ContextPanel';
import { FileBrowserPanel } from '../components/FileBrowserPanel';
import { ChatArea } from '../components/ChatArea';
import { ChatInput } from '../components/ChatInput';
import { ScrollFab } from '../components/ScrollFab';
import { StatusBar } from '../components/StatusBar';
import { VoiceSettings } from '../components/VoiceSettings';
import { useMessages, useConnection, useTokens, useMitzoStore } from '@mitzo/client/hooks';
import { LAST_SESSION_KEY } from '../lib/constants';
import { getPreferredModel, setPreferredModel } from '../lib/model-preference';
import { useVoice } from '../hooks/useVoice';
import { useAutoSpeak } from '../hooks/useAutoSpeak';
import type { FileRoot } from '../components/FileBrowserPanel';
import type { ContextBlockEntry } from '../components/ContextPicker';
import type { ImageAttachment } from '../types/chat';

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
        const entries: ContextBlockEntry[] = [];
        if (data.contextBlocks) {
          for (const [name, info] of Object.entries(
            data.contextBlocks as Record<string, { path: string; sizeBytes: number }>,
          )) {
            entries.push({ name, path: info.path, sizeBytes: info.sizeBytes });
          }
        }
        setConfigBlocks(entries);
        setFileRoots(data.fileViewerRoots ?? []);
        setConfigLoaded(true);
      })
      .catch(() => setConfigLoaded(true));
  }, []);

  // Store state
  const messages = useMessages();
  const connection = useConnection();
  const tokens = useTokens();
  const activeSessionId = useMitzoStore((s) => s.sessions.active);

  // Select individual action functions — stable references, no new-object trap
  const storeSendMessage = useMitzoStore((s) => s.sendMessage);
  const storeInterruptMessage = useMitzoStore((s) => s.interruptMessage);
  const storeStopGeneration = useMitzoStore((s) => s.stopGeneration);
  const storeRespondToPermission = useMitzoStore((s) => s.respondToPermission);
  const storeSwitchSession = useMitzoStore((s) => s.switchSession);
  const storeNewSession = useMitzoStore((s) => s.newSession);
  const storeSetMode = useMitzoStore((s) => s.setMode);
  const storeSetModel = useMitzoStore((s) => s.setModel);
  const storeDispatchMessages = useMitzoStore((s) => s.dispatchMessages);
  const storeFetchSessionMeta = useMitzoStore((s) => s.fetchSessionMeta);

  const connected = connection.status === 'connected';

  // Local model state — persisted to localStorage, sent in payload
  const [modelState, setModelState] = useState(getPreferredModel);
  const setModel = useCallback(
    (id: string) => {
      setModelState(id);
      setPreferredModel(id);
      storeSetModel(id);
    },
    [storeSetModel],
  );

  const [mode, setMode] = useState<'ask' | 'agent' | 'auto'>(
    searchParams.get('extraTools') ? 'auto' : 'agent',
  );

  const voice = useVoice();
  const scrollRef = useRef<HTMLDivElement>(null);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  // Sync route param → store session
  useEffect(() => {
    if (sessionId && sessionId !== activeSessionId) {
      storeSwitchSession(sessionId);
    } else if (!sessionId && activeSessionId) {
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
    if (activeSessionId && !sessionId && window.location.pathname === '/chat') {
      window.history.replaceState(null, '', `/chat/${activeSessionId}`);
    }
  }, [activeSessionId, sessionId]);

  // Hydrate branch/worktree/token state from persisted metadata
  useEffect(() => {
    if (sessionId) {
      storeFetchSessionMeta(sessionId);
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useAutoSpeak({
    messages: messages.messages,
    running: messages.running,
    ttsEnabled: voice.ttsEnabled,
    ttsAvailable: voice.ttsAvailable,
    speak: voice.speak,
  });

  // ── Actions ──────────────────────────────────────────────────────────────

  function handleSend(text: string, images?: ImageAttachment[], ctxBlocks?: string[]): boolean {
    // For new sessions (no activeSessionId) the store bootstraps a WS on
    // demand inside sendMessage(), so we must not block on connection status.
    // Only gate on connection for existing sessions where a WS should already
    // be open.
    if (activeSessionId && connection.status !== 'connected') {
      storeDispatchMessages({ type: 'CONNECTION_LOST' });
      return false;
    }
    voice.stopSpeaking();
    storeSendMessage(text, {
      images,
      contextBlocks: ctxBlocks,
      model: modelState,
      mode,
      cwd: searchParams.get('cwd') ?? undefined,
      extraTools: searchParams.get('extraTools') ?? undefined,
    });
    forceScrollToBottom();
    return true;
  }

  function handleInterrupt(text: string, images?: ImageAttachment[], ctxBlocks?: string[]): void {
    voice.stopSpeaking();
    storeInterruptMessage(text, { images, contextBlocks: ctxBlocks });
    forceScrollToBottom();
  }

  const handleStop = useCallback(() => {
    storeStopGeneration();
    storeDispatchMessages({ type: 'SET_RUNNING', running: false });
  }, [storeStopGeneration, storeDispatchMessages]);

  function handlePermission(
    permId: string,
    decision: 'once' | 'always' | 'deny',
    _toolName: string,
  ) {
    storeRespondToPermission(permId, decision);
  }

  function handleModeChange(newMode: 'ask' | 'agent' | 'auto') {
    setMode(newMode);
    storeSetMode(newMode);
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
          activeSessionId={activeSessionId ?? undefined}
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
                title={messages.running ? 'Reconnecting — session still active' : 'Reconnecting...'}
              >
                !
              </span>
            )}
            <select
              className="chat-model-select"
              value={modelState}
              onChange={(e) => setModel(e.target.value)}
              disabled={messages.running}
            >
              <option value="claude-opus-4-7">Opus 4.7</option>
              <option value="claude-opus-4-7:max">Opus 4.7 Max</option>
              <option value="claude-opus-4-6">Opus 4.6</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6</option>
              <option value="claude-haiku-4-5">Haiku 4.5</option>
            </select>
            <div className="mode-pills">
              {(['ask', 'agent', 'auto'] as const).map((m) => (
                <button
                  key={m}
                  className={`mode-pill${mode === m ? ' mode-pill--active' : ''}`}
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
            messages={messages.messages}
            current={messages.current}
            running={messages.running}
            permission={messages.permission}
            onPermissionRespond={handlePermission}
            scrollRef={scrollRef}
          />
          <ScrollFab scrollRef={scrollRef} />
          <ChatInput
            onSend={handleSend}
            onStop={handleStop}
            onInterrupt={handleInterrupt}
            running={messages.running}
            initialText={searchParams.get('prompt') || undefined}
            voice={voice}
            branch={messages.branch || undefined}
            isWorktree={messages.isWorktree}
            wtId={messages.wtId || undefined}
            sessionId={activeSessionId ?? undefined}
            externalContextBlocks={contextBlocks}
            tokenState={tokens}
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
          sessionId={activeSessionId ?? undefined}
          branch={messages.branch || undefined}
          isWorktree={messages.isWorktree}
          wtId={messages.wtId || undefined}
        />
      }
    />
  );
}
