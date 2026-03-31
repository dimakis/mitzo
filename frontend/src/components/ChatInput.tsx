import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  running: boolean;
  initialText?: string;
}

export function ChatInput({ onSend, onStop, running, initialText }: Props) {
  const [text, setText] = useState(initialText || '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initialApplied = useRef(false);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (initialText && !initialApplied.current) {
      initialApplied.current = true;
      setText(initialText);
      requestAnimationFrame(() => {
        autoResize();
        textareaRef.current?.focus();
      });
    }
  }, [initialText, autoResize]);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    onSend(trimmed);
    setText('');
    requestAnimationFrame(() => {
      autoResize();
      textareaRef.current?.focus();
    });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="chat-input">
      {running && (
        <div className="chat-input-thinking">Thinking</div>
      )}
      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          className="chat-input-field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? 'Working...' : 'Message Mitzo...'}
          rows={1}
          disabled={running}
        />
        {running ? (
          <button className="chat-input-btn chat-input-btn--stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            className="chat-input-btn chat-input-btn--send"
            onClick={handleSend}
            disabled={!text.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
