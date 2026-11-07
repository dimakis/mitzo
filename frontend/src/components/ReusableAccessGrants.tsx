import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SessionCapability,
  SessionCapabilityInventory,
} from '../../../server/session-capability-grants';
import { apiFetch, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { MotionPresence } from './MotionPresence';

const names = {
  development: 'Development networking',
  'github-read': 'GitHub repository reads',
  'public-web': 'Public websites',
};
function grantName(capability: SessionCapability) {
  return (
    names[capability.kind] + (capability.kind === 'github-read' ? `: ${capability.repository}` : '')
  );
}
function GrantControls({ sessionId, connected }: { sessionId: string; connected: boolean }) {
  const [data, setData] = useState<SessionCapabilityInventory | null>(null);
  const [selected, setSelected] = useState([sessionId]);
  const [kind, setKind] = useState<SessionCapability['kind']>('public-web');
  const [repository, setRepository] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const current = useRef<AbortController | null>(null);
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/access-grants`;
  const refresh = useCallback(async () => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    const timeout = setTimeout(() => {
      controller.abort();
      setBusy(false);
      setError('Access could not be checked. Refresh grants to try again.');
    }, 15000);
    try {
      const response = await apiFetch(path, { signal: controller.signal });
      if (!response.ok) throw Error('Unavailable');
      const inventory = (await response.json()) as SessionCapabilityInventory;
      if (controller.signal.aborted || current.current !== controller) return;
      if (
        inventory.sessionId !== sessionId ||
        !Array.isArray(inventory.grants) ||
        !Array.isArray(inventory.sessions)
      )
        throw Error('Invalid inventory');
      setData(inventory);
      setSelected([sessionId]);
      setError('');
      setNow(Date.now());
    } catch {
      if (!controller.signal.aborted && current.current === controller)
        setError('Live access for this login is unavailable. Reconnect and refresh grants.');
    } finally {
      clearTimeout(timeout);
      if (current.current === controller) setBusy(false);
    }
  }, [path, sessionId]);
  useEffect(() => {
    void refresh();
    const invalidate = () => {
      current.current?.abort();
      current.current = null;
      setData(null);
      setBusy(false);
      setNotice('');
      setSelected([sessionId]);
      setError('Authentication changed. Sign in and refresh grants before changing access.');
    };
    const timer = setInterval(() => setNow(Date.now()), 5000);
    window.addEventListener(AUTH_LOST_EVENT, invalidate);
    window.addEventListener(AUTH_RESTORED_EVENT, invalidate);
    return () => {
      current.current?.abort();
      current.current = null;
      clearInterval(timer);
      window.removeEventListener(AUTH_LOST_EVENT, invalidate);
      window.removeEventListener(AUTH_RESTORED_EVENT, invalidate);
    };
  }, [refresh, sessionId]);
  const stale = !data || now - data.observedAt > 30000;
  const eligible = data?.sessions.filter((s) => kind !== 'development' || s.development) ?? [];
  const canCreate =
    connected &&
    !busy &&
    !error &&
    !stale &&
    selected.every((id) => eligible.some((s) => s.sessionId === id)) &&
    (kind !== 'github-read' || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository));
  async function mutate(method: 'POST' | 'DELETE', grantId?: string) {
    if (!data || busy || error || !connected || Date.now() - data.observedAt > 30000) return;
    if (method === 'POST' && !canCreate) return;
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setNotice('');
    const uncertain =
      'Access may have changed. Refresh grants to check whether the request completed before trying again.';
    const timeout = setTimeout(() => {
      controller.abort();
      setBusy(false);
      setError(uncertain);
    }, 15000);
    try {
      const capability: SessionCapability =
        kind === 'github-read' ? { kind, repository } : { kind };
      const response = await apiFetch(grantId ? `${path}/${encodeURIComponent(grantId)}` : path, {
        method,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Mitzo-Access-Intent': 'manage-grants' },
        ...(method === 'POST'
          ? {
              body: JSON.stringify({
                sessionIds: selected,
                capability,
                durationMinutes: minutes,
                expectedContexts: Object.fromEntries(
                  data.sessions
                    .filter((s) => selected.includes(s.sessionId))
                    .map((s) => [s.sessionId, s.revision]),
                ),
              }),
            }
          : {}),
      });
      if (controller.signal.aborted || current.current !== controller) return;
      if (!response.ok) throw Error('Refused');
      clearTimeout(timeout);
      setNotice(
        method === 'POST'
          ? 'Access granted. Review its sessions and expiry below.'
          : 'Access revoked for every session in this grant.',
      );
      await refresh();
    } catch {
      if (!controller.signal.aborted && current.current === controller) setError(uncertain);
    } finally {
      clearTimeout(timeout);
      if (current.current === controller) setBusy(false);
    }
  }
  return (
    <div className="reusable-access">
      <p>
        Grants apply only to the selected conversations, accounts and workspaces until the displayed
        expiry. They end on account or workspace changes and server restart.
      </p>
      <p>
        Development networking adds no folders. Public websites covers credential-free public HTTPS
        reads; searches, private destinations and authenticated browsing keep their approvals.
        Publication, merge and deployment keep their own approvals.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Checking access…</p>}
      {!connected && <p role="status">Reconnect before changing access.</p>}
      {stale && data && (
        <p role="status">Observation expired. Refresh grants before changing access.</p>
      )}
      <button
        type="button"
        className="home-secondary"
        disabled={busy}
        onClick={() => void refresh()}
      >
        Refresh grants
      </button>
      {data && (
        <>
          <p>Automatic review unavailable. {data.automaticReview.reason}</p>
          <label>
            Access type
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as SessionCapability['kind']);
                setSelected([sessionId]);
              }}
            >
              <option value="public-web">Public websites</option>
              <option value="github-read">GitHub repository reads</option>
              <option value="development">Development networking (Local Codex)</option>
            </select>
          </label>
          {kind === 'github-read' && (
            <label>
              GitHub repository
              <input
                placeholder="owner/repository"
                value={repository}
                maxLength={200}
                onChange={(event) => setRepository(event.target.value)}
              />
            </label>
          )}
          <fieldset disabled={busy || stale || !connected}>
            <legend>Selected sessions</legend>
            {eligible.map((session) => (
              <label key={session.sessionId} className="reusable-access-session">
                <input
                  type="checkbox"
                  aria-label={session.title}
                  checked={selected.includes(session.sessionId)}
                  disabled={session.sessionId === sessionId}
                  onChange={(event) =>
                    setSelected((ids) =>
                      event.target.checked
                        ? [...ids, session.sessionId]
                        : ids.filter((id) => id !== session.sessionId),
                    )
                  }
                />
                <span>
                  {session.title}
                  {session.sessionId === sessionId ? ' (this conversation)' : ''}
                  <small>
                    {session.account} · {session.mode}
                    <br />
                    {session.cwd}
                  </small>
                </span>
              </label>
            ))}
            {!eligible.some((s) => s.sessionId === sessionId) && (
              <p>This conversation cannot use the selected access type.</p>
            )}
          </fieldset>
          <label>
            Expires after
            <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
              <option value={15}>15 minutes</option>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
              <option value={480}>8 hours</option>
            </select>
          </label>
          <button
            type="button"
            className="home-primary"
            disabled={!canCreate}
            onClick={() => void mutate('POST')}
          >
            Grant access
          </button>
          <h4>Active grants</h4>
          {!data.grants.length && <p>No active reusable grants.</p>}
          {data.grants.map((grant) => (
            <div className="reusable-access-grant" key={grant.id}>
              <strong>{grantName(grant.capability)}</strong>
              <p>
                {grant.sessionIds
                  .map((id) => data.sessions.find((s) => s.sessionId === id)?.title ?? id)
                  .join(', ')}
              </p>
              <p>
                {grant.expiresAt <= now ? 'Expired' : 'Expires'}{' '}
                {new Date(grant.expiresAt).toLocaleString()}
              </p>
              <button
                type="button"
                className="home-secondary home-danger"
                disabled={busy || stale || !!error || !connected || grant.expiresAt <= now}
                aria-label={`Revoke ${grantName(grant.capability)}`}
                onClick={() => void mutate('DELETE', grant.id)}
              >
                Revoke access
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
export function ReusableAccessGrants(props: { sessionId: string; connected: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="access-detail-card">
      <h3>Reusable access</h3>
      <p className="workspace-muted">
        Allow public websites, GitHub reads or development networking for selected chats. Choose an
        expiry and revoke access at any time.
      </p>
      <button
        type="button"
        className="home-secondary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide reusable access' : 'Manage reusable access'}
      </button>
      <MotionPresence open={open} kind="disclosure">
        <GrantControls key={props.sessionId} {...props} />
      </MotionPresence>
    </section>
  );
}
