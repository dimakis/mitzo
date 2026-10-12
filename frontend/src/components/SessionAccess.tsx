import { useEffect, useState } from 'react';
import type { SessionAccessEvidence } from '../../../server/session-access';
import type { AccountSelection } from '../types/account-selection';
import type { ConnectionsAccessInventory } from '../types/connections-access';
import { apiFetch } from '../lib/api-fetch';
import { getConnectionsAccess } from '../lib/connections-access-api';
import { connectionTitle, connectionStatus } from '../lib/connections-access-presentation';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import '../styles/session-access.css';

interface Props {
  sessionId?: string;
  selection?: Pick<AccountSelection, 'accountId' | 'model'> | null;
  connected?: boolean;
  onShowApproval?: () => void;
}
function AccessContent({ sessionId, selection, connected = true, onShowApproval }: Props) {
  const [evidence, setEvidence] = useState<SessionAccessEvidence | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [connections, setConnections] = useState(false);
  const [inventory, setInventory] = useState<ConnectionsAccessInventory | null>(null);
  const [inventoryError, setInventoryError] = useState(false);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      controller.abort();
      if (active) {
        setError(true);
        setLoading(false);
      }
    }, 15000);
    void apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/access`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unavailable');
        const value = (await response.json()) as SessionAccessEvidence;
        if (value.sessionId !== sessionId) throw new Error('Session mismatch');
        if (active && !controller.signal.aborted) {
          setEvidence(value);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [sessionId, attempt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!connections) return;
    const controller = new AbortController();
    setInventoryError(false);
    void getConnectionsAccess(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setInventory(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setInventoryError(true);
      });
    return () => controller.abort();
  }, [connections]);
  const stale = Boolean(evidence && (error || !connected || now - evidence.observedAt > 30000));
  const current = evidence?.state === 'current' && !stale && !loading;
  const codex = evidence?.runtime?.harness === 'codex';
  if (connections)
    return (
      <div className="session-access">
        <button className="home-secondary" onClick={() => setConnections(false)}>
          Back to Access
        </button>
        <h3>Connections</h3>
        <p className="workspace-muted">
          Configured account and service access. Current session attachments are unknown.
        </p>
        {inventoryError && (
          <p role="alert">Connections could not be checked. Return to Access and retry.</p>
        )}
        {!inventory && !inventoryError && <p role="status">Loading Connections…</p>}
        {inventory && (
          <>
            <p className="workspace-muted">
              Observed {new Date(inventory.generatedAt).toLocaleTimeString()}
            </p>
            <div className="access-row-group">
              {inventory.resources
                .filter(
                  (r) =>
                    r.owner !== 'symposium-account-profiles' && r.kind !== 'personal-connection',
                )
                .map((resource) => (
                  <details key={resource.id} className="session-access-connection">
                    <summary>
                      <span>{connectionTitle(resource, inventory.resources)}</span>
                      <span className="workspace-muted">{connectionStatus(resource)}</span>
                    </summary>
                    <p>{resource.access.summary}</p>
                    <p className="workspace-muted">{resource.verification.reason}</p>
                    <p className="workspace-muted">{resource.access.appliesTo}</p>
                  </details>
                ))}
            </div>
            {!inventory.resources.length && <p>No configured connections reported.</p>}
            {inventory.sources
              .filter((source) => source.state === 'unavailable')
              .map((source) => (
                <p role="status" key={source.id}>
                  {source.id}: unavailable — {source.reason}
                </p>
              ))}
          </>
        )}
      </div>
    );
  return (
    <div className="session-access">
      <p className="workspace-muted">
        Read-only evidence for this conversation. Account configuration does not establish session
        availability.
      </p>
      {!sessionId && (
        <p>No session has started. The selected account has not been used in this conversation.</p>
      )}
      {loading && <p role="status">Checking Access…</p>}
      {sessionId && !loading && (
        <p role="status">
          {stale
            ? error
              ? 'Stale — refresh failed. Showing the earlier observation.'
              : 'Stale — reconnect or refresh Access.'
            : evidence?.state === 'current'
              ? 'Current session observation'
              : 'Unknown — live evidence is unavailable for this route.'}
        </p>
      )}
      {evidence && (
        <p className="workspace-muted">
          Observed {new Date(evidence.observedAt).toLocaleTimeString()}
        </p>
      )}
      <section className="access-detail-card">
        <h3>{sessionId ? 'Session access' : 'Selected route'}</h3>
        <dl className="access-resource-facts">
          <div>
            <dt>Account</dt>
            <dd>
              {evidence?.account?.accountLabel ??
                (!sessionId ? selection?.accountId : null) ??
                'Unknown'}
              {codex && (
                <p className="workspace-muted">
                  Bound to this runtime; authorization is rechecked before dispatch.
                </p>
              )}
            </dd>
          </div>
          <div>
            <dt>
              {codex
                ? evidence?.modelSource === 'accepted-turn'
                  ? 'Last acknowledged model'
                  : 'Verified thread model'
                : 'Model'}
            </dt>
            <dd>{evidence?.model ?? (!sessionId ? selection?.model : null) ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt>{codex ? 'Mitzo effective mode' : 'Effective mode'}</dt>
            <dd>{evidence?.mode ?? 'Unknown'}</dd>
          </div>
          {evidence?.runtime && (
            <>
              <div>
                <dt>Harness</dt>
                <dd>{codex ? 'Codex' : 'Claude SDK'}</dd>
              </div>
              <div>
                <dt>Execution location</dt>
                <dd>
                  {evidence.runtime.location === 'openshell' ? 'OpenShell sandbox' : 'Local host'}
                </dd>
              </div>
            </>
          )}
          <div>
            <dt>Service attachments</dt>
            <dd>Unknown — configured services have not been observed in this session.</dd>
          </div>
          <div>
            <dt>{codex ? 'Mitzo host tool approvals' : 'Tool approvals'}</dt>
            <dd>
              {evidence?.grants
                ? evidence.grants.join(', ') ||
                  (codex ? 'No Mitzo host tool grants' : 'No session tool grants')
                : 'Unknown'}
              <p className="workspace-muted">
                Skill, workspace and exact-action restrictions still apply.
              </p>
            </dd>
          </div>
          <div>
            <dt>Skill restriction</dt>
            <dd>
              {codex ? (
                <>
                  Restricted skill ceilings are unsupported on this Codex route.
                  <p className="workspace-muted">
                    Mitzo host restriction:{' '}
                    {evidence?.skillCeiling
                      ? evidence.skillCeiling.join(', ') || 'No Mitzo host tools permitted'
                      : 'None active'}
                  </p>
                </>
              ) : evidence?.state === 'current' ? (
                (evidence.skillCeiling?.join(', ') ?? 'No active skill ceiling')
              ) : (
                'Unknown'
              )}
            </dd>
          </div>
          {codex && (
            <div>
              <dt>Native Codex permissions</dt>
              <dd>Unknown — native permissions have not been reported here.</dd>
            </div>
          )}
          <div>
            <dt>Available tools</dt>
            <dd>Unknown — callable tools have not been inventoried for this route.</dd>
          </div>
          <div>
            <dt>Execution limits</dt>
            <dd>Unknown — runtime limits have not been reported here.</dd>
          </div>
        </dl>
      </section>
      <section className="access-detail-card">
        <h3>Pending approvals</h3>
        {evidence?.pending ? (
          evidence.pending.length ? (
            evidence.pending.map((p) => (
              <p key={p.permId}>
                {p.toolName} · {p.scope}
              </p>
            ))
          ) : (
            <p>No pending requests observed.</p>
          )
        ) : (
          <p>Unknown</p>
        )}
        {current && Boolean(evidence?.pending?.length) && onShowApproval && (
          <button className="home-secondary" onClick={onShowApproval}>
            View pending approvals
          </button>
        )}
      </section>
      <div className="access-resource-actions">
        {sessionId && (
          <button
            className="home-secondary"
            disabled={loading}
            onClick={() => {
              setNow(Date.now());
              setAttempt((value) => value + 1);
            }}
          >
            Refresh Access
          </button>
        )}
        <button className="home-secondary" onClick={() => setConnections(true)}>
          Connections
        </button>
      </div>
    </div>
  );
}
export function SessionAccess(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="home-secondary session-access-trigger"
        aria-label="Access"
        title="Session and account access"
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        <UiIcon name="connections" />
        <span className="session-access-label">Access</span>
      </button>
      {open && (
        <HomeDialog title="Access" onClose={() => setOpen(false)}>
          <AccessContent
            key={props.sessionId ?? 'empty'}
            {...props}
            onShowApproval={() => {
              setOpen(false);
              if (props.onShowApproval) props.onShowApproval();
              else
                requestAnimationFrame(() => {
                  const banner = document.querySelector<HTMLElement>('.perm-banner');
                  banner?.scrollIntoView({ block: 'center' });
                  banner?.querySelector<HTMLElement>('button, input')?.focus();
                });
            }}
          />
        </HomeDialog>
      )}
    </>
  );
}
