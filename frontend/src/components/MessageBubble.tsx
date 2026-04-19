import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate, useLocation } from 'react-router-dom';
import type { FinishedMessage } from '../types/chat';
import { linkifyFilePaths, FILE_SCHEME } from '../lib/file-paths';
import { CopyButton } from './CopyButton';
import { extractText } from '../lib/extractText';

const COLLAPSE_HEIGHT = 300;

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

interface UserBubbleProps {
  text?: string;
  images?: string[];
  contextBlocks?: string[];
  timestamp?: number;
}

export function UserBubble({ text, images, contextBlocks, timestamp }: UserBubbleProps) {
  const time = formatTime(timestamp);
  return (
    <div className="msg-bubble-group msg-bubble-group--user">
      <div className="msg-bubble msg-bubble--user">
        {contextBlocks && contextBlocks.length > 0 && (
          <div className="msg-bubble-context">@ {contextBlocks.join(', ')}</div>
        )}
        {images && images.length > 0 && (
          <div className="msg-bubble-images">
            {images.map((src, i) => (
              <img key={i} src={src} alt={`Attachment ${i + 1}`} className="msg-bubble-img" />
            ))}
          </div>
        )}
        {text && <div className="msg-bubble-content">{text}</div>}
      </div>
      {time && <span className="msg-timestamp msg-timestamp--user">{time}</span>}
    </div>
  );
}

interface TextBubbleProps {
  content: string;
  streaming?: boolean;
  timestamp?: number;
}

export function TextBubble({ content, streaming = false, timestamp }: TextBubbleProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const processed = streaming ? content : linkifyFilePaths(content);
  const currentPath = location.pathname + location.search;
  const [collapsed, setCollapsed] = useState(true);
  const [isLong, setIsLong] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current && !streaming) {
      setIsLong(contentRef.current.scrollHeight > COLLAPSE_HEIGHT);
    }
  }, [content, streaming]);

  const showCollapsed = isLong && collapsed && !streaming;

  return (
    <div
      className={`msg-bubble msg-bubble--assistant${streaming ? ' msg-bubble--streaming' : ''}${showCollapsed ? ' msg-bubble--collapsed' : ''}`}
    >
      <div className="msg-bubble-markdown" ref={contentRef}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            table: ({ children, ...props }) => (
              <div className="table-scroll-wrapper">
                <table {...props}>{children}</table>
              </div>
            ),
            pre: ({ children, ...props }) => {
              const text = extractText(children);
              return (
                <div className="code-block-wrapper">
                  <pre {...props}>{children}</pre>
                  <CopyButton text={text} className="code-block-copy" label="Copy code" />
                </div>
              );
            },
            a: ({ href, children }) => {
              if (href?.startsWith(FILE_SCHEME)) {
                const filePath = decodeURIComponent(href.slice(FILE_SCHEME.length));
                return (
                  <a
                    href="#"
                    className="file-path-link"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(
                        `/files?path=${encodeURIComponent(filePath)}&from=${encodeURIComponent(currentPath)}`,
                      );
                    }}
                  >
                    {children}
                  </a>
                );
              }
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {processed}
        </ReactMarkdown>
      </div>
      {isLong && !streaming && (
        <button className="msg-bubble-collapse-toggle" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? 'Show more' : 'Show less'}
        </button>
      )}
      {!streaming && (
        <div className="msg-bubble-footer">
          {timestamp && <span className="msg-timestamp">{formatTime(timestamp)}</span>}
          <CopyButton text={content} className="msg-bubble-copy" />
        </div>
      )}
    </div>
  );
}

// Legacy adapter for session restore — maps FinishedMessage to flat render.
interface MessageBubbleProps {
  message: FinishedMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === 'user') {
    const textBlock = message.blocks.find((b) => b.blockType === 'text');
    return (
      <UserBubble text={textBlock?.content} images={message.images} timestamp={message.timestamp} />
    );
  }
  const textBlock = message.blocks.find((b) => b.blockType === 'text');
  return <TextBubble content={textBlock?.content || ''} timestamp={message.timestamp} />;
}
