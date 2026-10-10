import { UiIcon } from './UiIcon';
import { useEffect, useState } from 'react';
import type { StreamingBlock, FinishedBlock } from '../types/chat';

interface Props {
  block: StreamingBlock | FinishedBlock;
  streaming?: boolean;
}

export function ThinkingBlock({ block, streaming = false }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [manual, setManual] = useState(false);
  const text = block.content || '';
  const isStreaming = streaming && !('done' in block && block.done);

  // Minimum 30 seconds; longer summaries get a full reading window at 200 wpm.
  const readingMs = Math.max(30_000, Math.ceil(text.trim().split(/\s+/).length * 300));
  useEffect(() => {
    if (isStreaming || manual || !text) return;
    const timer = setTimeout(() => setExpanded(false), readingMs);
    return () => clearTimeout(timer);
  }, [isStreaming, manual, text, readingMs]);

  if (block.blockType === 'redacted_thinking') {
    return (
      <div className="tool-pill tool-pill--done">
        <div className="tool-pill-header tool-pill-header--static">
          <span className="tool-pill-dot tool-pill-dot--done" />
          <span className="tool-pill-name thinking-block-name">Reasoning redacted</span>
        </div>
      </div>
    );
  }

  if (!text && !isStreaming) return null;

  return (
    <div
      className={`tool-pill ${isStreaming ? 'tool-pill--running' : 'tool-pill--done'} tool-pill--thinking`}
    >
      <button
        className="tool-pill-header"
        aria-expanded={expanded}
        onClick={() => {
          setManual(true);
          setExpanded((e) => !e);
        }}
      >
        <span
          className={`tool-pill-dot ${isStreaming ? 'tool-pill-dot--pending' : 'tool-pill-dot--done'}`}
        />
        <span className="tool-pill-name thinking-block-name">
          {isStreaming ? 'Thinking...' : 'Thought'}
        </span>
        <span className="tool-pill-chevron">
          <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
        </span>
      </button>
      {expanded && (
        <div className="tool-pill-detail">
          <pre className="thinking-block-text">{text}</pre>
        </div>
      )}
    </div>
  );
}
