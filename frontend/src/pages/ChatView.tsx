import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { MessageBubble } from '../components/MessageBubble';
import { ToolPill } from '../components/ToolPill';
import { ToolGroup } from '../components/ToolGroup';
import { PermissionBanner } from '../components/PermissionBanner';
import { ChatInput } from '../components/ChatInput';
import { groupMessages } from '../lib/groupMessages';
import { wsSubscribe, wsSend, wsIsOpen, wsSetRunning } from '../lib/ws-pool';
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
  const [sandbox, setSandbox] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [isWorktree, setIsWorktree] = useState(false);
  const [connected, setConnected] = useState(false);

  const hasStarted = messages.some((m) => m.role === 'user');

  // Stable pool key: existing sessions use "session:<id>", new sessions
  // use a per-mount uid so they don't collide with each other.
  const newSessionUid = useRef(`new:${Math.random().toString(36).slice(2)}`);
  const poolKey = sessionId ? `session:${sessionId}` : newSessionUid.current;

  const streamBuf = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const pendingSend = useRef<Record<string, unknown> | null>(null);

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

  // Persist last session
  useEffect(() => {
    if (currentSessionId) {
      localStorage.setItem('mitzo-last-session', currentSessionId);
    }
  }, [currentSessionId]);

  // Restore messages from cache on mount
  useEffect(() => {
    const resolvedId = sessionId ?? localStorage.getItem('mitzo-last-session') ?? undefined;
    if (!resolvedId) return;

    const cacheKey = `mitzo-chat-${resolvedId}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const restored = JSON.parse(cached) as Message[];
        if (restored.length > 0) {
          setMessages(restored);
          setTimeout(forceScrollToBottom, 100);
          return;
        }
      } catch {
        /* ignore */
      }
    }

    fetch(`/api/sessions/${resolvedId}/messages`)
      .then((r) => (r.ok ? r.json() : []))
      .then((msgs: Message[]) => {
        if (msgs.length > 0) {
          setMessages(msgs);
          setTimeout(forceScrollToBottom, 100);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    const id = currentSessionIdRef.current;
    if (!id || messages.length === 0) return;
    try {
      localStorage.setItem(`mitzo-chat-${id}`, JSON.stringify(messages));
    } catch {
      /* ignore quota errors */
    }
  }, [messages, currentSessionId]);

  // Subscribe to the pool connection for this session key.
  // Unsubscribing on unmount does NOT close the WS — the connection
  // stays alive in the pool so in-flight agent runs continue.
  useEffect(() => {
    const unsubscribe = wsSubscribe(poolKey, (msg) => {
      switch (msg.type) {
        case '_open':
          setConnected(true);
          break;

        case '_close':
          setConnected(false);
          break;

        case 'reattached':
          setConnected(true);
          setRunning(true);
          wsSetRunning(poolKey, true);
          if (msg.sessionId) setCurrentSessionId(msg.sessionId as string);
          break;

        case 'reattach_failed':
          setRunning(false);
          wsSetRunning(poolKey, false);
          break;

        case 'session_info':
          setBranch(msg.branch as string);
          setIsWorktree(msg.worktree as boolean);
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
            title: msg.title as string | undefined,
            description: msg.description as string | undefined,
            displayName: msg.displayName as string | undefined,
            tier: msg.tier as import('../types/chat').ToolTier | undefined,
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
          if (msg.sessionId && !currentSessionIdRef.current) {
            setCurrentSessionId(msg.sessionId as string);
          }
          const pending = pendingSend.current;
          if (pending) {
            pendingSend.current = null;
            setRunning(true);
            wsSetRunning(poolKey, true);
            streamBuf.current = '';
            wsSend(poolKey, pending);
          } else {
            setRunning(false);
            wsSetRunning(poolKey, false);
          }
          break;
        }

        case 'error':
          streamBuf.current = '';
          pendingSend.current = null;
          setRunning(false);
          wsSetRunning(poolKey, false);
          if ((msg.error as string)?.includes('No conversation found')) {
            const staleId = currentSessionIdRef.current;
            setCurrentSessionId(undefined);
            if (staleId) {
              localStorage.removeItem(`mitzo-chat-${staleId}`);
              localStorage.removeItem('mitzo-last-session');
            }
            if (sessionId) {
              navigate('/chat', { replace: true });
            }
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
    });

    // Sync connected state on subscribe (pool may already be open)
    setConnected(wsIsOpen(poolKey));

    return unsubscribe; // unsubscribe only — connection stays alive
  }, [poolKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const initialPrompt = searchParams.get('prompt') || undefined;

  function sendMessage(text: string, images?: ImageAttachment[]): boolean {
    if (!wsIsOpen(poolKey)) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: '**Connection lost.** Reconnecting — try again in a moment.',
        },
      ]);
      return false;
    }

    const payload: Record<string, unknown> = { type: 'send', prompt: text, model, mode };
    if (currentSessionId) payload.resume = currentSessionId;
    if (images?.length) {
      payload.images = images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
    }
    if (sandbox && !currentSessionId) payload.worktree = true;

    const cwd = searchParams.get('cwd');
    if (cwd) payload.cwd = cwd;
    const extraTools = searchParams.get('extraTools');
    if (extraTools) payload.extraTools = extraTools;

    if (running) {
      // Queue the send to fire once the current run finishes stopping
      pendingSend.current = payload;
      wsSend(poolKey, { type: 'stop' });
      const previews = images?.map((img) => img.preview);
      setMessages((prev) => [...prev, { role: 'user', text, images: previews }]);
      streamBuf.current = '';
      forceScrollToBottom();
      return true;
    }

    const previews = images?.map((img) => img.preview);
    setMessages((prev) => [...prev, { role: 'user', text, images: previews }]);
    setRunning(true);
    wsSetRunning(poolKey, true);
    streamBuf.current = '';

    wsSend(poolKey, payload);
    forceScrollToBottom();
    return true;
  }

  const handleStop = useCallback(() => {
    wsSend(poolKey, { type: 'stop' });
    wsSetRunning(poolKey, false);
    setRunning(false);
    streamBuf.current = '';
  }, [poolKey]);

  const handlePermission = useCallback(
    (permId: string, decision: 'once' | 'always' | 'deny', toolName: string) => {
      wsSend(poolKey, { type: 'permission_response', permId, decision, toolName });
      setPermission(null);
    },
    [poolKey],
  );

  function handleModeChange(newMode: 'ask' | 'agent' | 'auto') {
    setMode(newMode);
    if (running) {
      wsSend(poolKey, { type: 'set_mode', mode: newMode });
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
        <button
          className={`chat-header-sandbox${sandbox || isWorktree ? ' chat-header-sandbox--active' : ''}`}
          onClick={() => setSandbox((s) => !s)}
          disabled={hasStarted}
          title={
            isWorktree
              ? 'Running in sandbox worktree'
              : sandbox
                ? 'Sandbox on — will create worktree'
                : 'Sandbox off — using base repo'
          }
        >
          {isWorktree ? 'WT' : sandbox ? 'WT' : 'WT'}
        </button>
        {branch && (
          <span className={`chat-header-branch${isWorktree ? ' chat-header-branch--wt' : ''}`}>
            {branch}
          </span>
        )}
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
          title={permission.title}
          description={permission.description}
          displayName={permission.displayName}
          tier={permission.tier}
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
