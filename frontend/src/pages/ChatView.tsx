import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { MessageBubble } from '../components/MessageBubble';
import { ThinkingBlock } from '../components/ThinkingBlock';
import { ToolPill } from '../components/ToolPill';
import { ToolGroup } from '../components/ToolGroup';
import { PermissionBanner } from '../components/PermissionBanner';
import { ChatInput } from '../components/ChatInput';
import { MitzoLogo } from '../components/MitzoLogo';
import { groupMessages } from '../lib/groupMessages';
import { wsIsOpen, wsSend, wsSetRunning } from '../lib/ws-pool';
import {
  SCROLL_NEAR_BOTTOM_PX,
  SCROLL_RESTORE_DELAY_MS,
  CHAT_CACHE_KEY_PREFIX,
  LAST_SESSION_KEY,
} from '../lib/constants';
import { useChatSession } from '../hooks/useChatSession';
import { useChatMessages } from '../hooks/useChatMessages';
import { useChatConnection } from '../hooks/useChatConnection';
import { usePermission } from '../hooks/usePermission';
import type { ImageAttachment } from '../types/chat';

export function ChatView() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [sessionState, sessionActions, poolKey] = useChatSession(
    sessionId,
    searchParams.get('extraTools') ? 'auto' : 'agent',
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  // Auto-scroll during streaming: follow new content if user is near the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom <= SCROLL_NEAR_BOTTOM_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgState.messages]);

  const handleSessionExpired = useCallback(
    (staleId: string | undefined) => {
      sessionActions.setCurrentSessionId(undefined);
      if (staleId) {
        localStorage.removeItem(`${CHAT_CACHE_KEY_PREFIX}${staleId}`);
        localStorage.removeItem(LAST_SESSION_KEY);
      }
      if (sessionId) {
        navigate('/chat', { replace: true });
      }
    },
    [sessionId, navigate, sessionActions],
  );

  const {
    state: msgState,
    dispatch,
    pendingSend,
    handleWsMessage,
  } = useChatMessages(
    poolKey,
    sessionState.currentSessionId,
    sessionActions.setCurrentSessionId,
    handleSessionExpired,
  );

  // Restore messages from cache/API on mount for existing sessions
  const restoreAttempted = useRef(false);
  if (sessionId && !restoreAttempted.current) {
    restoreAttempted.current = true;
    const cacheKey = `${CHAT_CACHE_KEY_PREFIX}${sessionId}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const restored = JSON.parse(cached);
        if (restored.length > 0) {
          dispatch({ type: 'RESTORE', messages: restored });
          setTimeout(forceScrollToBottom, SCROLL_RESTORE_DELAY_MS);
        }
      } catch {
        // Corrupted cache — fall through
      }
    }
    if (!cached) {
      fetch(`/api/sessions/${sessionId}/messages`)
        .then((r) => (r.ok ? r.json() : []))
        .then((msgs: unknown[]) => {
          if (msgs.length > 0) {
            dispatch({ type: 'RESTORE', messages: msgs as import('../types/chat').Message[] });
            setTimeout(forceScrollToBottom, SCROLL_RESTORE_DELAY_MS);
          }
        })
        .catch(() => {
          // Network error — non-fatal
        });
    }
  }

  const { connected } = useChatConnection(poolKey, handleWsMessage);

  const { handlePermission } = usePermission(poolKey, () => {
    dispatch({ type: 'PERMISSION_TIMEOUT', permId: msgState.permission?.permId ?? '' });
  });

  const hasStarted = msgState.messages.some((m) => m.role === 'user');

  function sendMessage(text: string, images?: ImageAttachment[]): boolean {
    if (!wsIsOpen(poolKey)) {
      dispatch({ type: 'CONNECTION_LOST' });
      return false;
    }

    const payload: Record<string, unknown> = {
      type: 'send',
      prompt: text,
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

    if (msgState.running) {
      pendingSend.current = payload;
      wsSend(poolKey, { type: 'stop' });
    } else {
      wsSetRunning(poolKey, true);
      wsSend(poolKey, payload);
    }

    const previews = images?.map((img) => img.preview);
    dispatch({ type: 'USER_SEND', text, images: previews });
    forceScrollToBottom();
    return true;
  }

  const handleStop = useCallback(() => {
    wsSend(poolKey, { type: 'stop' });
    wsSetRunning(poolKey, false);
    dispatch({ type: 'SET_RUNNING', running: false });
  }, [poolKey, dispatch]);

  function handleModeChange(newMode: 'ask' | 'agent' | 'auto') {
    sessionActions.setMode(newMode);
    if (msgState.running) {
      wsSend(poolKey, { type: 'set_mode', mode: newMode });
    }
  }

  const grouped = useMemo(
    () => groupMessages(msgState.messages, msgState.running),
    [msgState.messages, msgState.running],
  );
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
        <button
          className={`chat-header-sandbox${sessionState.sandbox || msgState.isWorktree ? ' chat-header-sandbox--active' : ''}`}
          onClick={() => sessionActions.setSandbox(!sessionState.sandbox)}
          disabled={hasStarted}
          title={
            msgState.isWorktree
              ? 'Running in sandbox worktree'
              : sessionState.sandbox
                ? 'Sandbox on — will create worktree'
                : 'Sandbox off — using base repo'
          }
        >
          {msgState.isWorktree ? '⎔' : sessionState.sandbox ? '⎔' : '⎕'}
        </button>
        {msgState.branch && (
          <span
            className={`chat-header-branch${msgState.isWorktree ? ' chat-header-branch--wt' : ''}`}
          >
            {msgState.branch}
          </span>
        )}
        {msgState.running && (
          <button className="chat-header-stop" onClick={handleStop}>
            Stop
          </button>
        )}
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {msgState.messages.length === 0 && !msgState.running && (
          <p className="chat-empty">Send a message to start</p>
        )}
        {grouped.map((item, i) => {
          if (item.type === 'tool-group') {
            return <ToolGroup key={`tg-${i}`} tools={item.tools} />;
          }
          const msg = item.message;
          if (msg.role === 'thinking') {
            return <ThinkingBlock key={`th-${i}`} message={msg} />;
          }
          if (msg.role === 'tool') {
            return <ToolPill key={msg.toolId || `t-${i}`} message={msg} />;
          }
          return <MessageBubble key={`m-${i}`} message={msg} />;
        })}
      </div>

      {msgState.permission && (
        <PermissionBanner
          permId={msgState.permission.permId}
          toolName={msgState.permission.toolName}
          toolInput={msgState.permission.toolInput}
          title={msgState.permission.title}
          description={msgState.permission.description}
          displayName={msgState.permission.displayName}
          tier={msgState.permission.tier}
          onRespond={handlePermission}
        />
      )}

      <ChatInput
        onSend={sendMessage}
        onStop={handleStop}
        running={msgState.running}
        initialText={initialPrompt}
      />
    </div>
  );
}
