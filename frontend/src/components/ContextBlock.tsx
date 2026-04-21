import { useState } from 'react';

interface Props {
  content: string;
}

export function ContextBlock({ content }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!content) return null;

  return (
    <div className="context-block">
      <button className="context-block-header" onClick={() => setExpanded((e) => !e)}>
        <span className="context-block-label">Session Context</span>
        <span className="context-block-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
      </button>
      {expanded && (
        <div className="context-block-content">
          <pre className="context-block-text">{content}</pre>
        </div>
      )}
    </div>
  );
}
