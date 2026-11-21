import { useEffect, useRef, useState } from 'react';
import type { usePrMonitor } from '../hooks/usePrMonitor';
import type { ManagedConnection } from '../types/connections';
import { getConnections } from '../lib/connections-api';
import { MotionPresence } from './MotionPresence';
import { prMonitorRecovery, type PrRegistrationRequest } from '../lib/pr-monitor-recovery';

export function PrMonitorRegistration({
  monitor: m,
}: {
  monitor: ReturnType<typeof usePrMonitor>;
}) {
  const [recovery] = useState(() => prMonitorRecovery(m.sessionId));
  const [open, setOpen] = useState(!!recovery.registration);
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [connectionId, setConnectionId] = useState(recovery.registration?.connectionId ?? '');
  const [url, setUrl] = useState(
    recovery.registration
      ? `https://github.com/${recovery.registration.owner}/${recovery.registration.name}/pull/${recovery.registration.pr}`
      : '',
  );
  const [passphrase, setPassphrase] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<PrRegistrationRequest | null>(
    recovery.registration ?? null,
  );
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const available =
    !!m.data?.executionAvailable && !!m.data.executionDigest && !m.stale && !m.error && !m.busy;
  async function show() {
    setOpen(true);
    const turn = ++generation.current;
    try {
      const result = await getConnections();
      if (turn !== generation.current) return;
      const eligible = result.connections.filter(
        (c) => c.templateId === 'github-readonly' && c.status === 'active',
      );
      setConnections(eligible);
      if (!eligible.length)
        setNotice('No active read-only GitHub connection. Configure one in Connections.');
    } catch {
      if (turn === generation.current)
        setNotice('Connections could not be loaded. Close and reopen Add PR to retry.');
    }
  }
  async function register() {
    if ((!available && !pending) || m.busy || !passphrase) return;
    const wasPending = !!pending;
    let input = pending;
    if (!input) {
      const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(
        url.trim(),
      );
      const connection = connections.find((c) => c.id === connectionId);
      if (
        !match ||
        !connection ||
        !Number.isSafeInteger(Number(match[3])) ||
        !m.data?.executionDigest
      ) {
        setNotice(
          'Choose a connection and a canonical https://github.com/owner/repository/pull/number URL.',
        );
        return;
      }
      input = {
        requestId: crypto.randomUUID(),
        connectionId,
        connectionRevision: connection.revision,
        owner: match[1],
        name: match[2],
        pr: Number(match[3]),
        expectedExecutionDigest: m.data.executionDigest,
      };
      setPending(input);
    }
    recovery.registration = input;
    const secret = passphrase;
    setPassphrase('');
    const outcome = await m.change('/pr-monitor', input, secret);
    setNotice(
      outcome === 'confirmed'
        ? 'PR registered paused. Review Watch separately to allow background reads.'
        : outcome === 'not_sent'
          ? 'Registration was not sent. Reauthorize and try again.'
          : `Registration was not confirmed. Refresh status and retry this same request (${input.requestId}) if needed.`,
    );
    if (outcome === 'not_sent' && !wasPending) {
      setPending(null);
      delete recovery.registration;
    }
    if (outcome === 'confirmed') {
      delete recovery.registration;
      setPending(null);
      setOpen(false);
      setUrl('');
    }
  }
  return (
    <div className="pr-monitor-registration">
      <div className="pr-monitor-actions">
        <button type="button" disabled={!available || !!pending} onClick={() => void show()}>
          Add PR
        </button>
      </div>
      <MotionPresence open={open} kind="disclosure">
        <div className="pr-monitor-review">
          <p>
            Register a PR using the selected read-only GitHub connection. This verifies the PR and
            saves it paused; Watch requires separate consent.
          </p>
          <label>
            GitHub connection
            <select
              value={connectionId}
              disabled={!!pending || m.busy}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              <option value="">Choose a connection</option>
              {pending && !connections.some((c) => c.id === pending.connectionId) && (
                <option value={pending.connectionId}>
                  Retained connection {pending.connectionId}
                </option>
              )}
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pull request URL
            <input
              type="url"
              value={url}
              disabled={!!pending || m.busy}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repository/pull/123"
            />
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
              disabled={
                m.busy || !passphrase || (!pending && (!available || !connectionId || !url))
              }
              onClick={() => void register()}
            >
              {pending ? 'Retry same registration' : 'Register paused PR'}
            </button>
            <button
              type="button"
              disabled={m.busy || !!pending}
              onClick={() => {
                setOpen(false);
                setPassphrase('');
                generation.current++;
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </MotionPresence>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
