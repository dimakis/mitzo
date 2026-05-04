import { useState } from 'react';
import type { BootContextMeta } from '@mitzo/client';

interface Props {
  context: BootContextMeta;
}

export function BootContextPill({ context }: Props) {
  const [expanded, setExpanded] = useState(false);

  const isContexgin = context.source === 'contexgin';
  const dotColor = isContexgin ? '#4ade80' : '#fbbf24';
  const tokenLabel =
    context.tokenCount >= 1000
      ? `${(context.tokenCount / 1000).toFixed(1)}k`
      : String(context.tokenCount);
  const label = `${context.sourceCount} sources \u00b7 ${tokenLabel} tokens`;

  return (
    <div className="boot-context-pill">
      <button
        className="boot-context-pill-header"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="boot-context-pill-dot" style={{ background: dotColor }} />
        <span className="boot-context-pill-label">{label}</span>
        <span className="boot-context-pill-engine">
          {isContexgin ? 'ContexGin' : 'Fallback'}
        </span>
        <span className="boot-context-pill-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
      </button>
      {expanded && (
        <div className="boot-context-pill-content">
          {context.sources.map((src) => (
            <div key={src} className="boot-context-pill-source">
              {src}
            </div>
          ))}
          {context.trimmedCount > 0 && (
            <div className="boot-context-pill-trimmed">
              {context.trimmedCount} section{context.trimmedCount !== 1 ? 's' : ''} trimmed
            </div>
          )}
        </div>
      )}
    </div>
  );
}
