import { useEffect, useState } from 'react';
import type { TelosWorkItem, TelosWorkLifecycleView } from '@mitzo/protocol';
import { useTelosLifecycle } from '../hooks/useTelosLifecycle';
import { HomeDialog } from './HomeDialog';
import { WorkspaceActionMenu, type WorkspaceMenuItem } from './WorkspaceActionMenu';
import './TelosWorkspace.css';
type Confirmation = {
  operation: 'archive' | 'trash' | 'delete_permanently';
  revision: string;
  retry: boolean;
};
const pauseLabels = {
  running: 'No operator pause',
  requested: 'Pause requested',
  acknowledged: 'Pause acknowledged · application pending',
  applied: 'Pause applied',
};
/** Lifecycle facts come only from a current owner read. Action receipts recover
 * exact requests; they are not projected as current pause or visibility state. */
export function TelosItemLifecycle({
  itemId,
  title,
  kind,
  parentId,
  refreshKey,
  onOpen,
  onDeleted,
  onCurrentState,
}: {
  itemId: string;
  title: string;
  kind: TelosWorkItem['kind'];
  parentId?: string | null;
  refreshKey: string | number;
  onOpen(id: string): void;
  onDeleted?(): void;
  onCurrentState?(view: TelosWorkLifecycleView): void;
}) {
  const state = useTelosLifecycle(itemId, refreshKey, onDeleted);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [phrase, setPhrase] = useState('');
  useEffect(() => {
    setConfirmation(null);
    setPhrase('');
  }, [state.authScope]);
  const value = state.lifecycle;
  useEffect(() => {
    if (state.current && value) onCurrentState?.(value);
  }, [state.current, value, onCurrentState]);
  const disabled =
    state.busy || !state.current || !!state.pending || state.recoveryBlocked || state.deleted;
  const ownPause = !!value?.pause.controls.some(
    (control) =>
      control.coordinatorItemId === itemId &&
      control.origin === 'operator_pause' &&
      control.stage !== 'released',
  );
  const inheritedPause = value?.pause.controls.find(
    (control) => control.coordinatorItemId !== itemId,
  );
  const pauseUnavailable = kind === 'work_item' || value?.effectiveDisposition !== 'active';
  function review(operation: Confirmation['operation'], retry = false) {
    const revision = retry ? state.pending?.command.expectedRevision : value?.revision;
    if (!revision) return;
    setPhrase('');
    setConfirmation({ operation, revision, retry });
  }
  async function confirm() {
    if (!confirmation || state.busy) return;
    if (confirmation.operation === 'delete_permanently' && phrase !== 'DELETE PERMANENTLY') return;
    const accepted = confirmation.retry
      ? await state.retry()
      : await state.send(confirmation.operation, {
          expectedRevision: confirmation.revision,
          ...(confirmation.operation === 'delete_permanently'
            ? { confirmation: { itemId, phrase: 'DELETE PERMANENTLY' as const } }
            : {}),
        });
    if (accepted) {
      setConfirmation(null);
    }
  }
  const items: WorkspaceMenuItem[] = !value
    ? []
    : value.disposition === 'trashed'
      ? [
          {
            id: 'restore',
            label: 'Restore',
            icon: 'undo',
            onSelect: () => {
              void state.send('restore');
            },
          },
          {
            id: 'delete',
            label: 'Delete permanently',
            icon: 'trash',
            danger: true,
            onSelect: () => review('delete_permanently'),
          },
        ]
      : [
          value.disposition === 'archived'
            ? {
                id: 'unarchive',
                label: 'Unarchive',
                icon: 'undo',
                onSelect: () => {
                  void state.send('unarchive');
                },
              }
            : { id: 'archive', label: 'Archive', icon: 'files', onSelect: () => review('archive') },
          { id: 'trash', label: 'Move to Trash', icon: 'trash', onSelect: () => review('trash') },
        ];
  const dialogTitle =
    confirmation?.operation === 'delete_permanently'
      ? 'Delete item permanently?'
      : confirmation?.operation === 'trash'
        ? 'Move item to Trash?'
        : 'Archive item?';
  const confirmLabel =
    confirmation?.operation === 'delete_permanently'
      ? 'Delete permanently'
      : confirmation?.operation === 'trash'
        ? 'Move to Trash'
        : 'Archive';
  const changed =
    !!confirmation && !confirmation.retry && !!value && value.revision !== confirmation.revision;
  const hostRefusal =
    state.pending?.command.operation === 'delete_permanently' &&
    state.refusal?.status === 409 &&
    state.refusal.code === 'conflict' &&
    state.refusal.message === 'Verified host quiescence required for permanent deletion';
  const errorNotice = hostRefusal ? (
    <div role="alert">
      <p>
        Permanent deletion is unavailable because this server cannot verify that it is safe. This
        request did not delete the item.
      </p>
      <details>
        <summary>Request details</summary>
        <p>
          HTTP {state.refusal!.status} · {state.refusal!.code}
        </p>
        <p>{state.refusal!.message}</p>
      </details>
    </div>
  ) : (
    <p role="alert">{state.error}</p>
  );
  return (
    <section className="telos-item-lifecycle" aria-label="Item lifecycle">
      <div className="telos-lifecycle-row">
        <div className="telos-lifecycle-state">
          {value && (
            <>
              <span>{pauseLabels[value.pause.stage]}</span>
              {value.disposition === 'archived' && <span>Archived</span>}
              {value.disposition === 'trashed' && <span>In Trash</span>}
              {value.inheritedFrom && <span>Hidden with containing item</span>}
            </>
          )}
          {!state.current && !state.deleted && (
            <p role="status">
              {state.error && !state.pending && !state.recoveryBlocked
                ? `Item controls unavailable. ${state.error}`
                : value
                  ? 'Refreshing item controls. Last recorded state is shown.'
                  : 'Loading item controls…'}
            </p>
          )}
        </div>
        {value && !state.deleted && (
          <button
            className="home-secondary"
            disabled={disabled || pauseUnavailable}
            onClick={() => {
              void state.send(ownPause ? 'resume' : 'pause');
            }}
          >
            {ownPause ? 'Resume' : 'Pause'}
          </button>
        )}
        <WorkspaceActionMenu label="Item actions" disabled={disabled} items={items} />
        {!state.deleted && (
          <button
            className="home-secondary"
            disabled={state.busy}
            onClick={state.refresh}
            aria-label="Refresh item controls"
          >
            Refresh
          </button>
        )}
      </div>
      {value && pauseUnavailable && (
        <p>
          {kind === 'work_item'
            ? 'Pause an outcome or coordinator to hold this work item.'
            : 'Restore or unarchive the item that hides this work before pausing or resuming.'}
        </p>
      )}
      {(value?.inheritedFrom || inheritedPause || (kind === 'work_item' && parentId)) && (
        <button
          className="home-text-action"
          onClick={() =>
            onOpen(value?.inheritedFrom ?? inheritedPause?.coordinatorItemId ?? parentId!)
          }
        >
          Open containing item
        </button>
      )}
      {value && <p>Other holds may still apply.</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {state.error && !confirmation && (state.pending || state.recoveryBlocked) && errorNotice}
      {state.pending && (
        <div className="telos-lifecycle-recovery">
          <p>
            {state.pending.status === 'sending'
              ? 'Recording the lifecycle request…'
              : state.pending.status === 'review'
                ? 'Review current state before retrying this retained request.'
                : state.pending.status === 'refused'
                  ? 'Request refused. Review current state before another request.'
                  : state.pending.status === 'recorded'
                    ? 'Request recorded. Retained retry data remains.'
                    : 'The original request is retained for an explicit retry.'}
          </p>
          {state.pending.status === 'refused' || state.pending.status === 'review' ? (
            <button
              className="home-secondary"
              disabled={
                state.busy || (state.pending.status === 'review' && !state.canReviewRetained)
              }
              onClick={
                state.pending.status === 'refused' ? state.reviewRefused : state.reviewRetained
              }
            >
              Review current state
            </button>
          ) : (
            state.pending.status !== 'sending' && (
              <button
                className="home-secondary"
                disabled={state.busy}
                onClick={() => {
                  if (state.pending?.command.operation === 'delete_permanently')
                    review('delete_permanently', true);
                  else {
                    void state.retry();
                  }
                }}
              >
                Retry original request
              </button>
            )
          )}
          <details>
            <summary>Retained request details</summary>
            <dl>
              <dt>Item</dt>
              <dd>{state.pending.command.itemId}</dd>
              <dt>Operation</dt>
              <dd>{state.pending.command.operation}</dd>
              <dt>Request</dt>
              <dd>{state.pending.command.requestId}</dd>
            </dl>
          </details>
        </div>
      )}
      {state.recoveryBlocked && (
        <button
          className="home-secondary"
          disabled={!state.current || state.busy}
          onClick={state.reviewRecovery}
        >
          Discard invalid recovery data after review
        </button>
      )}
      {confirmation && (
        <HomeDialog
          title={dialogTitle}
          onClose={() => {
            if (!state.busy) setConfirmation(null);
          }}
        >
          <p>{title}</p>
          <p>{itemId}</p>
          {confirmation.operation === 'archive' ? (
            <p>
              Archive hides this item and its child work from Active. History, sources and saved
              files remain. Running work is not forcibly stopped.
            </p>
          ) : confirmation.operation === 'trash' ? (
            <p>
              Move this item to recoverable Trash. Child work is hidden with it and keeps its own
              state. You can restore it later; there is no automatic purge. Saved files and history
              remain. Running work is not forcibly stopped.
            </p>
          ) : (
            <>
              <p>
                This is separate from moving to Trash. Deletion requires an unreferenced leaf and
                verified idle execution. Items with child work or retained references stay in Trash.
                Shared files and other items are not deleted.
              </p>
              {confirmation.retry && (
                <p>
                  Original deletion is not confirmed. This retries the exact original request to
                  recover its result.
                </p>
              )}
              <label className="home-search">
                Type DELETE PERMANENTLY to confirm
                <input
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  autoComplete="off"
                  disabled={state.busy}
                />
              </label>
            </>
          )}
          {changed && (
            <p role="status">
              This item changed. Close and review its current state before confirming.
            </p>
          )}
          {state.error && errorNotice}
          <footer>
            <button
              className="home-secondary"
              disabled={state.busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
            <button
              className={`home-secondary${confirmation.operation === 'delete_permanently' || confirmation.operation === 'trash' ? ' home-danger' : ''}`}
              disabled={
                state.busy ||
                changed ||
                (!confirmation.retry && !state.current) ||
                (confirmation.operation === 'delete_permanently' && phrase !== 'DELETE PERMANENTLY')
              }
              onClick={() => {
                void confirm();
              }}
            >
              {state.busy ? 'Recording…' : confirmLabel}
            </button>
          </footer>
        </HomeDialog>
      )}
    </section>
  );
}
