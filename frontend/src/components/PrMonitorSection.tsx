import { useId, useState } from 'react';
import type { PrMonitorProjection } from '@mitzo/protocol';
import { usePrMonitor } from '../hooks/usePrMonitor';
import { MotionDetails } from './MotionDetails';
import { MotionPresence } from './MotionPresence';
import { PrMonitorRegistration } from './PrMonitorRegistration';
import { prMonitorRecovery, type PrWatchRequest } from '../lib/pr-monitor-recovery';
import '../styles/pr-monitor.css';

type Monitor = ReturnType<typeof usePrMonitor>;
const time = (value: number | null) =>
  value === null ? 'Not yet recorded' : new Date(value).toLocaleString();
const diagnostics = {
  rate_limited: 'GitHub rate limit reached.',
  read_failed: 'GitHub could not be read.',
  authority_unavailable: 'Watch authority is unavailable or expired.',
  connection_unavailable: 'Connection access is unavailable.',
  conversation_unavailable: 'Conversation access is unavailable.',
  head_changed: 'The PR head changed during refresh.',
  incomplete: 'Evidence is incomplete.',
  retention_limit: 'Retained activity reached its limit. Watch is paused.',
  quota_delayed: 'Refresh is waiting for its GitHub quota.',
};

function PrMonitorRow({
  projection: p,
  monitor: m,
}: {
  projection: PrMonitorProjection;
  monitor: Monitor;
}) {
  const s = p.subscription;
  const [recovery] = useState(() => prMonitorRecovery(m.sessionId));
  const [pendingIssue, setPendingIssue] = useState<PrWatchRequest | null>(
    recovery.watch.get(s.id) ?? null,
  );
  const [review, setReview] = useState(!!pendingIssue);
  const [reviewedBinding, setReviewedBinding] = useState('');
  const [duration, setDuration] = useState(pendingIssue?.durationMinutes ?? 60);
  const [passphrase, setPassphrase] = useState('');
  const [notice, setNotice] = useState('');
  const [revoke, setRevoke] = useState<PrMonitorProjection['revocationPending']>(
    recovery.revoke.get(s.id) ?? null,
  );
  const reasonId = useId();
  const scope = s.github.principalId
    ? {
        connectionId: s.github.connectionId,
        connectionRevision: s.github.identityRevision,
        githubPrincipalId: s.github.principalId,
        repositoryId: s.github.repositoryId,
        prNodeId: s.github.prNodeId,
      }
    : null;
  const canIssue =
    !!scope &&
    !!m.data?.executionAvailable &&
    !m.stale &&
    !m.error &&
    !m.busy &&
    !p.revocationPending &&
    s.lifecycle !== 'merged' &&
    s.lifecycle !== 'removed';
  const binding = JSON.stringify([
    scope,
    s.revision,
    s.watch?.revision ?? 0,
    m.data?.executionDigest,
  ]);
  const reviewChanged = reviewedBinding !== binding;
  const pending = p.revocationPending ?? revoke;
  const expired = s.watch !== null && s.watch.expiresAt <= m.now;
  const watchLabel = p.revocationPending
    ? 'Stop pending · Watch paused'
    : p.watchRevokedAt != null
      ? `Revoked · ${time(p.watchRevokedAt)}`
      : !s.watch
        ? 'Off'
        : expired
          ? 'Expired'
          : `${s.lifecycle} · expires ${time(s.watch.expiresAt)}`;
  const staleEvidence =
    m.stale ||
    !!m.error ||
    p.refreshState !== 'current' ||
    !p.snapshot?.complete ||
    (s.nextRefreshAt !== null && s.nextRefreshAt < m.now);

  async function issue() {
    if (!canIssue || (!pendingIssue && reviewChanged) || !scope || !passphrase) return;
    const secret = passphrase;
    setPassphrase('');
    const request = pendingIssue ?? {
      requestId: crypto.randomUUID(),
      expectedRevision: s.revision,
      expectedAuthorityRevision: s.watch?.revision ?? 0,
      durationMinutes: duration,
      reviewedScope: scope,
    };
    recovery.watch.set(s.id, request);
    setPendingIssue(request);
    const outcome = await m.change(`/pr-watch/${s.id}`, request, secret);
    setNotice(
      outcome === 'confirmed'
        ? 'Watch consent saved. Status below is the retained observation.'
        : outcome === 'not_sent'
          ? 'Watch was not changed. Reauthorize and try again.'
          : `Watch change was not confirmed. Request ${request.requestId}. Refresh status, then retry the same request if needed.`,
    );
    if (outcome === 'confirmed' || (outcome === 'not_sent' && !pendingIssue)) {
      recovery.watch.delete(s.id);
      setPendingIssue(null);
    }
    if (outcome === 'confirmed') setReview(false);
  }
  async function stop() {
    if (m.busy) return;
    const request = pending ?? {
      requestId: crypto.randomUUID(),
      expectedRevision: s.revision,
      expectedAuthorityRevision: s.watch?.revision ?? 0,
    };
    setRevoke(request);
    recovery.revoke.set(s.id, request);
    const ok = (await m.change(`/pr-watch/${s.id}/revoke`, request)) === 'confirmed';
    setNotice(
      ok
        ? 'Watch stopped.'
        : `Stop Watch was not confirmed. Refresh and retry the same request (${request.requestId}).`,
    );
    if (ok) {
      setRevoke(null);
      recovery.revoke.delete(s.id);
    }
  }
  return (
    <li className="pr-monitor-row">
      <a
        className="pr-monitor-link"
        href={`https://github.com/${s.github.owner}/${s.github.name}/pull/${s.github.pr}`}
        target="_blank"
        rel="noreferrer"
      >
        {s.github.owner}/{s.github.name} #{s.github.pr}
      </a>
      <p>{p.snapshot?.title ?? 'Waiting for first observation'}</p>
      <p className={staleEvidence ? 'pr-monitor-warning' : undefined}>
        {staleEvidence ? 'Retained evidence · may be stale' : 'Last observed evidence'} ·{' '}
        {p.refreshState.replaceAll('_', ' ')}
      </p>
      {p.diagnostic && (
        <p role="status" className="pr-monitor-warning">
          {diagnostics[p.diagnostic.code]}
        </p>
      )}
      <dl className="pr-monitor-facts">
        <dt>Observed head</dt>
        <dd>
          <code>{s.head?.sha ?? 'Not yet observed'}</code>
        </dd>
        <dt>PR state</dt>
        <dd>
          {p.snapshot?.state ?? 'Unknown'}
          {p.snapshot && (
            <>
              {' '}
              · <span>CI: {p.snapshot.ci}</span> · <span>Review: {p.snapshot.review}</span>
            </>
          )}
        </dd>
        <dt>Last successful refresh</dt>
        <dd>{time(s.lastSuccessfulRefreshAt)}</dd>
        <dt>Next refresh</dt>
        <dd>{time(s.nextRefreshAt)}</dd>
        <dt>Watch</dt>
        <dd>{watchLabel}</dd>
      </dl>
      <div className="pr-monitor-actions">
        <button
          type="button"
          disabled={!canIssue || !!pendingIssue}
          aria-describedby={reasonId}
          onClick={() => {
            setReviewedBinding(binding);
            setReview(!review);
            setPassphrase('');
          }}
        >
          {s.watch ? 'Review Watch renewal' : 'Review Watch'}
        </button>
        {((s.watch && p.watchRevokedAt == null) || pending) && (
          <button type="button" disabled={m.busy} onClick={() => void stop()}>
            {pending ? 'Retry stop Watch' : 'Stop Watch'}
          </button>
        )}
        <button type="button" disabled aria-describedby={reasonId}>
          Auto-fix
        </button>
        <button type="button" disabled aria-describedby={reasonId}>
          Merge when ready
        </button>
      </div>
      <p id={reasonId} className="pr-monitor-muted">
        Auto-fix is unavailable: no delivery owner is connected. Merge when ready is unavailable: no
        landing authorization owner is connected. Watch only reads GitHub; it does not start an
        agent or authorize merging.
      </p>
      {!scope && (
        <p>
          Watch renewal is unavailable: this retained registration has no verified GitHub principal.
        </p>
      )}
      {s.lifecycle === 'closed' && (
        <p>Closed PRs require explicit renewed Watch to detect reopening.</p>
      )}
      {(s.lifecycle === 'merged' || s.lifecycle === 'removed') && (
        <p>Watch renewal is unavailable for a {s.lifecycle} subscription.</p>
      )}
      <MotionPresence open={review} kind="disclosure">
        <div className="pr-monitor-review">
          {reviewChanged && !pendingIssue && (
            <p role="status">Access changed since this review. Cancel and review Watch again.</p>
          )}
          {pendingIssue && (
            <p>
              Retry only the original request {pendingIssue.requestId}, for GitHub principal{' '}
              {pendingIssue.reviewedScope.githubPrincipalId}, connection{' '}
              {pendingIssue.reviewedScope.connectionId} revision{' '}
              {pendingIssue.reviewedScope.connectionRevision}. No new consent is inferred from
              reconnect.
            </p>
          )}
          <p>
            Allow background GitHub reads for {s.github.owner}/{s.github.name} #{s.github.pr} in
            this conversation, including while the browser is closed. Consent expires with the
            selected duration or your login, whichever is earlier.
          </p>
          <p>
            GitHub principal {s.github.principalId} · connection revision{' '}
            {s.github.identityRevision} · account {s.execution.binding.account.accountId} ·{' '}
            {s.execution.binding.harness.implementation} / {s.execution.binding.execution.location}
          </p>
          <label>
            Watch duration
            <select
              aria-label="Watch duration"
              value={duration}
              disabled={!!pendingIssue}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
              <option value={480}>8 hours</option>
            </select>
          </label>
          <label>
            App passphrase
            <input
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <div className="pr-monitor-actions">
            <button
              type="button"
              disabled={!canIssue || (!pendingIssue && reviewChanged) || !passphrase}
              onClick={() => void issue()}
            >
              {pendingIssue ? 'Retry same Watch request' : 'Allow read-only Watch'}
            </button>
            <button
              type="button"
              disabled={m.busy || !!pendingIssue}
              onClick={() => {
                setReview(false);
                setPassphrase('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </MotionPresence>
      {notice && <p role="status">{notice}</p>}
      <MotionDetails summary={`Activity and runtime details (${p.events.length})`}>
        <p>
          Last attempt: {time(s.lastAttemptAt)}. {p.counters.observations} observations;{' '}
          {p.counters.distinctEvents} distinct events. {p.hiddenEvents} hidden; {p.compactedEvents}{' '}
          compacted.
        </p>
        <p>
          Runtime: {s.execution.binding.harness.implementation} /{' '}
          {s.execution.binding.execution.location}. Delivery unavailable; observation outbox is not
          a delivery receipt. Retained Auto-fix authority:{' '}
          {s.autoFix
            ? s.autoFix.expiresAt <= m.now
              ? 'expired'
              : 'recorded, not actionable here'
            : 'none'}
          . Merge authority:{' '}
          {s.merge ? 'recorded for its exact head; no action owner connected' : 'none'}.
        </p>
        {p.events.length === 0 && <p>No retained activity.</p>}
        <ul className="pr-monitor-events">
          {p.events.map((e) => (
            <li key={e.id}>
              <p>
                {e.summary} · {e.disposition.replaceAll('_', ' ')}
                {e.truncated ? ' · truncated' : ''}
              </p>
              <p>
                {time(e.observedAt)} · <code>{e.headSha}</code>
              </p>
              {e.references.map((r) => (
                <a key={`${r.kind}:${r.id}`} href={r.url} target="_blank" rel="noreferrer">
                  {r.kind} {r.id}
                </a>
              ))}
            </li>
          ))}
        </ul>
      </MotionDetails>
    </li>
  );
}

function MonitorContent({ sessionId }: { sessionId: string }) {
  const monitor = usePrMonitor(sessionId);
  return (
    <section className="pr-monitor" aria-label="Pull request monitoring">
      <h3>Pull requests</h3>
      <div className="pr-monitor-actions">
        <button type="button" disabled={monitor.busy} onClick={() => void monitor.refresh()}>
          Refresh PR status
        </button>
      </div>
      {monitor.busy && <p role="status">Checking PR status…</p>}
      {monitor.error && (
        <p role="alert" className="pr-monitor-warning">
          {monitor.error}
        </p>
      )}
      {monitor.data && !monitor.data.executionAvailable && (
        <p role="status">
          Execution is unavailable. Retained status and Stop Watch remain available; new Watch
          consent requires current account and conversation access.
        </p>
      )}
      {monitor.stale && monitor.data && (
        <p role="status">
          Refresh PR status before granting Watch. This browser’s status check is stale.
        </p>
      )}
      {monitor.data?.subscriptions.length === 0 && (
        <p>No PRs are registered for this conversation.</p>
      )}
      <ul className="pr-monitor-list">
        {monitor.data?.subscriptions.map((p) => (
          <PrMonitorRow key={p.subscription.id} projection={p} monitor={monitor} />
        ))}
      </ul>
      {monitor.data && <PrMonitorRegistration monitor={monitor} />}
    </section>
  );
}
export function PrMonitorSection({ sessionId }: { sessionId: string }) {
  return <MonitorContent key={sessionId} sessionId={sessionId} />;
}
