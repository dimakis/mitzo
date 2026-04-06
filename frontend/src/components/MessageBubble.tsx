import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FinishedMessage } from '../types/chat';

interface UserBubbleProps {
  text?: string;
  images?: string[];
  contextNames?: string[];
}

export function UserBubble({ text, images, contextNames }: UserBubbleProps) {
  return (
    <div className="msg-bubble msg-bubble--user">
      {contextNames && contextNames.length > 0 && (
        <div className="msg-bubble-context">@ {contextNames.join(', ')}</div>
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
  );
}

interface TextBubbleProps {
  content: string;
  streaming?: boolean;
}

export function TextBubble({ content, streaming = false }: TextBubbleProps) {
  return (
    <div className={`msg-bubble msg-bubble--assistant${streaming ? ' msg-bubble--streaming' : ''}`}>
      <div className="msg-bubble-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            table: ({ children, ...props }) => (
              <div className="table-scroll-wrapper">
                <table {...props}>{children}</table>
              </div>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
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
    return <UserBubble text={textBlock?.content} images={message.images} />;
  }
  const textBlock = message.blocks.find((b) => b.blockType === 'text');
  return <TextBubble content={textBlock?.content || ''} />;
}
