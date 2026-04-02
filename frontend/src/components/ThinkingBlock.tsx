import { useState } from 'react';
import type { Message } from '../types/chat';

interface Props {
  message: Message;
}

export function ThinkingBlock({ message }: Props) {
  const [expanded, setExpanded] = useState(!!message.streaming);
  const text = message.text || '';
  const isStreaming = !!message.streaming;

  if (!text && !isStreaming) return null;

  return (
    <div className={`thinking-block ${isStreaming ? 'thinking-block--streaming' : ''}`}>
      <button className="thinking-block-header" onClick={() => setExpanded((e) => !e)}>
        <span className="thinking-block-label">{isStreaming ? 'Thinking...' : 'Thought'}</span>
        <span className="thinking-block-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="thinking-block-content">
          <pre className="thinking-block-text">{text}</pre>
        </div>
      )}
    </div>
  );
}
