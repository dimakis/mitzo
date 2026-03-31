import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { MessageBubble } from '../components/MessageBubble';
import { PermissionBanner } from '../components/PermissionBanner';
import { ChatInput } from '../components/ChatInput';

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  toolResult?: string;
  streaming?: boolean;
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
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(
    sessionId
  );
  const [model, setModel] = useState('claude-sonnet-4-6');

  const wsRef = useRef<WebSocket | null>(null);
  const streamBuf = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasSentInitial = useRef(false);
  const wsReady = useRef(false);

  const scrollToBottom = useCallback(() => {
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

  // Load existing session history
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/sessions/${sessionId}/messages`)
      .then((r) => r.ok ? r.json() : [])
      .then((msgs: Array<{ role: string; text?: string; toolCalls?: any[]; toolResults?: any[] }>) => {
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
          setTimeout(scrollToBottom, 100);
        }
      })
      .catch(() => {});
  }, [sessionId, scrollToBottom]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/chat`);
    wsRef.current = ws;

    ws.onopen = () => {
      wsReady.current = true;
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
            return [
              ...prev,
              { role: 'assistant', text: streamBuf.current, streaming: true },
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
                { role: 'assistant', text: msg.text },
              ];
            }
            return [...prev, { role: 'assistant', text: msg.text }];
          });
          scrollToBottom();
          break;

        case 'tool_call':
          finalizeStream();
          setMessages((prev) => [
            ...prev,
            {
              role: 'tool',
              toolName: msg.toolName,
              toolId: msg.toolId,
              toolInput: msg.input,
            },
          ]);
          scrollToBottom();
          break;

        case 'tool_result':
          setMessages((prev) =>
            prev.map((m) =>
              m.toolId === msg.toolId ? { ...m, toolResult: msg.result } : m
            )
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
          if (permission?.permId === msg.permId) {
            setPermission(null);
          }
          break;

        case 'done':
          finalizeStream();
          setRunning(false);
          if (msg.sessionId) setCurrentSessionId(msg.sessionId);
          break;

        case 'error':
          finalizeStream();
          setRunning(false);
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', text: `**Error:** ${msg.error}` },
          ]);
          scrollToBottom();
          break;
      }
    };

    ws.onclose = () => {
      setRunning(false);
    };

    return () => {
      ws.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (hasSentInitial.current) return;
    const prompt = searchParams.get('prompt');
    if (!prompt) return;

    function trySend() {
      if (hasSentInitial.current) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        hasSentInitial.current = true;
        sendMessage(prompt!);
      } else {
        setTimeout(trySend, 100);
      }
    }

    trySend();
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  function sendMessage(text: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    setMessages((prev) => [...prev, { role: 'user', text }]);
    setRunning(true);
    streamBuf.current = '';

    const payload: Record<string, any> = { type: 'send', prompt: text, model };
    if (currentSessionId) payload.resume = currentSessionId;

    const cwd = searchParams.get('cwd');
    if (cwd) payload.cwd = cwd;

    const extraTools = searchParams.get('extraTools');
    if (extraTools) payload.extraTools = extraTools;

    ws.send(JSON.stringify(payload));
    scrollToBottom();
  }

  function handleStop() {
    wsRef.current?.send(JSON.stringify({ type: 'stop' }));
  }

  function handlePermission(permId: string, allowed: boolean) {
    wsRef.current?.send(
      JSON.stringify({ type: 'permission_response', permId, allowed })
    );
    setPermission(null);
  }

  return (
    <div className="chat-page">
      <header className="chat-header">
        <button className="chat-header-back" onClick={() => navigate('/')}>
          &larr;
        </button>
        <select
          className="chat-model-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={running}
        >
          <option value="claude-sonnet-4-6">Sonnet 4.6</option>
          <option value="claude-opus-4-6">Opus 4.6</option>
          <option value="claude-haiku-4-5">Haiku 4.5</option>
        </select>
        {running && (
          <button className="chat-header-stop" onClick={handleStop}>
            Stop
          </button>
        )}
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !running && (
          <p className="chat-empty">Send a message to start</p>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
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
      />
    </div>
  );
}
