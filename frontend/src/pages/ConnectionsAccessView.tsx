import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { getConnectionsAccess } from '../lib/connections-access-api';
import { connectionsAccessCards } from '../lib/connections-access-presentation';
import type { AccessResource, ConnectionsAccessInventory } from '../types/connections-access';

const sourceLabels: Record<ConnectionsAccessInventory['sources'][number]['id'], string> = {
  accounts: 'AI accounts',
  symposiumAccounts: 'Symposium AI accounts',
  managed: 'Managed services',
  personal: 'Personal accounts',
  google: 'Google Workspace',
  legacy: 'Operator-managed services',
};
const verificationLabels = {
  verified: 'Verified',
  stale: 'Verification is stale',
  unverified: 'Not verified',
  unavailable: 'Verification unavailable',
};
function readableStatus(status: string) {
  const text = status.replace(/[_-]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function ResourceCard({
  resource,
  catalog,
}: {
  resource: AccessResource;
  catalog?: AccessResource;
}) {
  return (
    <article className="access-resource" aria-label={resource.label}>
      <header className="access-resource-heading">
        <h3>{resource.label}</h3>
        <span className="workspace-muted">{resource.provider}</span>
      </header>
      {resource.kind === 'ai-account' &&
        (resource.owner === 'account-profiles' ||
          resource.owner === 'symposium-account-profiles') && (
          <p className="workspace-muted">
            {resource.owner === 'symposium-account-profiles' ? 'Symposium' : 'Ordinary chats'}
          </p>
        )}
      <dl className="access-resource-facts">
        <div>
          <dt>Account</dt>
          <dd>{resource.accountIdentity ?? 'Identity not reported'}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>{resource.access.summary}</dd>
        </div>
        <div>
          <dt>Applies to</dt>
          <dd>{resource.access.appliesTo}</dd>
        </div>
        <div>
          <dt>Configured assignments</dt>
          <dd>
            {resource.access.desiredAccountIds.length
              ? resource.access.desiredAccountIds.join(', ')
              : 'No account assignments reported'}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{readableStatus(resource.status)}</dd>
        </div>
        <div>
          <dt>Last verified</dt>
          <dd>
            {verificationLabels[resource.verification.state]}
            {resource.verification.verifiedAt !== null && (
              <> · {new Date(resource.verification.verifiedAt).toLocaleString()}</>
            )}
            {resource.verification.reason && (
              <p className="workspace-muted">{resource.verification.reason}</p>
            )}
          </dd>
        </div>
      </dl>
      {catalog && (
        <>
          <dl className="access-resource-facts">
            <div>
              <dt>Configured models</dt>
              <dd>
                {catalog.details.models?.map((model) => model.label).join(', ') || 'None reported'}
              </dd>
            </div>
          </dl>
          <p className="workspace-muted">
            Configured catalog; model support and effective access have not been checked.
          </p>
        </>
      )}
      {resource.personalConnection && resource.personalConnection.state !== 'current' && (
        <p className="workspace-muted">
          {resource.personalConnection.state === 'stale'
            ? 'The personal account link is out of date. Refresh access to compare current details.'
            : 'Personal account details could not be checked. This catalog is shown separately.'}
        </p>
      )}
      <p className="workspace-muted">
        Conversation attachments have not been observed. Configuration and past verification do not
        establish current conversation access.
      </p>
      <div className="access-resource-actions" aria-label={`Actions for ${resource.label}`}>
        <span className="workspace-muted">Actions</span>
        {resource.actions.map((action) => (
          <Link key={action.id} className="workspace-text-link" to={action.href}>
            {action.label}
          </Link>
        ))}
        {!resource.actions.length && <span>No management action available</span>}
      </div>
      <details className="access-resource-details">
        <summary>Technical details</summary>
        <dl className="access-resource-facts">
          <div>
            <dt>Management owner</dt>
            <dd>{resource.owner}</dd>
          </div>
          <div>
            <dt>Gateway</dt>
            <dd>{resource.gateway ?? 'Not reported'}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{resource.workspace ?? 'Not reported'}</dd>
          </div>
          <div>
            <dt>Resource ID</dt>
            <dd>{resource.nativeId}</dd>
          </div>
          {catalog && (
            <div>
              <dt>Catalog resource</dt>
              <dd>{catalog.id}</dd>
              <dt>Catalog management owner</dt>
              <dd>{catalog.owner}</dd>
            </div>
          )}
          {resource.details.billing && (
            <div>
              <dt>Billing route</dt>
              <dd>{resource.details.billing}</dd>
            </div>
          )}
          {!catalog && resource.details.models && (
            <div>
              <dt>Configured models</dt>
              <dd>
                {resource.details.models.map((model) => model.label).join(', ') || 'None reported'}
                <p className="workspace-muted">
                  Configured catalog; model support and effective access have not been checked.
                </p>
              </dd>
            </div>
          )}
          {resource.details.endpoint && (
            <div>
              <dt>Endpoint</dt>
              <dd>{resource.details.endpoint}</dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  );
}
export function ConnectionsAccessView() {
  const [inventory, setInventory] = useState<ConnectionsAccessInventory | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  function refresh() {
    setLoading(true);
    if (!inventory) setError(false);
    setAttempt((value) => value + 1);
  }
  useEffect(() => {
    const controller = new AbortController();
    getConnectionsAccess(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setInventory(result);
          setError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <main className="workspace-page connections-access-page">
      <WorkspacePageHeading
        title="Connections & access"
        description="Your configured accounts and services, their verification, and where access applies."
      />
      <Link className="workspace-text-link" to="/connections">
        Manage connections
      </Link>
      <p className="workspace-muted">
        Choose AI accounts and models inside a chat. Changes are made through each service's
        existing management controls.
      </p>
      {error ? (
        <div role="alert" className="access-source-notice">
          <p>
            {inventory
              ? 'Showing older results. Current access could not be refreshed.'
              : 'Connections & access could not be loaded.'}
          </p>
          <button className="workspace-text-link" disabled={loading} onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}
      {loading && (
        <p role="status">{inventory ? 'Refreshing access…' : 'Loading connections & access…'}</p>
      )}
      {inventory && (
        <button className="workspace-text-link" disabled={loading} onClick={refresh}>
          Refresh access
        </button>
      )}
      {inventory && (
        <>
          {inventory.sources
            .filter((source) => source.state !== 'available')
            .map((source) => (
              <div
                key={source.id}
                className="access-source-notice"
                role={source.state === 'unavailable' ? 'status' : undefined}
              >
                <strong>
                  {sourceLabels[source.id]}:{' '}
                  {source.state === 'unavailable' ? 'Source unavailable' : 'Not configured'}
                </strong>
                {source.reason && <p>{source.reason}</p>}
              </div>
            ))}
          {(['accounts', 'services'] as const).map((section) => {
            const resources = connectionsAccessCards(inventory).filter(
              ({ resource }) => resource.section === section,
            );
            const label = section === 'accounts' ? 'AI accounts' : 'Services';
            return (
              <section key={section} className="today-section" aria-label={label}>
                <h2>{label}</h2>
                {resources.map(({ resource, catalog }) => (
                  <ResourceCard key={resource.id} resource={resource} catalog={catalog} />
                ))}
                {!resources.length && (
                  <p className="workspace-muted">
                    No {section === 'accounts' ? 'AI accounts' : 'services'} were reported by
                    available sources.
                  </p>
                )}
              </section>
            );
          })}
        </>
      )}
      <section className="today-section" aria-label="Web access">
        <h2>Web access</h2>
        <div className="access-web-explanation">
          <h3>Provider-hosted search</h3>
          <p>
            Search is handled by the selected AI provider. A search approval applies to that request
            and does not grant sandbox network access.
          </p>
        </div>
        <div className="access-web-explanation">
          <h3>Public website reads</h3>
          <p>
            One approved website read covers the requested public page. It does not grant ongoing
            website access.
          </p>
        </div>
        <div className="access-web-explanation">
          <h3>Sandbox website policies</h3>
          <p>
            Persistent sandbox website access is a separate network policy. This overview does not
            report its effective state for a conversation.
          </p>
        </div>
      </section>
    </main>
  );
}
