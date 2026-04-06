import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { UserBubble, TextBubble } from '../components/MessageBubble';
import { ThinkingBlock } from '../components/ThinkingBlock';
import { ToolPill } from '../components/ToolPill';
import { ToolGroup } from '../components/ToolGroup';
import { PermissionBanner } from '../components/PermissionBanner';
import { ChatInput } from '../components/ChatInput';
import { VoiceSettings } from '../components/VoiceSettings';
import { MitzoLogo } from '../components/MitzoLogo';
import { groupBlocks } from '../lib/groupMessages';
import { wsIsOpen, wsSend, wsSetRunning } from '../lib/ws-pool';
import { SCROLL_NEAR_BOTTOM_PX, SCROLL_RESTORE_DELAY_MS, LAST_SESSION_KEY } from '../lib/constants';
import { useChatSession } from '../hooks/useChatSession';
import { useChatMessages } from '../hooks/useChatMessages';
import { useChatConnection } from '../hooks/useChatConnection';
import { usePermission } from '../hooks/usePermission';
import { useVoice } from '../hooks/useVoice';
import { useAutoSpeak } from '../hooks/useAutoSpeak';
import type { FinishedBlock, ImageAttachment } from '../types/chat';

export function ChatView() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

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

  // Auto-scroll during streaming: follow new content if user is near the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom <= SCROLL_NEAR_BOTTOM_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgState.messages, msgState.current]);

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

  const hasStarted = msgState.messages.some((m) => m.role === 'user');

  function buildSendPayload(text: string, images?: ImageAttachment[]): Record<string, unknown> {
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
    return payload;
  }

  function sendMessage(
    text: string,
    images?: ImageAttachment[],
    contextBlocks?: string[],
  ): boolean {
    if (!wsIsOpen(poolKey)) {
      dispatch({ type: 'CONNECTION_LOST' });
      return false;
    }

    // Stop TTS playback when user sends a new message
    voice.stopSpeaking();

    const payload = buildSendPayload(text, images);
    if (contextBlocks?.length) payload.contextBlocks = contextBlocks;
    const previews = images?.map((img) => img.preview);

    if (msgState.running) {
      // Server queues it natively — no client-side stop+re-send needed.
      wsSend(poolKey, payload);
      dispatch({ type: 'USER_SEND', text, images: previews, contextNames: contextBlocks });
      forceScrollToBottom();
    } else {
      wsSetRunning(poolKey, true);
      wsSend(poolKey, payload);
      dispatch({ type: 'USER_SEND', text, images: previews, contextNames: contextBlocks });
      forceScrollToBottom();
    }

    return true;
  }

  function interruptMessage(
    text: string,
    images?: ImageAttachment[],
    contextBlocks?: string[],
  ): void {
    if (!wsIsOpen(poolKey) || !msgState.running) return;
    const imagePayload = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
    wsSend(poolKey, {
      type: 'interrupt',
      prompt: text,
      images: imagePayload,
      ...(contextBlocks?.length ? { contextBlocks } : {}),
    });
  }

  const handleStop = useCallback(() => {
    pendingSend.current = null;
    wsSend(poolKey, { type: 'stop' });
    wsSetRunning(poolKey, false);
    dispatch({ type: 'SET_RUNNING', running: false });
  }, [poolKey, dispatch, pendingSend]);

  function handleModeChange(newMode: 'ask' | 'agent' | 'auto') {
    sessionActions.setMode(newMode);
    if (msgState.running) {
      wsSend(poolKey, { type: 'set_mode', mode: newMode });
    }
  }

  // Group blocks per finished assistant turn for tool collapsing.
  const groupedMessages = useMemo(
    () =>
      msgState.messages.map((msg) => ({
        msg,
        grouped: msg.role === 'assistant' ? groupBlocks(msg.blocks) : null,
      })),
    [msgState.messages],
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
        <VoiceSettings
          ttsAvailable={voice.ttsAvailable}
          ttsEnabled={voice.ttsEnabled}
          speaking={voice.speaking}
          voices={voice.voices}
          selectedVoice={voice.selectedVoice}
          onToggle={() => voice.setTtsEnabled(!voice.ttsEnabled)}
          onVoiceChange={voice.setVoice}
        />
        {msgState.running && (
          <button className="chat-header-stop" onClick={handleStop}>
            Stop
          </button>
        )}
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {msgState.messages.length === 0 && !msgState.current && !msgState.running && (
          <p className="chat-empty">Send a message to start</p>
        )}

        {/* Finished turns */}
        {groupedMessages.map(({ msg, grouped }) => {
          if (msg.role === 'user') {
            const textBlock = msg.blocks.find((b) => b.blockType === 'text');
            return (
              <UserBubble
                key={msg.messageId}
                text={textBlock?.content}
                images={msg.images}
                contextNames={msg.contextNames}
              />
            );
          }

          // Assistant turn — render grouped blocks
          return (
            <div key={msg.messageId} className="msg-turn">
              {(grouped ?? []).map((item, i) => {
                if (item.type === 'tool-group') {
                  return <ToolGroup key={item.key} tools={item.tools} />;
                }
                const block: FinishedBlock = item.block;
                if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking') {
                  return <ThinkingBlock key={block.blockId} block={block} />;
                }
                if (block.blockType === 'tool_use') {
                  return <ToolPill key={block.blockId} block={block} />;
                }
                return (
                  <TextBubble key={block.blockId || `text-${i}`} content={block.content ?? ''} />
                );
              })}
            </div>
          );
        })}

        {/* In-flight streaming turn — rendered inline, no grouping */}
        {msgState.current && (
          <div className="msg-turn msg-turn--streaming">
            {msgState.current.blockOrder.map((blockId) => {
              const block = msgState.current!.blocks.get(blockId)!;
              if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking') {
                return <ThinkingBlock key={block.blockId} block={block} streaming />;
              }
              if (block.blockType === 'tool_use') {
                return <ToolPill key={block.blockId} block={block} />;
              }
              return <TextBubble key={block.blockId} content={block.content ?? ''} streaming />;
            })}
          </div>
        )}
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
        onInterrupt={interruptMessage}
        running={msgState.running}
        initialText={initialPrompt}
        voice={voice}
        branch={msgState.branch || undefined}
        isWorktree={msgState.isWorktree}
      />
    </div>
  );
}
