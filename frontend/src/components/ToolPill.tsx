import { useState } from 'react';
import type { StreamingBlock, FinishedBlock, RawToolInput } from '../types/chat';

interface Props {
  block: StreamingBlock | FinishedBlock;
}

function RawInputDetail({ raw }: { raw: RawToolInput }) {
  if (raw.type === 'write') {
    return (
      <div className="tool-pill-section">
        <span className="tool-pill-label">{raw.path}</span>
        <pre className="tool-pill-pre tool-pill-code">{raw.contents}</pre>
      </div>
    );
  }
  if (raw.type === 'diff') {
    return (
      <div className="tool-pill-section">
        <span className="tool-pill-label">{raw.path}</span>
        {raw.old_string && <pre className="tool-pill-pre tool-pill-old">{raw.old_string}</pre>}
        {raw.new_string && <pre className="tool-pill-pre tool-pill-new">{raw.new_string}</pre>}
      </div>
    );
  }
  if (raw.type === 'command') {
    return (
      <div className="tool-pill-section">
        <span className="tool-pill-label">Command</span>
        <pre className="tool-pill-pre tool-pill-code">{raw.command}</pre>
      </div>
    );
  }
  return null;
}

export function ToolPill({ block }: Props) {
  const [expanded, setExpanded] = useState(false);
  const done = block.toolResult !== undefined;
  const hasError = (block as StreamingBlock).toolError === true;
  const input = block.toolInput || '';

  return (
    <div
      className={`tool-pill ${done ? (hasError ? 'tool-pill--error' : 'tool-pill--done') : 'tool-pill--running'}`}
    >
      <button className="tool-pill-header" onClick={() => setExpanded((e) => !e)}>
        <span
          className={`tool-pill-dot ${done ? (hasError ? 'tool-pill-dot--error' : 'tool-pill-dot--done') : 'tool-pill-dot--pending'}`}
        />
        <span className="tool-pill-name">{block.toolName}</span>
        <span className="tool-pill-input">{input}</span>
        {!done && <span className="tool-pill-status">Running...</span>}
        <span className="tool-pill-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="tool-pill-detail">
          {block.rawInput ? (
            <RawInputDetail raw={block.rawInput} />
          ) : (
            <div className="tool-pill-section">
              <span className="tool-pill-label">Input</span>
              <pre className="tool-pill-pre">{input}</pre>
            </div>
          )}
          {done && (
            <div className="tool-pill-section">
              <span className="tool-pill-label">Result</span>
              <pre className="tool-pill-pre">{block.toolResult}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
