import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { FinishedMessage } from '@mitzo/protocol';
import type {
  ConversationAgentSetup,
  ConversationArtifactOption,
} from '../lib/conversation-joining-review';
import {
  contextArtifactKey,
  contextMessagePresentation,
  selectableContextMessages,
  type ConversationContextMessageMetadata,
} from '../lib/conversation-context-selection';
import { formatFullMessageDate, formatMessageDate } from '../lib/formatTime';
import { markdownComponents, remarkPlugins, rehypePlugins } from '../lib/markdown-config';
import { MotionDetails } from './MotionDetails';
import './ConversationContextSelection.css';

export interface ConversationContextSelectionProps {
  messages: FinishedMessage[];
  messageIds: string[];
  artifacts: ConversationArtifactOption[] | undefined;
  selectedArtifacts: ConversationAgentSetup['artifacts'];
  messageMetadata?: Readonly<Record<string, ConversationContextMessageMetadata>>;
  onMessagesChange: (ids: string[]) => void;
  onArtifactsChange: (artifacts: ConversationAgentSetup['artifacts']) => void;
}

// Preview text never opens local paths, fetches images or runs diagram renderers.
const previewComponents = {
  ...markdownComponents,
  a: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  img: ({ alt }: { alt?: string }) => (
    <span>Image reference{alt ? `: ${alt}` : ''} (not loaded)</span>
  ),
  pre: ({ children }: { children?: ReactNode }) => <pre>{children}</pre>,
};

function MessagePreview({
  author,
  text,
  messageId,
}: {
  author: string;
  text: string;
  messageId: string;
}) {
  const [requested, setRequested] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = container.current;
    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement && event.target.open) setRequested(true);
    };
    node?.addEventListener('toggle', onToggle, true);
    return () => node?.removeEventListener('toggle', onToggle, true);
  }, []);
  return (
    <div ref={container}>
      <MotionDetails summary={`Preview message from ${author}`}>
        {requested && (
          <>
            <div className="context-source-preview">
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
                components={previewComponents}
              >
                {text}
              </ReactMarkdown>
            </div>
            <p className="context-source-meta">
              Message ID: <code>{messageId}</code>
            </p>
          </>
        )}
      </MotionDetails>
    </div>
  );
}

export function ConversationContextSelection({
  messages,
  messageIds,
  artifacts,
  selectedArtifacts,
  messageMetadata,
  onMessagesChange,
  onArtifactsChange,
}: ConversationContextSelectionProps) {
  const [query, setQuery] = useState('');
  const [author, setAuthor] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const rows = useMemo(
    () =>
      selectableContextMessages(messages).map((message) => ({
        message,
        ...contextMessagePresentation(message, messageMetadata?.[message.messageId]),
      })),
    [messages, messageMetadata],
  );
  const selectedIds = new Set(messageIds);
  const selectedKeys = new Set(selectedArtifacts.map(contextArtifactKey));
  const availableIds = new Set(rows.map(({ message }) => message.messageId));
  const availableKeys = new Set(artifacts?.map(contextArtifactKey));
  const absentIds = messageIds.filter((id) => !availableIds.has(id));
  const absentArtifacts = selectedArtifacts.filter(
    (artifact) => !availableKeys.has(contextArtifactKey(artifact)),
  );
  const authors = [...new Map(rows.map((row) => [row.authorId, row.authorLabel])).entries()];
  const search = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      (!selectedOnly || selectedIds.has(row.message.messageId)) &&
      (!author || row.authorId === author) &&
      (!search ||
        `${row.authorLabel} ${row.text} ${row.type}`.toLocaleLowerCase().includes(search)),
  );
  const hiddenSelected = rows.filter(
    (row) => selectedIds.has(row.message.messageId) && !visibleRows.includes(row),
  ).length;
  const progress = visibleRows.filter((row) => row.type === 'progress');
  const visibleArtifacts = (artifacts ?? []).filter(
    (artifact) => !selectedOnly || selectedKeys.has(contextArtifactKey(artifact)),
  );
  const toggleMessage = (id: string, checked: boolean) =>
    onMessagesChange(
      checked
        ? selectedIds.has(id)
          ? messageIds
          : [...messageIds, id]
        : messageIds.filter((selected) => selected !== id),
    );

  const renderMessage = (row: (typeof rows)[number]) => (
    <article className="context-source-row" key={row.message.messageId}>
      <label className="context-source-choice">
        <input
          type="checkbox"
          checked={selectedIds.has(row.message.messageId)}
          onChange={(event) => toggleMessage(row.message.messageId, event.target.checked)}
        />
        <span className="context-source-description">
          <strong>{row.authorLabel}</strong>{' '}
          <span className="context-source-meta">
            {row.type === 'progress' ? 'Progress' : row.type === 'reply' ? 'Reply' : 'Message'}
            {' · '}
            {row.timestamp !== undefined ? (
              <time
                dateTime={new Date(row.timestamp).toISOString()}
                title={formatFullMessageDate(row.timestamp) ?? undefined}
              >
                {formatMessageDate(row.timestamp)}
              </time>
            ) : (
              'Time not recorded'
            )}
          </span>{' '}
          <span className="context-source-excerpt">
            {row.text.replace(/\s+/g, ' ').slice(0, 180)}
            {row.text.replace(/\s+/g, ' ').length > 180 ? '…' : ''}
          </span>
        </span>
      </label>
      <MessagePreview author={row.authorLabel} text={row.text} messageId={row.message.messageId} />
    </article>
  );

  return (
    <section className="context-source-selector" aria-label="Choose starting context">
      <p>
        Choose messages and retained artifact versions. Leave all unchecked for the joining brief
        only.
      </p>
      <p className="context-source-meta">
        Paths mentioned in messages are text, not local file contents. Replies and files are not
        added automatically. Selection does not grant access.
      </p>
      <p role="status" aria-live="polite">
        {messageIds.length} messages · {selectedArtifacts.length} artifacts selected
        {hiddenSelected > 0 ? ` · ${hiddenSelected} selected messages hidden by filters` : ''}
        {absentIds.length + absentArtifacts.length > 0
          ? ` · ${absentIds.length + absentArtifacts.length} selections unavailable in this list`
          : ''}
      </p>
      <label className="context-source-choice">
        <input
          type="checkbox"
          checked={selectedOnly}
          onChange={(event) => setSelectedOnly(event.target.checked)}
        />
        Review selected only
      </label>
      <fieldset className="context-source-group">
        <legend>Messages</legend>
        <div className="context-source-filters">
          <label>
            Search messages
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label>
            Author
            <select value={author} onChange={(event) => setAuthor(event.target.value)}>
              <option value="">All authors</option>
              {authors.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {author && !authors.some(([id]) => id === author) && (
                <option value={author}>Author no longer in this list</option>
              )}
            </select>
          </label>
        </div>
        {visibleRows.length === 0 && (
          <p>
            {rows.length === 0
              ? 'No selectable text messages.'
              : 'No messages match these filters.'}
          </p>
        )}
        {visibleRows.filter((row) => row.type !== 'progress').map(renderMessage)}
        {progress.length > 0 && (
          <MotionDetails
            summary={`Progress (${progress.length}) · ${progress.filter((row) => selectedIds.has(row.message.messageId)).length} selected`}
          >
            {progress.map(renderMessage)}
          </MotionDetails>
        )}
        {absentIds.map((id) => (
          <div className="context-source-unavailable" key={id}>
            <span>
              Selected message unavailable in this list: <code>{id}</code>
            </span>
            <button
              type="button"
              className="home-secondary"
              onClick={() => toggleMessage(id, false)}
            >
              Remove unavailable message {id}
            </button>
          </div>
        ))}
      </fieldset>
      <fieldset className="context-source-group">
        <legend>Retained artifacts</legend>
        {artifacts === undefined ? (
          <p>Retained artifact versions are unavailable for selection.</p>
        ) : artifacts.length === 0 ? (
          <p>No retained artifacts in this conversation.</p>
        ) : visibleArtifacts.length === 0 ? (
          <p>No retained artifacts selected.</p>
        ) : null}
        {visibleArtifacts.map((artifact) => {
          const key = contextArtifactKey(artifact);
          return (
            <article className="context-source-row" key={key}>
              <label className="context-source-choice">
                <input
                  type="checkbox"
                  checked={selectedKeys.has(key)}
                  disabled={artifact.available === false && !selectedKeys.has(key)}
                  onChange={(event) =>
                    onArtifactsChange(
                      event.target.checked
                        ? selectedKeys.has(key)
                          ? selectedArtifacts
                          : [
                              ...selectedArtifacts,
                              {
                                artifactId: artifact.artifactId,
                                revision: artifact.revision,
                                sha256: artifact.sha256,
                              },
                            ]
                        : selectedArtifacts.filter(
                            (selected) => contextArtifactKey(selected) !== key,
                          ),
                    )
                  }
                />
                <span className="context-source-description">
                  <strong>{artifact.title}</strong>{' '}
                  <span>{artifact.filename ?? 'Filename not recorded'}</span>{' '}
                  <span className="context-source-meta">
                    Retained artifact · Saved version {artifact.revision}
                  </span>{' '}
                  <span className="context-source-meta">
                    Author: {artifact.authorLabel ?? 'not recorded'} ·{' '}
                    {artifact.available === false
                      ? 'Unavailable'
                      : artifact.available === true
                        ? 'Available for review'
                        : 'Availability not recorded'}
                  </span>{' '}
                  <span className="context-source-meta">
                    Access: {artifact.accessLabel ?? 'not recorded; checked during review'}
                  </span>
                </span>
              </label>
              <MotionDetails summary={`Version details for ${artifact.title}`}>
                <p>
                  Artifact ID: <code>{artifact.artifactId}</code>
                </p>
                <p>
                  SHA-256: <code>{artifact.sha256}</code>
                </p>
                <p>
                  Selection pins this exact version for review. It does not share a local file or
                  change access.
                </p>
              </MotionDetails>
            </article>
          );
        })}
        {absentArtifacts.map((artifact) => (
          <div className="context-source-unavailable" key={contextArtifactKey(artifact)}>
            <span>
              Selected artifact unavailable in this list: <code>{artifact.artifactId}</code> · Saved
              version {artifact.revision} · SHA-256 <code>{artifact.sha256}</code>
            </span>
            <button
              type="button"
              className="home-secondary"
              onClick={() =>
                onArtifactsChange(
                  selectedArtifacts.filter(
                    (selected) => contextArtifactKey(selected) !== contextArtifactKey(artifact),
                  ),
                )
              }
            >
              Remove unavailable artifact {artifact.artifactId} version {artifact.revision}
            </button>
          </div>
        ))}
      </fieldset>
      {messageIds.length === 0 && selectedArtifacts.length === 0 && <p>Joining brief only.</p>}
    </section>
  );
}
