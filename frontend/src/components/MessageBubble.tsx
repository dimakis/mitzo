import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useNavigate, useLocation } from 'react-router-dom';
import type { FinishedMessage } from '../types/chat';
import { linkifyFilePaths, FILE_SCHEME } from '../lib/file-paths';
import { formatTime } from '../lib/formatTime';
import { CopyButton } from './CopyButton';
import { ShareButton } from './ShareButton';
import { ReadAloudButton } from './ReadAloudButton';
import { extractText } from '../lib/extractText';
import { getMermaidCode } from '../lib/mermaid-detect';
import { MarkdownPreviewCard } from './MarkdownPreviewCard';
import { MermaidBlock } from './MermaidBlock';

const COLLAPSE_HEIGHT = 300;

export interface ReadAloudProps {
  active: boolean;
  onSpeak: (text: string) => void;
  onStop: () => void;
}

interface UserBubbleProps {
  text?: string;
  images?: string[];
  contextBlocks?: string[];
  onEdit?: (text: string) => void;
  timestamp?: number;
  readAloud?: ReadAloudProps;
}

export function UserBubble({
  text,
  images,
  contextBlocks,
  onEdit,
  timestamp,
  readAloud,
}: UserBubbleProps) {
  const time = formatTime(timestamp);
  return (
    <div className="msg-bubble-group msg-bubble-group--user">
      <div
        className={`msg-bubble msg-bubble--user${onEdit ? ' msg-bubble--editable' : ''}`}
        onClick={() => text && onEdit?.(text)}
        role={onEdit ? 'button' : undefined}
        tabIndex={onEdit ? 0 : undefined}
      >
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
        {(time || text) && (
          <div className="msg-bubble-footer msg-bubble-footer--user">
            {time && <span className="msg-timestamp msg-timestamp--user">{time}</span>}
            {text && readAloud && (
              <ReadAloudButton
                text={text}
                active={readAloud.active}
                onSpeak={readAloud.onSpeak}
                onStop={readAloud.onStop}
                className="msg-bubble-read-aloud msg-bubble-read-aloud--user"
              />
            )}
            {text && <CopyButton text={text} className="msg-bubble-copy msg-bubble-copy--user" />}
          </div>
        )}
      </div>
    </div>
  );
}

interface TextBubbleProps {
  content: string;
  streaming?: boolean;
  timestamp?: number;
  readAloud?: ReadAloudProps;
}

export function TextBubble({ content, streaming = false, timestamp, readAloud }: TextBubbleProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const processed = streaming ? content : linkifyFilePaths(content);
  const [collapsed, setCollapsed] = useState(true);
  const [isLong, setIsLong] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Use a ref for currentPath so the useMemo components stay stable across
  // location changes (query params, navigation). The onClick handler reads
  // the ref at click time, not at memo creation time.
  const currentPathRef = useRef(location.pathname + location.search);
  currentPathRef.current = location.pathname + location.search;

  useEffect(() => {
    if (contentRef.current && !streaming) {
      setIsLong(contentRef.current.scrollHeight > COLLAPSE_HEIGHT);
    }
  }, [content, streaming]);

  const showCollapsed = isLong && collapsed && !streaming;

  // Memoize components so react-markdown preserves component instances
  // (e.g. MarkdownPreviewCard expanded state) across parent re-renders.
  // navigate is stable (from react-router), currentPath uses a ref to avoid
  // invalidating the memo on location changes.
  const mdComponents = useMemo(
    () => ({
      table: ({ children, ...props }: React.ComponentProps<'table'>) => (
        <div className="table-scroll-wrapper">
          <table {...props}>{children}</table>
        </div>
      ),
      pre: ({ children, ...props }: React.ComponentProps<'pre'>) => {
        const mermaidCode = getMermaidCode(children);
        if (mermaidCode !== null) return <MermaidBlock code={mermaidCode} />;
        const text = extractText(children);
        return (
          <div className="code-block-wrapper">
            <pre {...props}>{children}</pre>
            <CopyButton text={text} className="code-block-copy" label="Copy code" />
          </div>
        );
      },
      p: ({ children }: React.ComponentProps<'p'>) => {
        const childArray = React.Children.toArray(children);
        if (childArray.length === 1 && React.isValidElement(childArray[0])) {
          const el = childArray[0] as React.ReactElement<Record<string, unknown>>;
          const href = el.props?.href as string | undefined;
          if (href?.startsWith(FILE_SCHEME)) {
            const filePath = decodeURIComponent(href.slice(FILE_SCHEME.length));
            if (/\.mdx?$/i.test(filePath)) {
              return <MarkdownPreviewCard filePath={filePath} />;
            }
          }
        }
        return <p>{children}</p>;
      },
      a: ({ href, children }: React.ComponentProps<'a'>) => {
        if (href?.startsWith(FILE_SCHEME)) {
          const filePath = decodeURIComponent(href.slice(FILE_SCHEME.length));
          return (
            <span className="file-path-group">
              <a
                href="#"
                className="file-path-link"
                data-file-path={filePath}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(
                    `/files?path=${encodeURIComponent(filePath)}&from=${encodeURIComponent(currentPathRef.current)}`,
                  );
                }}
              >
                {children}
              </a>
              <ShareButton filePath={filePath} className="file-path-share" />
            </span>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [navigate],
  );

  return (
    <div
      className={`msg-bubble msg-bubble--assistant${streaming ? ' msg-bubble--streaming' : ''}${showCollapsed ? ' msg-bubble--collapsed' : ''}`}
    >
      <div className="msg-bubble-markdown" ref={contentRef}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          urlTransform={(url) => (url.startsWith(FILE_SCHEME) ? url : defaultUrlTransform(url))}
          components={mdComponents}
        >
          {processed}
        </ReactMarkdown>
      </div>
      {!streaming && (
        <div className="msg-bubble-footer">
          {isLong && (
            <button className="msg-bubble-collapse-toggle" onClick={() => setCollapsed((v) => !v)}>
              {collapsed ? 'Show more' : 'Show less'}
            </button>
          )}
          {timestamp && <span className="msg-timestamp">{formatTime(timestamp)}</span>}
          {readAloud && (
            <ReadAloudButton
              text={content}
              active={readAloud.active}
              onSpeak={readAloud.onSpeak}
              onStop={readAloud.onStop}
              className="msg-bubble-read-aloud"
            />
          )}
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
