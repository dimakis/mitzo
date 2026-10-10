import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { isReviewableTerminalCommand, type TerminalInfo } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { CommandHistory } from '../lib/terminal-history';
import { useAssistantName } from '../hooks/useAssistantName';
import { AccountModelPicker, type AccountSelection } from '../components/AccountModelPicker';
import {
  TerminalConsole,
  type TerminalConsoleHandle,
  type TerminalStatus,
} from '../components/TerminalConsole';
import { UiIcon } from '../components/UiIcon';
import type { WorkspaceSummary } from '../types/workspace';
type Message = { role: 'user' | 'assistant'; content: string };
const histories = new Map<string, CommandHistory>();
export function TerminalView() {
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('sessionId') || undefined;
  const back = params.get('returnTo');
  const returnTo =
    back && /^\/chat(?:\/|$)/.test(back) && !back.startsWith('//')
      ? back
      : sessionId && !back
        ? `/chat/${encodeURIComponent(sessionId)}`
        : '/more';
  const assistant = useAssistantName(),
    console = useRef<TerminalConsoleHandle>(null),
    commandInput = useRef<HTMLTextAreaElement>(null);
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null),
    [status, setStatus] = useState<TerminalStatus>('connecting'),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  const draftRevision = useRef(0);
  function setDraft(value: string) {
    draftRevision.current++;
    setCommand(value);
  }
  const [controls, setControls] = useState(true),
    [adviserOpen, setAdviserOpen] = useState(false),
    [adviserVisited, setAdviserVisited] = useState(false),
    [optionsOpen, setOptionsOpen] = useState(false),
    [destinationOpen, setDestinationOpen] = useState(false);
  const [destinations, setDestinations] = useState<{ sessionId: string; label: string }[]>([]),
    [search, setSearch] = useState('');
  const [command, setCommand] = useState(''),
    [writing, setWriting] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false);
  const [seed, setSeed] = useState<AccountSelection>(),
    [contextReady, setContextReady] = useState(false),
    [selection, setSelection] = useState<AccountSelection | null>(null),
    [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const previousSelection = useRef<AccountSelection | null>(null);
  const [question, setQuestion] = useState(''),
    [review, setReview] = useState<string | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [reply, setReply] = useState<{ text: string; commands: string[] } | null>(null),
    [asking, setAsking] = useState(false),
    [adviceError, setAdviceError] = useState('');
  const adviceRequest = useRef<AbortController | null>(null);
  const [history, setHistory] = useState(new CommandHistory());
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setTerminal(null);
    setStatus('connecting');
    setError('');
    setReply(null);
    setReview(null);
    setMessages([]);
    setDraft('');
    setHistoryOpen(false);
    adviceRequest.current?.abort();
    void apiFetch('/api/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error('Terminal unavailable. Check the selected environment.');
        const info: TerminalInfo = await response.json();
        if (disposed) return;
        if (!info.id || !['host', 'sandbox'].includes(info.kind))
          throw Error('Invalid terminal response');
        setTerminal(info);
        if (info.state === 'ended') setStatus('ended');
        if (!histories.has(info.id)) {
          if (histories.size >= 20) histories.delete(histories.keys().next().value!);
          histories.set(info.id, new CommandHistory());
        }
        setHistory(histories.get(info.id)!);
      })
      .catch((cause) => {
        if (!disposed) {
          setStatus('unavailable');
          setError(cause instanceof Error ? cause.message : 'Terminal unavailable');
        }
      });
    return () => {
      disposed = true;
      controller.abort();
      adviceRequest.current?.abort();
    };
  }, [sessionId, attempt]);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    void apiFetch(
      `/api/terminals/context${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw Error('Context unavailable');
        const data = await response.json();
        if (!disposed) {
          setSeed(data.selection);
          if (data.summary) setSummary(data.summary);
          setContextReady(true);
        }
      })
      .catch(() => {
        if (!disposed) setContextReady(true);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
    // The original conversation supplies a starting preference; destination changes never replace the adviser account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    let width = window.innerWidth,
      fullHeight = window.visualViewport?.height ?? window.innerHeight;
    const update = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        fullHeight = height;
      }
      fullHeight = Math.max(fullHeight, height);
      root.style.setProperty('--terminal-viewport-height', `${height}px`);
      const active = document.activeElement as HTMLElement | null;
      const editing = !!active?.closest('.terminal-page input,.terminal-page textarea');
      const keyboard = editing && height < fullHeight - 140;
      root.dataset.terminalKeyboard = String(keyboard);
      if (keyboard) {
        if (!active?.closest('.terminal-adviser-panel')) setControls(false);
        else requestAnimationFrame(() => active?.scrollIntoView({ block: 'nearest' }));
      }
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      root.style.removeProperty('--terminal-viewport-height');
      delete root.dataset.terminalKeyboard;
    };
  }, []);
  const chooseAccount = useCallback((next: AccountSelection | null) => {
    const previous = previousSelection.current;
    if (
      next &&
      previous &&
      (next.accountId !== previous.accountId || next.model !== previous.model)
    ) {
      setMessages([]);
      setReply(null);
      adviceRequest.current?.abort();
    }
    if (next) previousSelection.current = next;
    setSelection(next);
  }, []);
  useLayoutEffect(() => {
    const input = commandInput.current;
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.max(44, Math.min(104, input.scrollHeight + 2))}px`;
    }
  }, [command]);
  async function run() {
    if (!isReviewableTerminalCommand(command) || !terminal || writing || status !== 'connected')
      return;
    const value = command;
    const revision = draftRevision.current;
    setWriting(true);
    setError('');
    try {
      await console.current!.send(`${value}\r`);
      history.add(value);
      if (draftRevision.current === revision) {
        setDraft('');
        console.current?.focus();
      }
    } catch {
      setError('Input was not acknowledged. Check the terminal before retrying.');
    } finally {
      setWriting(false);
    }
  }
  function recall(direction: 'previous' | 'next') {
    setDraft(direction === 'previous' ? history.previous(command) : history.next());
    commandInput.current?.focus();
  }
  function stage(value: string) {
    if (!isReviewableTerminalCommand(value)) {
      setError('Remove invisible control characters before running this command.');
      return;
    }
    setError('');
    setDraft(value);
    setHistoryOpen(false);
    commandInput.current?.focus();
  }
  async function ask() {
    if (!selection?.accountId || !terminal || !question.trim() || asking) return;
    const controller = new AbortController();
    adviceRequest.current = controller;
    setAsking(true);
    setAdviceError('');
    const next: Message[] = [...messages.slice(-10), { role: 'user', content: question.trim() }];
    try {
      const response = await apiFetch(`/api/terminals/${encodeURIComponent(terminal.id)}/advice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...selection,
          messages: next,
          ...(review !== null ? { output: review } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw Error('Adviser unavailable. Check the selected account, model and thinking mode.');
      const result = await response.json();
      if (controller.signal.aborted) return;
      setReply(result);
      const retained = next.map((message, index) =>
        index === next.length - 1 && review
          ? { ...message, content: `${message.content}\n\nReviewed terminal output:\n${review}` }
          : message,
      );
      setMessages([...retained, { role: 'assistant', content: result.text.slice(0, 8192) }]);
      setQuestion('');
      setReview(null);
    } catch {
      if (!controller.signal.aborted)
        setAdviceError('Adviser unavailable. Check the selected account, model and thinking mode.');
    } finally {
      if (adviceRequest.current === controller) setAsking(false);
    }
  }
  async function openDestinations() {
    setDestinationOpen((value) => !value);
    setSearch('');
    try {
      const response = await apiFetch('/api/terminals/destinations');
      if (!response.ok) throw Error();
      setDestinations(await response.json());
    } catch {
      setError('Chat sandbox list unavailable');
    }
  }
  function chooseDestination(id?: string) {
    const next = new URLSearchParams(params);
    if (id) next.set('sessionId', id);
    else next.delete('sessionId');
    next.set('returnTo', returnTo);
    setParams(next);
    setDestinationOpen(false);
  }
  async function end() {
    if (!terminal) return;
    try {
      const response = await apiFetch(`/api/terminals/${encodeURIComponent(terminal.id)}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw Error();
      setStatus('ended');
      setOptionsOpen(false);
    } catch {
      setError('Terminal could not be ended');
    }
  }
  return (
    <main className="workspace-page terminal-page">
      <header className="terminal-heading">
        <Link
          to={returnTo}
          aria-label={returnTo.startsWith('/chat') ? 'Back to chat' : 'Back to More'}
        >
          <UiIcon name="back" />
        </Link>
        <h1>Terminal</h1>
        <button
          type="button"
          aria-label={controls ? 'Collapse controls' : 'Show controls'}
          aria-expanded={controls}
          onClick={() => setControls((value) => !value)}
        >
          <UiIcon name={controls ? 'up' : 'down'} />
        </button>
        <button
          type="button"
          aria-label="Terminal options"
          aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen((value) => !value)}
        >
          <UiIcon name="more" />
        </button>
      </header>
      {optionsOpen && (
        <div className="terminal-options">
          <button
            type="button"
            disabled={!terminal || status === 'ended'}
            onClick={() => void end()}
          >
            End terminal session
          </button>
          <p className="workspace-muted">Closing this page keeps your shell running.</p>
        </div>
      )}
      <section className="terminal-controls" aria-label="Terminal controls" hidden={!controls}>
        <button
          type="button"
          className="terminal-adviser-toggle"
          aria-label={`${adviserOpen ? 'Hide' : 'Show'} ${assistant.name}`}
          aria-expanded={adviserOpen}
          onClick={() => {
            setAdviserVisited(true);
            setAdviserOpen((value) => !value);
          }}
        >
          <UiIcon name="agents" />
          <span>
            <strong>
              {assistant.name}
              {summary?.profile ? ` · ${summary.profile}` : ''}
            </strong>
            <small>
              {summary?.model
                ? `${summary.model} · ${summary.thinking || 'Model default'}`
                : 'Terminal adviser · Suggestions only'}
            </small>
          </span>
          <UiIcon name={adviserOpen ? 'up' : 'down'} />
        </button>
        {adviserVisited && (
          <div className="terminal-adviser-panel" hidden={!adviserOpen}>
            <div className="terminal-adviser-pickers">
              {contextReady ? (
                <AccountModelPicker
                  scope="adviser"
                  sessionId={null}
                  preferredModel={seed?.model ?? ''}
                  initialSelection={seed}
                  requireExplicitSelection={!seed}
                  disabled={asking}
                  onChange={chooseAccount}
                  onSummaryChange={setSummary}
                />
              ) : (
                <span>Loading adviser preferences…</span>
              )}
            </div>
            <p className="workspace-muted terminal-adviser-boundary">
              Suggestions only. You run commands. API and Vertex accounts are supported; personal
              ChatGPT needs an isolated adviser runtime.
            </p>
            {reply && (
              <div className="terminal-adviser-response">
                <ReactMarkdown>{reply.text}</ReactMarkdown>
                {reply.commands.map((value, index) => (
                  <button
                    key={index}
                    type="button"
                    className="terminal-suggestion"
                    aria-label={`Use ${value}`}
                    onClick={() => stage(value)}
                  >
                    <code>{value}</code>
                    <span>Use command ↘</span>
                  </button>
                ))}
              </div>
            )}
            {review !== null && (
              <label className="terminal-reviewed">
                Reviewed output
                <textarea
                  aria-label="Reviewed output"
                  value={review}
                  maxLength={16384}
                  onChange={(event) => setReview(event.target.value)}
                />
                <small>Remove secrets before sending.</small>
                <button type="button" onClick={() => setReview(null)}>
                  Remove output
                </button>
              </label>
            )}
            <form
              className="terminal-adviser-input"
              onSubmit={(event) => {
                event.preventDefault();
                void ask();
              }}
            >
              <input
                aria-label={`Ask ${assistant.name}`}
                placeholder={`Ask ${assistant.name}…`}
                maxLength={8192}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
              <button
                className="workspace-primary"
                aria-label="Ask adviser"
                disabled={!selection || asking || !question.trim()}
              >
                {asking ? 'Thinking…' : 'Ask'}
              </button>
            </form>
            {adviceError && <p role="alert">{adviceError}</p>}
          </div>
        )}
        <div className="terminal-destination-row">
          <button
            type="button"
            aria-label="Choose terminal destination"
            aria-expanded={destinationOpen}
            onClick={() => void openDestinations()}
          >
            <UiIcon name={terminal?.kind === 'sandbox' ? 'files' : 'panel'} />
            <span>
              <strong>{terminal?.label ?? (sessionId ? 'Chat environment' : 'Your Mac')}</strong>
              <small>{terminal?.cwd ?? 'Connecting…'}</small>
            </span>
            <UiIcon name="down" />
          </button>
          <button
            type="button"
            aria-label="Share output"
            disabled={!terminal}
            onClick={() => {
              setReview(console.current?.reviewOutput() ?? '');
              setAdviserVisited(true);
              setAdviserOpen(true);
            }}
          >
            <UiIcon name="send" />
          </button>
        </div>
        {destinationOpen && (
          <div className="terminal-destination-picker">
            <button type="button" onClick={() => chooseDestination()}>
              Your Mac
            </button>
            <label>
              Choose a chat’s sandbox
              <input
                aria-label="Find chat sandbox"
                placeholder="Search by chat name…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div>
              {destinations
                .filter((item) => item.label.toLowerCase().includes(search.toLowerCase()))
                .map((item) => (
                  <button
                    key={item.sessionId}
                    type="button"
                    onClick={() => chooseDestination(item.sessionId)}
                  >
                    {item.label}
                  </button>
                ))}
              {!destinations.length && (
                <p className="workspace-muted">No chat sandboxes available.</p>
              )}
            </div>
          </div>
        )}
      </section>
      <div className="terminal-output">
        {terminal?.state === 'running' ? (
          <TerminalConsole
            key={`${terminal.id}:${attempt}`}
            ref={console}
            terminalId={terminal.id}
            onStatus={setStatus}
            onError={setError}
          />
        ) : (
          <p className="workspace-muted">
            {status === 'ended'
              ? 'The saved shell has ended.'
              : status === 'unavailable'
                ? 'Unable to open terminal'
                : 'Opening terminal…'}
          </p>
        )}
      </div>
      <div className="terminal-command-area">
        {historyOpen && (
          <section className="terminal-history" aria-label="Command history">
            <h2>History</h2>
            {[...history.entries].reverse().map((value, index) => (
              <button key={index} type="button" onClick={() => stage(value)}>
                <code>{value}</code>
              </button>
            ))}
            {!history.entries.length && (
              <p className="workspace-muted">Commands you run here appear here.</p>
            )}
          </section>
        )}
        <div className="terminal-input-caption">
          <span>Command {terminal?.kind === 'sandbox' ? 'in this sandbox' : 'on your Mac'}</span>
          <span>You control input</span>
        </div>
        <form
          className="terminal-command-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <textarea
            rows={1}
            ref={commandInput}
            aria-label="Command"
            value={command}
            maxLength={8192}
            placeholder="Type a command…"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              if (event.target.value.trim() && !isReviewableTerminalCommand(event.target.value))
                setError('Remove invisible control characters before running this command.');
              else setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void run();
              }
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                const edge =
                  event.key === 'ArrowUp'
                    ? event.currentTarget.selectionStart === 0
                    : event.currentTarget.selectionEnd === command.length;
                if (!command.includes('\n') || edge) {
                  event.preventDefault();
                  recall(event.key === 'ArrowUp' ? 'previous' : 'next');
                }
              }
            }}
          />
          <button
            className="workspace-primary"
            aria-label="Run command"
            disabled={!isReviewableTerminalCommand(command) || writing || status !== 'connected'}
          >
            Run ↵
          </button>
        </form>
        <div className="terminal-keybar">
          {[
            ['Ctrl C', '\u0003'],
            ['Esc', '\u001b'],
            ['Tab', '\t'],
          ].map(([label, data]) => (
            <button
              key={label}
              type="button"
              disabled={status !== 'connected'}
              onClick={() => {
                void console.current?.send(data).catch(() => {});
                console.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
          <button type="button" aria-label="Previous command" onClick={() => recall('previous')}>
            ↑
          </button>
          <button type="button" aria-label="Next command" onClick={() => recall('next')}>
            ↓
          </button>
          <button
            type="button"
            aria-label="Command history"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            ↶
          </button>
        </div>
        <div className="terminal-status" role="status">
          {status === 'connected'
            ? 'Connected'
            : status === 'ended'
              ? 'Session ended'
              : status === 'reconnecting'
                ? 'Reconnecting…'
                : status === 'unavailable'
                  ? 'Unavailable'
                  : 'Connecting…'}
          {!adviserOpen ? ' · Adviser collapsed' : ''}
          {(status === 'unavailable' || status === 'ended') && (
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              {status === 'ended' ? 'Start new shell' : 'Retry'}
            </button>
          )}
        </div>
        {error && (
          <p className="terminal-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
