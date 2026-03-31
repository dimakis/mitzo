import { useState, useRef, useEffect, type KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  running: boolean;
  initialText?: string;
}

export function ChatInput({ onSend, onStop, running, initialText }: Props) {
  const [text, setText] = useState(initialText || '');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialApplied = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (initialText && !initialApplied.current) {
      initialApplied.current = true;
      setText(initialText);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [initialText]);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    onSend(trimmed);
    setText('');
    inputRef.current?.focus();
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
        <div className="chat-input-thinking">
          <span className="chat-input-dot-pulse" />
          Thinking...
        </div>
      )}
      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input-field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? 'Agent is working...' : 'Message...'}
          rows={1}
          disabled={running}
        />
        {running ? (
          <button className="chat-input-stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            className="chat-input-send"
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
