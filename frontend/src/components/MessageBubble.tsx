import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../types/chat';

interface Props {
  message: Message;
}

export function MessageBubble({ message }: Props) {
  if (message.role === 'user') {
    return (
      <div className="msg-bubble msg-bubble--user">
        {message.images && message.images.length > 0 && (
          <div className="msg-bubble-images">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt={`Attachment ${i + 1}`} className="msg-bubble-img" />
            ))}
          </div>
        )}
        {message.text && <div className="msg-bubble-content">{message.text}</div>}
      </div>
    );
  }

  const base = message.reasoning ? 'msg-bubble--reasoning' : 'msg-bubble--assistant';
  const streaming = message.streaming ? ' msg-bubble--streaming' : '';

  return (
    <div className={`msg-bubble ${base}${streaming}`}>
      <div className="msg-bubble-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text || ''}</ReactMarkdown>
      </div>
    </div>
  );
}
