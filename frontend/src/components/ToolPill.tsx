import { useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { StreamingBlock, FinishedBlock, RawToolInput } from '../types/chat';
import { SubagentCard } from './SubagentCard';
import { CodeBlock } from './CodeBlock';

interface Props {
  block: StreamingBlock | FinishedBlock;
}

function RawInputDetail({
  raw,
  onPopOut,
}: {
  raw: RawToolInput;
  onPopOut?: (path: string) => void;
}) {
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
          onPopOut={raw.path && onPopOut ? () => onPopOut(raw.path!) : undefined}
        />
      </div>
    );
  }
  if (raw.type === 'diff') {
    return (
      <div className="tool-pill-section">
        <span className="tool-pill-label">
          {raw.path}
          {raw.path && onPopOut && (
            <button
              className="tool-pill-popout-inline"
              onClick={() => onPopOut(raw.path!)}
              aria-label="Open in viewer"
            >
              ↗
            </button>
          )}
        </span>
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

/** Render tool result with syntax highlighting when language is known. */
function ToolResult({
  block,
  onPopOut,
}: {
  block: StreamingBlock | FinishedBlock;
  onPopOut?: (path: string) => void;
}) {
  const hasText = block.toolResult !== undefined && block.toolResult.length > 0;
  const hasImages = block.toolResultImages && block.toolResultImages.length > 0;

  if (!hasText && !hasImages) return null;

  const raw = block.rawInput;
  const isRead = raw?.type === 'read';

  return (
    <div className="tool-pill-section">
      {hasImages && (
        <div className="tool-pill-images">
          {block.toolResultImages!.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mediaType};base64,${img.data}`}
              alt={`Result image ${i + 1}`}
              className="tool-pill-result-img"
            />
          ))}
        </div>
      )}
      {hasText && (
        <CodeBlock
          code={block.toolResult!}
          language={raw?.language}
          label={isRead ? raw?.path : 'Result'}
          maxHeight={400}
          onPopOut={isRead && raw?.path && onPopOut ? () => onPopOut(raw.path!) : undefined}
        />
      )}
    </div>
  );
}

export function ToolPill({ block }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);
  const done = block.toolResult !== undefined || (block.toolResultImages && block.toolResultImages.length > 0);
  const hasError = (block as StreamingBlock).toolError === true;
  const input = block.toolInput || '';

  const handlePopOut = useCallback(
    (filePath: string) => {
      const currentPath = location.pathname + location.search;
      navigate(
        `/files?path=${encodeURIComponent(filePath)}&from=${encodeURIComponent(currentPath)}`,
      );
    },
    [navigate, location],
  );

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
            <RawInputDetail raw={block.rawInput} onPopOut={handlePopOut} />
          ) : (
            <div className="tool-pill-section">
              <span className="tool-pill-label">Input</span>
              <pre className="tool-pill-pre">{input}</pre>
            </div>
          )}
          <ToolResult block={block} onPopOut={handlePopOut} />
        </div>
      )}
      {block.subagent && <SubagentCard subagent={block.subagent} />}
    </div>
  );
}
