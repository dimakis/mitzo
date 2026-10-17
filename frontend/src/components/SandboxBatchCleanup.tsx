import { useEffect, useRef, useState } from 'react';
import { HomeDialog } from './HomeDialog';
import { readApiJson } from '../lib/api-json-read';
import { apiFetch } from '../lib/api-fetch';
import type { SandboxCleanupPreview, SandboxConversation } from '../types/sandboxes';
interface Row {
  item: SandboxConversation;
  status: string;
  eligible: boolean;
}
function checkedPreview(item: SandboxConversation, preview: SandboxCleanupPreview) {
  if (
    !item.physicalId ||
    preview.record?.conversationId !== item.conversationId ||
    preview.record.sandboxName !== item.sandboxName ||
    preview.record.physicalSandboxId !== item.physicalId
  )
    throw Error('Sandbox identity changed. Refresh inventory and review again.');
  if (
    !['delete', 'stop_and_delete'].includes(preview.action) ||
    preview.blockers.length ||
    !preview.token
  )
    throw Error(
      preview.blockers.length
        ? preview.blockers.map((x) => x.replaceAll('_', ' ')).join(', ')
        : 'Deletion is unavailable. Review this conversation individually.',
    );
  return preview;
}
export function SandboxBatchCleanup({
  items,
  onClose,
  onChanged,
}: {
  items: SandboxConversation[];
  onClose(): void;
  onChanged(): void | Promise<void>;
}) {
  const [rows, setRows] = useState<Row[]>(
    items.map((item) => ({ item, status: 'Reviewing…', eligible: false })),
  );
  const [phase, setPhase] = useState<'reviewing' | 'ready' | 'executing' | 'complete'>('reviewing');
  const [ack, setAck] = useState(false),
    [refreshError, setRefreshError] = useState('');
  const mounted = useRef(false),
    inFlight = useRef(false),
    controller = useRef<AbortController | null>(null);
  const update = (index: number, status: string, eligible = false) => {
    if (mounted.current)
      setRows((current) =>
        current.map((row, i) => (i === index ? { ...row, status, eligible } : row)),
      );
  };
  useEffect(() => {
    mounted.current = true;
    setRows(items.map((item) => ({ item, status: 'Reviewing…', eligible: false })));
    setAck(false);
    setPhase('reviewing');
    const abort = new AbortController();
    controller.current = abort;
    void (async () => {
      for (const [index, item] of items.entries()) {
        if (abort.signal.aborted) return;
        try {
          const preview = await readApiJson<SandboxCleanupPreview>(
            '/api/openshell/lifecycle/' +
              encodeURIComponent(item.conversationId) +
              '/preview?intent=delete',
            abort.signal,
          );
          checkedPreview(item, preview);
          if (abort.signal.aborted) return;
          update(index, 'Ready to delete', true);
        } catch (error) {
          if (!abort.signal.aborted)
            update(index, error instanceof Error ? error.message : 'Review unavailable.');
        }
      }
      if (!abort.signal.aborted) setPhase('ready');
    })();
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [items]);
  const confirm = async () => {
    if (
      inFlight.current ||
      !ack ||
      phase !== 'ready' ||
      !rows.length ||
      rows.some((row) => !row.eligible)
    )
      return;
    inFlight.current = true;
    setPhase('executing');
    let attempted = false;
    for (const [index, { item }] of rows.entries()) {
      if (!mounted.current || controller.current?.signal.aborted) break;
      let submitted = false;
      try {
        update(index, 'Rechecking…');
        const fresh = checkedPreview(
          item,
          await readApiJson<SandboxCleanupPreview>(
            '/api/openshell/lifecycle/' +
              encodeURIComponent(item.conversationId) +
              '/preview?intent=delete',
            controller.current?.signal,
          ),
        );
        if (!mounted.current || controller.current?.signal.aborted) break;
        submitted = true;
        attempted = true;
        update(index, 'Deleting…');
        const abort = new AbortController();
        let timeout!: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(Error('Confirmation timed out.'));
            abort.abort();
          }, 30_000);
        });
        try {
          // Bound headers and body, even when the transport ignores abort. Never replay a write.
          await Promise.race([
            (async () => {
              const response = await apiFetch('/api/openshell/lifecycle/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: fresh.token }),
                signal: abort.signal,
              });
              const body = await response.json();
              if (!response.ok || body.action !== 'deleted')
                throw Error(body.error || 'Deletion was not confirmed.');
            })(),
            deadline,
          ]);
        } finally {
          clearTimeout(timeout);
        }
        update(index, 'Deleted; chat and checkpoint retained');
      } catch (error) {
        update(
          index,
          (submitted ? 'Outcome unverified. Refresh before another attempt. ' : '') +
            (error instanceof Error ? error.message : 'Review unavailable.'),
        );
        for (let next = index + 1; next < rows.length; next++)
          update(next, 'Not attempted; review again after resolving the earlier result.');
        break;
      }
    }
    if (mounted.current) {
      // An unsuccessful request can have stopped/deleted a resource. Refresh in both cases.
      if (attempted) {
        try {
          await onChanged();
        } catch {
          if (mounted.current)
            setRefreshError('Inventory refresh failed. Refresh before starting another cleanup.');
        }
      }
      if (mounted.current) setPhase('complete');
    }
    inFlight.current = false;
  };
  const ready = phase === 'ready' && rows.length > 0 && rows.every((row) => row.eligible);
  return (
    <HomeDialog
      title="Review sandbox cleanup"
      onClose={() => {
        if (!inFlight.current) onClose();
      }}
    >
      {refreshError && <p role="alert">{refreshError}</p>}
      <p>
        Delete only these selected physical sandboxes. Ready sandboxes are checkpointed and stopped
        first. Saved chats, provider history and verified recovery checkpoints are retained.
        Automatic deletion settings stay unchanged.
      </p>
      <div className="access-row-group">
        {rows.map(({ item, status }) => (
          <div className="sandbox-pool" key={item.conversationId}>
            <div className="access-row-copy">
              <h3>{item.title}</h3>
              <p>{item.account}</p>
              <p>
                <code>{item.sandboxName}</code>
              </p>
              <p>
                <code>{item.physicalId}</code>
              </p>
              <p role="status">{status}</p>
            </div>
          </div>
        ))}
      </div>
      {ready && (
        <label className="sandbox-check">
          <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
          <span>
            I reviewed the {rows.length} selected {rows.length === 1 ? 'sandbox' : 'sandboxes'} and
            their retained recovery history.
          </span>
        </label>
      )}
      {phase === 'ready' && !ready && (
        <p>
          Resolve blocked resources or close this review and change the selection. No sandboxes have
          been changed.
        </p>
      )}
      {phase !== 'complete' && (
        <button className="sandbox-danger" disabled={!ready || !ack} onClick={() => void confirm()}>
          {phase === 'executing' ? 'Cleanup in progress…' : 'Delete reviewed sandboxes'}
        </button>
      )}
      <button className="home-secondary" disabled={phase === 'executing'} onClick={onClose}>
        {phase === 'complete' ? 'Done' : 'Cancel'}
      </button>
    </HomeDialog>
  );
}
