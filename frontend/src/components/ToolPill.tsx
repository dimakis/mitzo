import { useState } from 'react';
import type { Message } from '../types/chat';
import { truncate } from '../lib/truncate';

interface Props {
  message: Message;
}

export function ToolPill({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const done = message.toolResult !== undefined;
  const input = message.toolInput || '';
  const truncatedInput = truncate(input, 60);

  return (
    <div className={`tool-pill ${done ? 'tool-pill--done' : 'tool-pill--running'}`}>
      <button className="tool-pill-header" onClick={() => setExpanded((e) => !e)}>
        <span
          className={`tool-pill-dot ${done ? 'tool-pill-dot--done' : 'tool-pill-dot--pending'}`}
        />
        <span className="tool-pill-name">{message.toolName}</span>
        <span className="tool-pill-input">{truncatedInput}</span>
        {!done && <span className="tool-pill-status">Running...</span>}
        {expanded && <span className="tool-pill-chevron">▾</span>}
      </button>
      {expanded && (
        <div className="tool-pill-detail">
          <div className="tool-pill-section">
            <span className="tool-pill-label">Input</span>
            <pre className="tool-pill-pre">{input}</pre>
          </div>
          {done && (
            <div className="tool-pill-section">
              <span className="tool-pill-label">Result</span>
              <pre className="tool-pill-pre">{message.toolResult}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
