import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { SymposiumProfileDefinitionSchema, type SymposiumProfileDefinition } from '@mitzo/protocol';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { UiIcon } from './UiIcon';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { apiFetch } from '../lib/api-fetch';

type Message = { role: 'user' | 'assistant'; content: string; context?: string };
export function AgentCreationAdvisor({
  definition,
  onApply,
  open,
  onOpenChange,
  disabled,
}: {
  definition: SymposiumProfileDefinition;
  onApply(definition: SymposiumProfileDefinition): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  disabled: boolean;
}) {
  const [selection, setSelection] = useState<AccountSelection | null>(null);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestion, setSuggestion] = useState<{
    definition: SymposiumProfileDefinition;
    basis: string;
  } | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const questionRevision = useRef(0);
  const presence = useMotionPresence(open, 'disclosure', false);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [messages]);
  const chooseAccount = useCallback((next: AccountSelection | null) => {
    request.current?.abort();
    setAsking(false);
    setSelection(next);
    setMessages([]);
    setSuggestion(null);
    setError('');
  }, []);
  async function ask() {
    if (!selection || !question.trim() || asking || disabled) return;
    const controller = new AbortController();
    request.current = controller;
    const revision = questionRevision.current;
    const draft = JSON.stringify(definition);
    const next: Message[] = [...messages.slice(-10), { role: 'user', content: question.trim() }];
    setAsking(true);
    setError('');
    setSuggestion(null);
    try {
      const response = await apiFetch('/api/agent-library/advice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...selection,
          messages: next.map(({ role, content, context }) => ({
            role,
            content: context ?? content,
          })),
          draft,
        }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw Error('Advisor unavailable. Check the selected account, model and thinking mode.');
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 32768)
        throw Error('The advisor returned an unreadable response. Try again.');
      const proposed = SymposiumProfileDefinitionSchema.safeParse(result.proposal);
      setMessages(
        [
          ...next,
          {
            role: 'assistant' as const,
            content: result.text,
            ...(proposed.success
              ? {
                  context: `${result.text.slice(0, 24000)}\n\n\`\`\`json\n${JSON.stringify(proposed.data)}\n\`\`\``,
                }
              : {}),
          },
        ].slice(-12),
      );
      if (proposed.success) setSuggestion({ definition: proposed.data, basis: draft });
      if (questionRevision.current === revision) setQuestion('');
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Advisor unavailable. Try again.');
    } finally {
      if (request.current === controller && !controller.signal.aborted) setAsking(false);
    }
  }
  const changed = suggestion && suggestion.basis !== JSON.stringify(definition);
  return (
    <section className="agent-creation-advisor" aria-label="Agent advisor">
      <button
        type="button"
        className="agent-advisor-toggle"
        aria-expanded={open}
        aria-controls="agent-advisor-panel"
        onClick={() => onOpenChange(!open)}
      >
        <UiIcon name="agents" />
        <span>Agent advisor</span>
        <UiIcon name={open ? 'up' : 'down'} />
      </button>
      <div
        id="agent-advisor-panel"
        className="motion-disclosure"
        ref={presence.ref}
        hidden={!presence.present}
        inert={!open}
        aria-hidden={!open || undefined}
      >
        <div className="agent-advisor-pickers">
          <AccountModelPicker
            scope="adviser"
            sessionId={null}
            preferredModel=""
            requireExplicitSelection
            disabled={asking}
            onChange={chooseAccount}
          />
        </div>
        <p className="workspace-muted agent-advisor-hint">
          Describe the job. Your advisor sees the current draft and helps shape the profile below.
        </p>
        {messages.length > 0 && (
          <div
            ref={conversation}
            className="agent-advisor-conversation"
            role="log"
            aria-label="Advisor conversation"
            tabIndex={0}
          >
            {messages.map((message, index) => (
              <div key={index} className={`agent-advisor-message agent-advisor-${message.role}`}>
                <strong>{message.role === 'user' ? 'You' : 'Advisor'}</strong>
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            ))}
          </div>
        )}
        {suggestion && (
          <div className="agent-advisor-proposal">
            <div>
              <strong>{suggestion.definition.name}</strong>
              <p>{suggestion.definition.descriptor}</p>
              <p>{suggestion.definition.description}</p>
              <details>
                <summary>Review suggested profile</summary>
                <pre>{JSON.stringify(suggestion.definition, null, 2)}</pre>
              </details>
            </div>
            <button
              type="button"
              disabled={disabled || !!changed || asking}
              onClick={() => {
                onApply(suggestion.definition);
                setSuggestion(null);
                input.current?.focus();
              }}
            >
              Use suggested profile
            </button>
            {changed && (
              <p className="workspace-muted">
                Your draft has changed. Ask again to update the suggestion.
              </p>
            )}
          </div>
        )}
        <form
          className="agent-advisor-input"
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <input
            ref={input}
            aria-label="Ask agent advisor"
            placeholder="Ask about your agent…"
            maxLength={8192}
            value={question}
            onChange={(event) => {
              questionRevision.current++;
              setQuestion(event.target.value);
            }}
          />
          <button
            className="btn-primary"
            aria-label="Ask advisor"
            disabled={!selection || asking || !question.trim() || disabled}
          >
            {asking ? 'Thinking…' : 'Ask'}
          </button>
        </form>
        {asking && (
          <p role="status" className="workspace-muted">
            Thinking about your agent…
          </p>
        )}
        {error && (
          <p role="alert" className="agent-library-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
