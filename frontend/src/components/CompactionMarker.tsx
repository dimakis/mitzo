import { compactionDuration, compactionLabel } from '../lib/compaction-presentation';
import { useEffect, useState } from 'react';
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
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (record.phase !== 'compacting' || record.startedAt == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [record.phase, record.startedAt]);
  const before = record.usageBefore;
  const after = record.usageAfter;
  const model = before?.model ?? after?.model;
  const ceiling = before?.contextCeiling ?? after?.contextCeiling;
  const time = (at: number) => (
    <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString()}</time>
  );
  return (
    <div className="compaction-details">
      <p role="status">{compactionLabel(record)}</p>
      {record.phase === 'compacting' && (
        <p>
          Waiting for the runtime to report completion. Elapsed time is not a progress estimate; a
          long wait alone does not confirm failure.
        </p>
      )}
      {(record.phase === 'interrupted' || record.phase === 'unknown') && (
        <p>
          Execution ended before the runtime reported a compaction result. Completion and any
          context reduction are unconfirmed.
        </p>
      )}
      <dl>
        {record.startedAt != null && (
          <>
            <dt>Started</dt>
            <dd>{time(record.startedAt)}</dd>
          </>
        )}
        {record.endedAt != null && (
          <>
            <dt>{record.phase === 'completed' ? 'Completed' : 'Ended'}</dt>
            <dd>{time(record.endedAt)}</dd>
          </>
        )}
        {record.startedAt != null && (record.endedAt != null || record.phase === 'compacting') && (
          <>
            <dt>{record.phase === 'compacting' ? 'Elapsed' : 'Duration'}</dt>
            <dd>{compactionDuration((record.endedAt ?? now) - record.startedAt)}</dd>
          </>
        )}
        {model && (
          <>
            <dt>Model</dt>
            <dd>{model}</dd>
          </>
        )}
        {record.turnIndex !== null && (
          <>
            <dt>Agent request</dt>
            <dd>{record.turnIndex}</dd>
          </>
        )}
        <dt>Last lifecycle update</dt>
        <dd>{time(record.observedAt)}</dd>
      </dl>
      <dl aria-label="Context usage">
        <dt>{record.beforeTokens !== null ? 'Reported before' : 'Last observed before'}</dt>
        <dd>
          {record.beforeTokens?.toLocaleString() ??
            before?.tokens.toLocaleString() ??
            'Not reported'}
          {record.beforeTokens === null && before && <small>{time(before.observedAt)}</small>}
        </dd>
        <dt>
          {record.afterTokens !== null
            ? 'Reported after'
            : record.phase === 'completed'
              ? 'First observed after'
              : 'Context after'}
        </dt>
        <dd>
          {record.afterTokens?.toLocaleString() ??
            (record.phase === 'completed'
              ? (after?.tokens.toLocaleString() ?? 'Awaiting fresh usage')
              : 'Not confirmed')}
          {record.afterTokens === null && record.phase === 'completed' && after && (
            <small>{time(after.observedAt)}</small>
          )}
        </dd>
        {ceiling != null && (
          <>
            <dt>Context limit</dt>
            <dd>{ceiling.toLocaleString()}</dd>
          </>
        )}
      </dl>
      {(before || after) && (
        <p className="workspace-muted">
          Usage readings are observations around compaction, not exact compaction sizes. They can
          include work before or after it.
        </p>
      )}
      <p className="workspace-muted">
        Your original chat remains browsable. Cumulative usage is not reset.
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
        <p className="workspace-muted">
          The condensed range is unavailable.
          {!record.summary && ' No readable retained summary was exposed.'}
        </p>
      )}
      {record.summary && (
        <details>
          <summary>Retained summary</summary>
          <pre>{record.summary}</pre>
        </details>
      )}
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
