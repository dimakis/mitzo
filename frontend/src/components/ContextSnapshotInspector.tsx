import { useCallback, useId, useRef, useState } from 'react';
import type { ContextSnapshotReason } from '@mitzo/protocol';
import { useContextSnapshot } from '../hooks/useContextSnapshot';
import { HomeDialog } from './HomeDialog';
import { MotionPresence } from './MotionPresence';
import { ContextSnapshotFacts } from './ContextSnapshotFacts';
import './ContextSnapshotInspector.css';

const reasons: Record<ContextSnapshotReason, string> = {
  not_observed: 'No context observation has been recorded.',
  adapter_not_attached: 'This runtime has no context inspection adapter attached.',
  unsupported_route: 'Context inspection is not supported on this route.',
  refresh_unsupported: 'This runtime records usage from events and cannot refresh on demand.',
  control_missing: 'The native context inspection control is unavailable.',
  query_retired: 'The inspected query has retired.',
  scope_changed: 'The runtime binding changed. Close and reopen this inspection.',
  timed_out: 'Inspection timed out; token-count work may have occurred. Nothing was retried.',
  cancelled: 'Inspection was cancelled. Nothing was retried.',
  invalid_response: 'The runtime returned an invalid observation.',
  control_failed: 'The native inspection failed. Nothing was retried.',
  token_count_not_authorized: 'Token-count inspection was not authorized.',
  authority_expired: 'Access expired. Verify access before reopening.',
  detached: 'The runtime is detached.',
  suspended: 'The runtime is suspended.',
  compacted: 'Context has been compacted since this observation.',
  turn_completed: 'The observed turn has completed.',
  restored: 'Retained evidence needs a new observation after restore.',
  expired: 'This observation has expired.',
  superseded: 'This request was superseded. No token-count operation was repeated.',
  storage_failed: 'The observation could not be saved.',
  request_conflict: 'The request no longer matches its original runtime or authority.',
};

export function ContextSnapshotInspector({
  sessionId,
  disabled = false,
}: {
  sessionId: string;
  disabled?: boolean;
}) {
  // A new conversation gets an independent dialog/request lifetime immediately.
  return <Inspector key={`${sessionId}:${disabled}`} sessionId={sessionId} disabled={disabled} />;
}

function Inspector({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [consent, setConsent] = useState(false);
  const consentId = useId();
  // Starting a full refresh unmounts its consent section, including the activated
  // button. Keep keyboard focus (and Escape) inside the dialog rather than letting
  // it fall to the page, where Escape would also dismiss the opener's popover.
  const result = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => {
    setOpen(false);
    setFull(false);
    setConsent(false);
  }, []);
  const state = useContextSnapshot(sessionId, open && !disabled, dismiss);
  const response = state.response;
  const blocked = disabled || state.pending || state.revoked;
  const fullSupported =
    response?.snapshot?.binding.engine === 'claude' &&
    response.snapshot.binding.placement === 'local' &&
    response.reason !== 'refresh_unsupported';
  return (
    <>
      <button
        type="button"
        className="home-secondary"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          // Safari pointer activation need not focus a button. HomeDialog owns
          // restoration, so establish its real opener before mounting it.
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        Inspect context
      </button>
      {open && !disabled && (
        <HomeDialog
          title="Context snapshot"
          open={open && !disabled}
          onClose={dismiss}
          className="context-snapshot-dialog"
        >
          <p>Recorded native context evidence. Opening this view only reads the saved snapshot.</p>
          <div ref={result} tabIndex={-1} className="context-snapshot-result">
            {state.pending && <p role="status">Loading context snapshot…</p>}
            {state.error && <p role="alert">{state.error}</p>}
            {response && (
              <>
                <p role={response.status === 'failed' ? 'alert' : 'status'}>
                  Snapshot {response.status}
                </p>
                {response.reason && (
                  <>
                    <p>{reasons[response.reason]}</p>
                    <small className="context-snapshot-note">Reason: {response.reason}</small>
                  </>
                )}
                {response.snapshot ? (
                  <ContextSnapshotFacts
                    key={`${response.revision}:${response.snapshot.observedAt}`}
                    snapshot={response.snapshot}
                  />
                ) : (
                  <p>Occupancy unknown. Capacity unknown.</p>
                )}
              </>
            )}
          </div>
          <div className="context-snapshot-actions">
            <button
              type="button"
              className="home-secondary"
              disabled={blocked}
              onClick={() => {
                setFull(false);
                setConsent(false);
                void state.request();
              }}
            >
              Read saved snapshot
            </button>
            <button
              type="button"
              className="home-secondary"
              disabled={blocked}
              onClick={() => {
                setFull(false);
                setConsent(false);
                void state.request('summary');
              }}
            >
              Refresh summary
            </button>
            {fullSupported && (
              <button
                type="button"
                className="home-secondary"
                disabled={blocked}
                aria-expanded={full}
                aria-controls={consentId}
                onClick={() => {
                  setFull((value) => !value);
                  setConsent(false);
                }}
              >
                Full detail…
              </button>
            )}
          </div>
          <p className="context-snapshot-note">
            Summary explicitly asks the attached runtime for current evidence. There is no automatic
            refresh or polling.
          </p>
          <MotionPresence open={full && !blocked} kind="disclosure">
            <section id={consentId} aria-label="Full inspection consent">
              <p>
                Full detail can make token-count API calls, with network overhead and possible
                charges. It does not start a model turn. Cancellation may not stop work already
                dispatched.
              </p>
              <label className="context-snapshot-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                Allow token-count API calls and their network overhead for this one inspection.
              </label>
              <button
                type="button"
                className="home-secondary"
                disabled={!consent || blocked}
                onClick={() => {
                  if (!consent) return;
                  result.current?.focus({ preventScroll: true });
                  setFull(false);
                  setConsent(false);
                  void state.request('full');
                }}
              >
                Refresh full detail
              </button>
            </section>
          </MotionPresence>
        </HomeDialog>
      )}
    </>
  );
}
