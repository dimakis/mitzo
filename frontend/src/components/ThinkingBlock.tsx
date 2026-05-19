import { useState } from 'react';
import type { StreamingBlock, FinishedBlock } from '../types/chat';

interface Props {
  block: StreamingBlock | FinishedBlock;
  streaming?: boolean;
}

export function ThinkingBlock({ block, streaming = false }: Props) {
  const [expanded, setExpanded] = useState(streaming);
  const text = block.content || '';
  const isStreaming = streaming && !('done' in block && block.done);

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
      <button className="tool-pill-header" onClick={() => setExpanded((e) => !e)}>
        <span
          className={`tool-pill-dot ${isStreaming ? 'tool-pill-dot--pending' : 'tool-pill-dot--done'}`}
        />
        <span className="tool-pill-name thinking-block-name">
          {isStreaming ? 'Thinking...' : 'Thought'}
        </span>
        <span className="tool-pill-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="tool-pill-detail">
          <pre className="thinking-block-text">{text}</pre>
        </div>
      )}
    </div>
  );
}
