import { compactionLabel } from '../lib/compaction-presentation';
import { useState } from 'react';
import type { ContextCompaction } from '@mitzo/protocol';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';

export function CompactionDetails({
  record,
  onJump,
}: {
  record: ContextCompaction;
  onJump?(): void;
}) {
  return (
    <div className="compaction-details">
      <p role="status">
        {compactionLabel(record)} · {new Date(record.observedAt).toLocaleTimeString()}
      </p>
      {(record.phase === 'interrupted' || record.phase === 'unknown') && (
        <p>
          Execution ended before the runtime reported a compaction result. Completion and any
          context reduction are unconfirmed.
        </p>
      )}
      <p>
        {record.turnIndex !== null
          ? `Recorded at agent request ${record.turnIndex}.`
          : 'The runtime did not report a request number.'}
      </p>
      {record.afterMessageId && onJump && (
        <button type="button" onClick={onJump}>
          <UiIcon name="chats" size={16} />
          Show in conversation
        </button>
      )}
      {record.condensedRange ? (
        <p>
          Condensed range: {record.condensedRange.firstMessageId} →{' '}
          {record.condensedRange.lastMessageId}
        </p>
      ) : (
        <p>
          The runtime did not report which earlier messages were condensed. The condensed range is
          unavailable.
        </p>
      )}
      <dl>
        <dt>Context before compaction</dt>
        <dd>{record.beforeTokens?.toLocaleString() ?? 'Not reported'}</dd>
        <dt>Context after compaction</dt>
        <dd>
          {record.afterTokens?.toLocaleString() ??
            (record.phase === 'compacting' ? 'Waiting for completion' : 'Not reported')}
        </dd>
      </dl>
      <p className="workspace-muted">
        Compaction reduces what the model retains. Cumulative usage is not reset; your original chat
        remains browsable.
      </p>
      <details>
        <summary>Retained summary</summary>
        {record.summary ? (
          <pre>{record.summary}</pre>
        ) : (
          <p>No summary was supplied by this runtime.</p>
        )}
      </details>
      {record.retainedProviderMessageIds.length > 0 && (
        <details>
          <summary>Provider-reported retained messages</summary>
          <p className="workspace-muted">
            These are provider IDs; they have not been mapped to chat message boundaries.
          </p>
          {record.retainedProviderMessageIds.map((id) => (
            <code key={id}>{id}</code>
          ))}
        </details>
      )}
    </div>
  );
}
export function CompactionMarker({
  record,
  positionKnown = true,
}: {
  record: ContextCompaction;
  positionKnown?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="chat-compaction"
      id={`chat-compaction-${record.id}`}
      data-compaction-id={record.id}
    >
      <button
        type="button"
        className="chat-compaction-marker"
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        <UiIcon name={record.phase === 'compacting' ? 'loading' : 'compact'} size={16} />
        <span>
          {compactionLabel(record)}
          <small>
            {!positionKnown
              ? 'Transcript position unavailable'
              : record.turnIndex !== null
                ? `Agent request ${record.turnIndex}`
                : 'Position observed in this session'}
          </small>
        </span>
        <UiIcon name="forward" size={16} />
      </button>
      {open && (
        <HomeDialog
          title="Context compaction"
          className="chat-resource-dialog"
          onClose={() => setOpen(false)}
        >
          <CompactionDetails record={record} />
        </HomeDialog>
      )}
    </div>
  );
}
