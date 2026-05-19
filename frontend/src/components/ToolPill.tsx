import { useState } from 'react';
import type { StreamingBlock, FinishedBlock, RawToolInput } from '../types/chat';
import { SubagentCard } from './SubagentCard';
import { CodeBlock } from './CodeBlock';

interface Props {
  block: StreamingBlock | FinishedBlock;
}

function RawInputDetail({ raw }: { raw: RawToolInput }) {
  if (raw.type === 'read') {
    // Read tool: path shown in header, no input body to render
    return null;
  }
  if (raw.type === 'write') {
    return (
      <div className="tool-pill-section">
        <CodeBlock
          code={raw.contents || ''}
          language={raw.language}
          label={raw.path}
          maxHeight={300}
        />
      </div>
    );
  }
  if (raw.type === 'diff') {
    return (
      <div className="tool-pill-section">
        <span className="tool-pill-label">{raw.path}</span>
        {raw.old_string && (
          <CodeBlock
            code={raw.old_string}
            language={raw.language}
            variant="removed"
            maxHeight={200}
          />
        )}
        {raw.new_string && (
          <CodeBlock
            code={raw.new_string}
            language={raw.language}
            variant="added"
            maxHeight={200}
          />
        )}
      </div>
    );
  }
  if (raw.type === 'command') {
    return (
      <div className="tool-pill-section">
        <CodeBlock code={raw.command || ''} language="bash" label="Command" maxHeight={200} />
      </div>
    );
  }
  return null;
}

/** Render tool result — syntax-highlighted for read/write tools, plain for others. */
function ToolResult({ block }: { block: StreamingBlock | FinishedBlock }) {
  if (block.toolResult === undefined) return null;

  const raw = block.rawInput;
  // For Read tool results, show the file content with syntax highlighting
  if (raw?.type === 'read' && block.toolResult) {
    return (
      <div className="tool-pill-section">
        <CodeBlock
          code={block.toolResult}
          language={raw.language}
          label={raw.path}
          maxHeight={400}
        />
      </div>
    );
  }

  return (
    <div className="tool-pill-section">
      <span className="tool-pill-label">Result</span>
      <pre className="tool-pill-pre">{block.toolResult}</pre>
    </div>
  );
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
          <ToolResult block={block} />
        </div>
      )}
      {block.subagent && <SubagentCard subagent={block.subagent} />}
    </div>
  );
}
