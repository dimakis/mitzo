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
      <div className="thinking-block thinking-block--redacted">
        <span className="thinking-block-label">Reasoning redacted</span>
      </div>
    );
  }

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
