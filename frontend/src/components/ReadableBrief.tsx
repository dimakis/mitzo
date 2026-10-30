import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { remarkPlugins, rehypePlugins, markdownComponents } from '../lib/markdown-config';

/** A bounded preview is presentation only, never a replacement for the saved
 * brief. Opening the native disclosure renders the original Markdown verbatim. */
export function ReadableBrief({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const value = text || 'Not recorded';
  const markdown = (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={markdownComponents}
    >
      {value}
    </ReactMarkdown>
  );
  if (value.length <= 320) return <div className="readable-brief">{markdown}</div>;
  const boundary = value.lastIndexOf(' ', 320);
  const excerpt = value.slice(0, boundary > 0 ? boundary : 320).trimEnd() + '…';
  return (
    <div className="readable-brief">
      {!expanded && <p aria-label="Brief summary">{excerpt}</p>}
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>Full brief</summary>
        {expanded && markdown}
      </details>
    </div>
  );
}
