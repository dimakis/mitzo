import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { DesktopShell } from '../components/DesktopShell';
import { SessionPanel } from '../components/SessionPanel';
import { ContextPanel } from '../components/ContextPanel';
import { FileBrowserPanel } from '../components/FileBrowserPanel';
import { ChatArea } from '../components/ChatArea';
import { ChatInput } from '../components/ChatInput';
import { StatusBar } from '../components/StatusBar';
import { wsIsOpen, wsSend, wsSetRunning } from '../lib/ws-pool';
import { SCROLL_RESTORE_DELAY_MS, LAST_SESSION_KEY } from '../lib/constants';
import { useChatSession } from '../hooks/useChatSession';
import { useChatMessages } from '../hooks/useChatMessages';
import { useChatConnection } from '../hooks/useChatConnection';
import { usePermission } from '../hooks/usePermission';
import { useVoice } from '../hooks/useVoice';
import { useAutoSpeak } from '../hooks/useAutoSpeak';
import type { ImageAttachment } from '../types/chat';

function generateClientMsgId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function DesktopChatView() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [contextBlocks, setContextBlocks] = useState<string[]>([]);

  const [sessionState, sessionActions, poolKey] = useChatSession(
    sessionId,
    searchParams.get('extraTools') ? 'auto' : 'agent',
  );

  const voice = useVoice();
  const scrollRef = useRef<HTMLDivElement>(null);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  const handleSessionExpired = useCallback(
    (staleId: string | undefined) => {
      sessionActions.setCurrentSessionId(undefined);
      if (staleId) localStorage.removeItem(LAST_SESSION_KEY);
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

  useEffect(() => {
    dispatch({ type: 'CLEAR' });
  }, [sessionId, dispatch]);

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

  const { connected } = useChatConnection(poolKey, handleWsMessage);

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

  function buildSendPayload(
    text: string,
    clientMsgId: string,
    images?: ImageAttachment[],
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      type: 'send',
      prompt: text,
      clientMsgId,
      model: sessionState.model,
      mode: sessionState.mode,
    };
    if (sessionState.currentSessionId) payload.resume = sessionState.currentSessionId;
    if (images?.length) {
      payload.images = images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
    }
    if (sessionState.sandbox && !sessionState.currentSessionId) payload.worktree = true;
    const cwd = searchParams.get('cwd');
    if (cwd) payload.cwd = cwd;
    const extraTools = searchParams.get('extraTools');
    if (extraTools) payload.extraTools = extraTools;
    return payload;
  }

  function sendMessage(text: string, images?: ImageAttachment[], ctxBlocks?: string[]): boolean {
    if (!wsIsOpen(poolKey)) {
      dispatch({ type: 'CONNECTION_LOST' });
      return false;
    }
    voice.stopSpeaking();
    const clientMsgId = generateClientMsgId();
    const payload = buildSendPayload(text, clientMsgId, images);
    if (ctxBlocks?.length) payload.contextBlocks = ctxBlocks;
    const previews = images?.map((img) => img.preview);
    if (msgState.running) {
      wsSend(poolKey, payload);
      dispatch({
        type: 'USER_SEND',
        text,
        clientMsgId,
        images: previews,
        contextBlocks: ctxBlocks,
      });
    } else {
      wsSetRunning(poolKey, true);
      wsSend(poolKey, payload);
      dispatch({
        type: 'USER_SEND',
        text,
        clientMsgId,
        images: previews,
        contextBlocks: ctxBlocks,
      });
    }
    forceScrollToBottom();
    return true;
  }

  function interruptMessage(text: string, images?: ImageAttachment[], ctxBlocks?: string[]): void {
    if (!wsIsOpen(poolKey) || !msgState.running) return;
    const clientMsgId = generateClientMsgId();
    const imagePayload = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
    const previews = images?.map((img) => img.preview);
    wsSend(poolKey, {
      type: 'interrupt',
      prompt: text,
      clientMsgId,
      images: imagePayload,
      ...(ctxBlocks?.length ? { contextBlocks: ctxBlocks } : {}),
    });
    dispatch({ type: 'USER_SEND', text, clientMsgId, images: previews, contextBlocks: ctxBlocks });
    forceScrollToBottom();
  }

  const handleStop = useCallback(() => {
    pendingSend.current = null;
    wsSend(poolKey, { type: 'stop' });
    wsSetRunning(poolKey, false);
    dispatch({ type: 'SET_RUNNING', running: false });
  }, [poolKey, dispatch, pendingSend]);

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
            sandbox={sessionState.sandbox}
            onSandboxToggle={() => sessionActions.setSandbox(!sessionState.sandbox)}
            sandboxDisabled={msgState.messages.some((m) => m.role === 'user')}
            externalContextBlocks={contextBlocks}
          />
        </div>
      }
      right={
        <div className="desktop-right-panels">
          <ContextPanel selected={contextBlocks} onToggle={handleToggleContext} />
          <FileBrowserPanel />
        </div>
      }
      statusBar={
        <StatusBar
          connected={connected}
          sessionId={sessionState.currentSessionId}
          branch={msgState.branch || undefined}
          isWorktree={msgState.isWorktree}
        />
      }
    />
  );
}
