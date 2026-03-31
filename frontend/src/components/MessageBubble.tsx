import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../pages/ChatView';

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

  return (
    <div className="msg-bubble msg-bubble--assistant">
      <div className="msg-bubble-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text || ''}</ReactMarkdown>
        {message.streaming && <span className="msg-cursor" />}
      </div>
    </div>
  );
}
