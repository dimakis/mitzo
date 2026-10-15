import ReactMarkdown from 'react-markdown';
import { useSavedSessionMessages } from '../hooks/useSavedSessionMessages';
export function SavedSessionHistory({ sessionId }: { sessionId: string }) {
  const history = useSavedSessionMessages(sessionId);
  return (
    <div className="session-history" aria-busy={!history.messages && !history.error}>
      {history.error ? (
        <p role="status">
          Couldn’t load preview.{' '}
          <button type="button" className="home-text-action" onClick={history.retry}>
            Try again
          </button>
        </p>
      ) : history.messages == null ? (
        <p role="status">Loading preview…</p>
      ) : history.messages.length === 0 ? (
        <p>No saved messages yet.</p>
      ) : (
        history.messages.map((message, index) => (
          <article
            key={`${message.id}:${index}`}
            className={`session-preview-message session-preview-message--${message.role}`}
          >
            <p className="session-preview-speaker">
              {message.role === 'user' ? 'You' : 'Assistant'}
            </p>
            <ReactMarkdown
              skipHtml
              components={{
                a: ({ children }) => <span>{children}</span>,
                img: ({ alt }) => <span>{alt || 'Image'}</span>,
              }}
            >
              {message.text}
            </ReactMarkdown>
          </article>
        ))
      )}
    </div>
  );
}
