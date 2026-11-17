import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CollaborationSettings, CollaborationDurableTranscript } from '@mitzo/protocol';
import { formatMessageDate, formatFullMessageDate } from '../lib/formatTime';

/** Public recorded configuration only; membership is not proof of runtime readiness. */
export function ConversationShareAgentDetails({ settings }: { settings?: CollaborationSettings }) {
  if (!settings) return <small>Recorded configuration unavailable</small>;
  const { binding, selection } = settings;
  const type =
    binding.harness.implementation === 'codex'
      ? 'Codex'
      : binding.harness.implementation === 'claude-sdk'
        ? 'Claude Code'
        : binding.harness.implementation;
  return (
    <span className="conversation-share-agent-details">
      <small>Type: {type}</small>
      <small>
        Profile: {selection.agent?.profileId ?? 'Unavailable'}
        {selection.agent ? ` · revision ${selection.agent.revision}` : ''}
      </small>
      <small>Model: {selection.model}</small>
      <small>Thinking: {selection.thinking ?? 'Not configurable'}</small>
      <small>Account: {binding.account.accountId}</small>
      <small>
        Recorded configuration ·{' '}
        {binding.execution.location === 'local' ? 'Local Mac' : 'OpenShell'}
      </small>
    </span>
  );
}

/** Cheap text excerpts reuse the already-authorized source. Markdown mounts only on expansion. */
export const ConversationShareMessageDetails = memo(function ConversationShareMessageDetails({
  message,
  names,
}: {
  message: CollaborationDurableTranscript['messages'][number];
  names: Readonly<Record<string, string>>;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = message.blocks.map((block) => block.content).join('\n\n');
  const author =
    message.author === 'operator'
      ? 'You'
      : (names[message.author.sessionId] ?? 'Agent (name unavailable)');
  return (
    <span className="conversation-share-message-details">
      <span className="conversation-share-message-meta">
        <strong>{author}</strong>
        {message.recordedAt !== undefined ? (
          <time
            dateTime={new Date(message.recordedAt).toISOString()}
            title={formatFullMessageDate(message.recordedAt) ?? undefined}
          >
            {formatMessageDate(message.recordedAt)}
          </time>
        ) : (
          <small>Time unavailable</small>
        )}
      </span>
      <span>{text.length > 240 ? text.slice(0, 240) + '…' : text}</span>
      {text.length > 240 && (
        <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>Read full message</summary>
          {expanded && (
            <div className="conversation-share-message-full">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          )}
        </details>
      )}
    </span>
  );
});
