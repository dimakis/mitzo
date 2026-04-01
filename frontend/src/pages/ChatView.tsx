import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { MessageBubble } from '../components/MessageBubble';
import { ToolPill } from '../components/ToolPill';
import { ToolGroup } from '../components/ToolGroup';
import { PermissionBanner } from '../components/PermissionBanner';
import { ChatInput } from '../components/ChatInput';
import { groupMessages } from '../lib/groupMessages';
import type { Message, PermissionRequest, ImageAttachment } from '../types/chat';

export function ChatView() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<Message[]>([]);
  const [running, setRunning] = useState(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(sessionId);
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [mode, setMode] = useState<'ask' | 'agent' | 'auto'>(
    searchParams.get('extraTools') ? 'auto' : 'agent',
  );

  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const streamBuf = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalClose = useRef(false);
  const serverClientId = useRef<string | null>(null);
  const wasRunning = useRef(false);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!isNearBottom()) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, [isNearBottom]);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    const cacheKey = `mitzo-chat-${sessionId}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        const restored = JSON.parse(cached) as Message[];
        if (restored.length > 0) {
          setMessages(restored);
          setTimeout(forceScrollToBottom, 100);
          return;
        }
      } catch {
        // Corrupted cache — fall through to server
      }
    }

    fetch(`/api/sessions/${sessionId}/messages`)
      .then((r) => (r.ok ? r.json() : []))
      .then(
        (
          msgs: Array<{
            role: string;
            text?: string;
            toolCalls?: Array<{ toolName: string; toolId: string; input: string }>;
            toolResults?: Array<{ toolId: string; result: string }>;
          }>,
        ) => {
          const loaded: Message[] = [];
          for (const m of msgs) {
            if (m.text) {
              loaded.push({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text });
            }
            if (m.toolCalls) {
              for (const tc of m.toolCalls) {
                loaded.push({
                  role: 'tool',
                  toolName: tc.toolName,
                  toolId: tc.toolId,
                  toolInput: tc.input,
                });
              }
            }
            if (m.toolResults) {
              for (const tr of m.toolResults) {
                loaded.push({ role: 'tool', toolId: tr.toolId, toolResult: tr.result });
              }
            }
          }
          if (loaded.length > 0) {
            setMessages(loaded);
            setTimeout(forceScrollToBottom, 100);
          }
        },
      )
      .catch(() => {});
  }, [sessionId, forceScrollToBottom]);

  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      sessionStorage.setItem(`mitzo-chat-${currentSessionId}`, JSON.stringify(messages));
    }
  }, [messages, currentSessionId]);

  useEffect(() => {
    intentionalClose.current = false;

    function connectWs() {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/chat`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        switch (msg.type) {
          case 'client_id':
            if (wasRunning.current && serverClientId.current) {
              ws.send(JSON.stringify({ type: 'reattach', clientId: serverClientId.current }));
            }
            serverClientId.current = msg.clientId as string;
            break;

          case 'reattached':
            serverClientId.current = msg.clientId as string;
            setRunning(true);
            if (msg.sessionId) setCurrentSessionId(msg.sessionId as string);
            break;

          case 'reattach_failed':
            wasRunning.current = false;
            setRunning(false);
            break;

          case 'session_id':
            setCurrentSessionId(msg.sessionId as string);
            break;

          case 'text_delta':
            streamBuf.current += msg.text as string;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.streaming) {
                return [
                  ...prev.slice(0, -1),
                  { role: 'assistant' as const, text: streamBuf.current, streaming: true },
                ];
              }
              return [
                ...prev,
                { role: 'assistant' as const, text: streamBuf.current, streaming: true },
              ];
            });
            scrollToBottom();
            break;

          case 'text':
            streamBuf.current = '';
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.streaming) {
                return [
                  ...prev.slice(0, -1),
                  { role: 'assistant' as const, text: msg.text as string },
                ];
              }
              return [...prev, { role: 'assistant' as const, text: msg.text as string }];
            });
            scrollToBottom();
            break;

          case 'tool_call':
            streamBuf.current = '';
            setMessages((prev) => [
              ...prev,
              {
                role: 'tool' as const,
                toolName: msg.toolName as string,
                toolId: msg.toolId as string,
                toolInput: msg.input as string,
              },
            ]);
            scrollToBottom();
            break;

          case 'tool_result':
            setMessages((prev) =>
              prev.map((m) =>
                m.toolId === msg.toolId ? { ...m, toolResult: msg.result as string } : m,
              ),
            );
            scrollToBottom();
            break;

          case 'permission_request':
            setPermission({
              permId: msg.permId as string,
              toolName: msg.toolName as string,
              toolInput: msg.toolInput as string,
            });
            break;

          case 'permission_timeout':
            setPermission((prev) => (prev?.permId === msg.permId ? null : prev));
            break;

          case 'done': {
            if (streamBuf.current) {
              const text = streamBuf.current;
              streamBuf.current = '';
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last.streaming) {
                  return [...prev.slice(0, -1), { role: 'assistant' as const, text }];
                }
                return [...prev, { role: 'assistant' as const, text }];
              });
            }
            setRunning(false);
            wasRunning.current = false;
            if (msg.sessionId) setCurrentSessionId(msg.sessionId as string);
            break;
          }

          case 'error':
            streamBuf.current = '';
            setRunning(false);
            wasRunning.current = false;
            if ((msg.error as string)?.includes('No conversation found')) {
              setCurrentSessionId(undefined);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant' as const,
                  text: 'Session expired. Send your message again to start fresh.',
                },
              ]);
            } else {
              setMessages((prev) => [
                ...prev,
                { role: 'assistant' as const, text: `**Error:** ${msg.error}` },
              ]);
            }
            scrollToBottom();
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (!intentionalClose.current) {
          const delay = 2000 + Math.random() * 2000;
          reconnectTimer.current = setTimeout(connectWs, delay);
        }
      };

      ws.onerror = () => {};
    }

    const initTimer = setTimeout(connectWs, 100);

    const handleVisibility = () => {
      if (
        document.visibilityState === 'visible' &&
        (!wsRef.current || wsRef.current.readyState > WebSocket.OPEN)
      ) {
        connectWs();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      intentionalClose.current = true;
      clearTimeout(initTimer);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const initialPrompt = searchParams.get('prompt') || undefined;

  function sendMessage(text: string, images?: ImageAttachment[]) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: '**Connection lost.** Reconnecting — try again in a moment.',
        },
      ]);
      return;
    }

    const previews = images?.map((img) => img.preview);
    setMessages((prev) => [...prev, { role: 'user', text, images: previews }]);
    setRunning(true);
    wasRunning.current = true;
    streamBuf.current = '';

    const payload: Record<string, unknown> = { type: 'send', prompt: text, model, mode };
    if (currentSessionId) payload.resume = currentSessionId;
    if (images?.length) {
      payload.images = images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
    }

    const cwd = searchParams.get('cwd');
    if (cwd) payload.cwd = cwd;
    const extraTools = searchParams.get('extraTools');
    if (extraTools) payload.extraTools = extraTools;

    ws.send(JSON.stringify(payload));
    forceScrollToBottom();
  }

  const handleStop = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'stop' }));
    wasRunning.current = false;
  }, []);

  const handlePermission = useCallback(
    (permId: string, decision: 'once' | 'always' | 'deny', toolName: string) => {
      wsRef.current?.send(
        JSON.stringify({ type: 'permission_response', permId, decision, toolName }),
      );
      setPermission(null);
    },
    [],
  );

  function handleModeChange(newMode: 'ask' | 'agent' | 'auto') {
    setMode(newMode);
    if (running) {
      wsRef.current?.send(JSON.stringify({ type: 'set_mode', mode: newMode }));
    }
  }

  const grouped = useMemo(() => groupMessages(messages), [messages]);

  return (
    <div className="chat-page">
      <header className="chat-header">
        <button className="chat-header-back" onClick={() => navigate('/')}>
          &larr;
        </button>
        {!connected && (
          <span
            className="chat-header-offline"
            title={running ? 'Reconnecting — session still active' : 'Reconnecting...'}
          >
            !
          </span>
        )}
        <select
          className="chat-model-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={running}
        >
          <option value="claude-sonnet-4-6">Sonnet</option>
          <option value="claude-opus-4-6">Opus</option>
          <option value="claude-haiku-4-5">Haiku</option>
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
        {running && (
          <button className="chat-header-stop" onClick={handleStop}>
            Stop
          </button>
        )}
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !running && <p className="chat-empty">Send a message to start</p>}
        {grouped.map((item, i) => {
          if (item.type === 'tool-group') {
            return <ToolGroup key={`tg-${i}`} tools={item.tools} />;
          }
          const msg = item.message;
          if (msg.role === 'tool') {
            return <ToolPill key={msg.toolId || `t-${i}`} message={msg} />;
          }
          return <MessageBubble key={`m-${i}`} message={msg} />;
        })}
      </div>

      {permission && (
        <PermissionBanner
          permId={permission.permId}
          toolName={permission.toolName}
          toolInput={permission.toolInput}
          onRespond={handlePermission}
        />
      )}

      <ChatInput
        onSend={sendMessage}
        onStop={handleStop}
        running={running}
        initialText={initialPrompt}
      />
    </div>
  );
}
