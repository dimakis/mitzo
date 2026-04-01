import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { MessageBubble } from '../components/MessageBubble';
import { ToolPill } from '../components/ToolPill';
import { ToolGroup } from '../components/ToolGroup';
import { PermissionBanner } from '../components/PermissionBanner';
import { ChatInput, type ImageAttachment } from '../components/ChatInput';

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  images?: string[];
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  toolResult?: string;
  streaming?: boolean;
}

type GroupedItem = { type: 'message'; message: Message } | { type: 'tool-group'; tools: Message[] };

function groupMessages(messages: Message[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let toolBuffer: Message[] = [];

  function flushTools() {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length >= 3) {
      result.push({ type: 'tool-group', tools: toolBuffer });
    } else {
      for (const t of toolBuffer) {
        result.push({ type: 'message', message: t });
      }
    }
    toolBuffer = [];
  }

  for (const msg of messages) {
    if (msg.role === 'tool') {
      toolBuffer.push(msg);
    } else {
      flushTools();
      result.push({ type: 'message', message: msg });
    }
  }
  flushTools();
  return result;
}

interface PermissionRequest {
  permId: string;
  toolName: string;
  toolInput: string;
}

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
  const lastPayload = useRef<string | null>(null);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!isNearBottom()) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
  }, [isNearBottom]);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
  }, []);

  const finalizeStream = useCallback(() => {
    if (!streamBuf.current) return;
    const text = streamBuf.current;
    streamBuf.current = '';
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { role: 'assistant', text }];
      }
      return [...prev, { role: 'assistant', text }];
    });
  }, []);

  // Restore session history: try sessionStorage first, then server
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
        (msgs: Array<{ role: string; text?: string; toolCalls?: any[]; toolResults?: any[] }>) => {
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
                loaded.push({
                  role: 'tool',
                  toolId: tr.toolId,
                  toolResult: tr.result,
                });
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

  // Persist messages to sessionStorage on every update
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

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'session_id':
            setCurrentSessionId(msg.sessionId);
            break;

          case 'text_delta':
            streamBuf.current += msg.text;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.streaming) {
                return [
                  ...prev.slice(0, -1),
                  { role: 'assistant', text: streamBuf.current, streaming: true },
                ];
              }
              return [...prev, { role: 'assistant', text: streamBuf.current, streaming: true }];
            });
            scrollToBottom();
            break;

          case 'text':
            streamBuf.current = '';
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.streaming) {
                return [...prev.slice(0, -1), { role: 'assistant', text: msg.text }];
              }
              return [...prev, { role: 'assistant', text: msg.text }];
            });
            scrollToBottom();
            break;

          case 'tool_call':
            streamBuf.current = '';
            setMessages((prev) => {
              const newPrev = streamBuf.current ? [...prev] : prev;
              return [
                ...newPrev,
                { role: 'tool', toolName: msg.toolName, toolId: msg.toolId, toolInput: msg.input },
              ];
            });
            scrollToBottom();
            break;

          case 'tool_result':
            setMessages((prev) =>
              prev.map((m) => (m.toolId === msg.toolId ? { ...m, toolResult: msg.result } : m)),
            );
            scrollToBottom();
            break;

          case 'permission_request':
            setPermission({
              permId: msg.permId,
              toolName: msg.toolName,
              toolInput: msg.toolInput,
            });
            break;

          case 'permission_timeout':
            setPermission((prev) => (prev?.permId === msg.permId ? null : prev));
            break;

          case 'done':
            if (streamBuf.current) {
              const text = streamBuf.current;
              streamBuf.current = '';
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last.streaming) {
                  return [...prev.slice(0, -1), { role: 'assistant', text }];
                }
                return [...prev, { role: 'assistant', text }];
              });
            }
            setRunning(false);
            if (msg.sessionId) setCurrentSessionId(msg.sessionId);
            break;

          case 'error':
            streamBuf.current = '';
            setRunning(false);
            if (msg.error?.includes('No conversation found')) {
              setCurrentSessionId(undefined);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  text: 'Session expired. Send your message again to start fresh.',
                },
              ]);
            } else {
              setMessages((prev) => [
                ...prev,
                { role: 'assistant', text: `**Error:** ${msg.error}` },
              ]);
            }
            scrollToBottom();
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setRunning(false);
        wsRef.current = null;

        if (!intentionalClose.current) {
          const delay = 2000 + Math.random() * 2000;
          reconnectTimer.current = setTimeout(connectWs, delay);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
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
        { role: 'assistant', text: '**Connection lost.** Reconnecting — try again in a moment.' },
      ]);
      return;
    }

    const previews = images?.map((img) => img.preview);
    setMessages((prev) => [...prev, { role: 'user', text, images: previews }]);
    setRunning(true);
    streamBuf.current = '';

    const payload: Record<string, any> = { type: 'send', prompt: text, model, mode };
    if (currentSessionId) payload.resume = currentSessionId;
    if (images?.length) {
      payload.images = images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
    }

    const cwd = searchParams.get('cwd');
    if (cwd) payload.cwd = cwd;

    const extraTools = searchParams.get('extraTools');
    if (extraTools) payload.extraTools = extraTools;

    const payloadStr = JSON.stringify(payload);
    lastPayload.current = payloadStr;
    ws.send(payloadStr);
    forceScrollToBottom();
  }

  function handleStop() {
    wsRef.current?.send(JSON.stringify({ type: 'stop' }));
  }

  function handlePermission(
    permId: string,
    decision: 'once' | 'always' | 'deny',
    toolName: string,
  ) {
    wsRef.current?.send(
      JSON.stringify({ type: 'permission_response', permId, decision, toolName }),
    );
    setPermission(null);
  }

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
          <span className="chat-header-offline" title="Reconnecting...">
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
