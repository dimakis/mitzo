import { useState, useEffect, useRef } from 'react';
import { ToolPill } from './ToolPill';
import type { Message } from '../types/chat';

interface Props {
  tools: Message[];
}

export function ToolGroup({ tools }: Props) {
  const allDone = tools.every((t) => t.toolResult !== undefined);
  const [expanded, setExpanded] = useState(!allDone);
  const autoCollapsed = useRef(false);

  useEffect(() => {
    if (allDone && !autoCollapsed.current) {
      autoCollapsed.current = true;
      setExpanded(false);
    }
  }, [allDone]);

  const doneCount = tools.filter((t) => t.toolResult !== undefined).length;

  return (
    <div className="tool-group">
      <button className="tool-group-header" onClick={() => setExpanded((e) => !e)}>
        <div className="tool-group-dots">
          {tools.slice(0, 8).map((t, i) => (
            <span
              key={i}
              className={`tool-pill-dot ${t.toolResult !== undefined ? 'tool-pill-dot--done' : 'tool-pill-dot--pending'}`}
            />
          ))}
          {tools.length > 8 && <span className="tool-group-dots-more">+{tools.length - 8}</span>}
        </div>
        <span className="tool-group-label">
          {allDone ? `${tools.length} tool calls` : `${doneCount}/${tools.length} running...`}
        </span>
        <span className="tool-group-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="tool-group-list">
          {tools.map((t, i) => (
            <ToolPill key={t.toolId || i} message={t} />
          ))}
        </div>
      )}
    </div>
  );
}
