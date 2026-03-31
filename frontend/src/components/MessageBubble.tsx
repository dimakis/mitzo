import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../pages/ChatView';

interface Props {
  message: Message;
}

export function MessageBubble({ message }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="msg-bubble msg-bubble--user">
        <div className="msg-bubble-content">{message.text}</div>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <div className="msg-bubble msg-bubble--tool">
        <button className="msg-tool-header" onClick={() => setExpanded((e) => !e)}>
          <span className="msg-tool-name">{message.toolName}</span>
          <span className="msg-tool-chevron">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <div className="msg-tool-detail">
            <div className="msg-tool-section">
              <span className="msg-tool-label">Input</span>
              <pre className="msg-tool-pre">{message.toolInput}</pre>
            </div>
            {message.toolResult !== undefined && (
              <div className="msg-tool-section">
                <span className="msg-tool-label">Result</span>
                <pre className="msg-tool-pre">{message.toolResult}</pre>
              </div>
            )}
            {message.toolResult === undefined && <div className="msg-tool-running">Running...</div>}
          </div>
        )}
        {!expanded && message.toolResult === undefined && (
          <div className="msg-tool-running-inline">Running...</div>
        )}
      </div>
    );
  }

  return (
    <div className="msg-bubble msg-bubble--assistant">
      <div className="msg-bubble-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text || ''}</ReactMarkdown>
        {message.streaming && <span className="msg-cursor" />}
      </div>
    </div>
  );
}
