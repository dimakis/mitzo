import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { ConnectionsModeDetails } from '../components/ConnectionsModeDetails';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { getConnectionsAccess } from '../lib/connections-access-api';
import {
  accountCheckLabel,
  accountSignInIdentity,
  accountSignInLabel,
  hasAccountSignIn,
  expireAccountSignIns,
  connectionsAccessCards,
  retainUnavailableAccounts,
  accountResourceSource,
  connectionTitle,
  connectionStatus,
  serviceIdentity,
  serviceScope,
} from '../lib/connections-access-presentation';
import type { AccessResource, ConnectionsAccessInventory } from '../types/connections-access';

const sourceLabels: Record<ConnectionsAccessInventory['sources'][number]['id'], string> = {
  accounts: 'AI accounts',
  symposiumAccounts: 'Symposium AI accounts',
  managed: 'Managed services',
  personal: 'Personal ChatGPT accounts',
  google: 'Google Workspace',
  legacy: 'Operator-managed services',
  keychain: 'Apple Keychain services',
};
const verificationLabels = {
  verified: 'Last check passed',
  stale: 'Last check passed',
  unverified: 'Not checked',
  unavailable: "Couldn't check",
};
function verificationLabel(resource: AccessResource) {
  return resource.kind === 'managed-connection' && resource.verification.state === 'verified'
    ? 'Last credential check passed'
    : verificationLabels[resource.verification.state];
}
function ResourceDetails({
  resource,
  catalog,
}: {
  resource: AccessResource;
  catalog?: AccessResource;
}) {
  const isAccount = hasAccountSignIn(resource);
  const identity = accountSignInIdentity(resource);
  const checkLabel = accountCheckLabel(resource);
  return (
    <div className="access-resource-content">
      <section className="access-detail-card" aria-label="Account details">
        <h3>Account details</h3>
        <dl className="access-resource-facts">
          <div>
            <dt>Provider</dt>
            <dd>{resource.details.serviceName ?? resource.provider}</dd>
          </div>
          {runtimeLabel(resource) && (
            <div>
              <dt>Account use</dt>
              <dd>{runtimeLabel(resource)}</dd>
            </div>
          )}
          {isAccount ? (
            <>
              {identity.observed?.email && (
                <div>
                  <dt>Account</dt>
                  <dd>{identity.observed.email}</dd>
                </div>
              )}
              <div>
                <dt>Configured account</dt>
                <dd>{identity.configuredEmail ?? 'Identity not reported'}</dd>
              </div>
              {(identity.observed?.planType || identity.configuredPlan) && (
                <div>
                  <dt>{identity.observed?.planType ? 'Account plan' : 'Configured plan'}</dt>
                  <dd>{identity.observed?.planType ?? identity.configuredPlan}</dd>
                </div>
              )}
            </>
          ) : (
            <div>
              <dt>Account</dt>
              <dd>
                {resource.section === 'services'
                  ? (serviceIdentity(resource) ?? 'Account not checked')
                  : (identity.configuredEmail ?? 'Account not checked')}
              </dd>
            </div>
          )}
        </dl>
      </section>
      {isAccount && (
        <section className="access-detail-card" aria-label={`${checkLabel} details`}>
          <h3>{checkLabel} details</h3>
          <dl className="access-resource-facts">
            <div>
              <dt>{checkLabel}</dt>
              <dd>
                <span>{accountSignInLabel(resource)}</span>
                <p className="workspace-muted">
                  {resource.signIn?.explanation ?? 'Sign-in has not been checked for this account.'}
                </p>
              </dd>
            </div>
            {resource.signIn?.checkedAt != null && (
              <div>
                <dt>{checkLabel === 'Sign-in' ? 'Last sign-in check' : 'Last connection check'}</dt>
                <dd>{new Date(resource.signIn.checkedAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
      <section className="access-detail-card" aria-label="Access and scope">
        <h3>Access and scope</h3>
        <dl className="access-resource-facts">
          <div>
            <dt>Access</dt>
            <dd>{resource.access.summary}</dd>
          </div>
          {resource.details.permissions?.length ? (
            <div>
              <dt>Configured permissions</dt>
              <dd>{resource.details.permissions.join(' · ')}</dd>
            </div>
          ) : null}
          {serviceScope(resource).map((scope) => (
            <div key={scope}>
              <dt>Scope</dt>
              <dd>{scope}</dd>
            </div>
          ))}
          {resource.details.endpoint && (
            <div>
              <dt>Site</dt>
              <dd>{resource.details.endpoint}</dd>
            </div>
          )}
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
            <dd>{connectionStatus(resource)}</dd>
          </div>
          <div>
            <dt>
              {resource.kind === 'managed-connection'
                ? 'Credential verification'
                : 'Access verification'}
            </dt>
            <dd>
              {verificationLabel(resource)}
              {resource.verification.verifiedAt !== null && (
                <> · {new Date(resource.verification.verifiedAt).toLocaleString()}</>
              )}
              {resource.verification.reason && (
                <p className="workspace-muted">{resource.verification.reason}</p>
              )}
            </dd>
          </div>
        </dl>
        <p className="workspace-muted">
          Conversation attachments have not been observed. Configuration and past verification do
          not establish current conversation access.
        </p>
      </section>
      {resource.lastSuccessfulUse && (
        <section className="access-detail-card" aria-label="Successful use">
          <h3>Successful use</h3>
          <dl className="access-resource-facts">
            <div>
              <dt>Last used successfully</dt>
              <dd>{new Date(resource.lastSuccessfulUse.succeededAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{resource.lastSuccessfulUse.model ?? 'Model not recorded'}</dd>
            </div>
          </dl>
          <p className="workspace-muted">
            A completed request through this account. This is historical evidence, not a current
            authentication check.
          </p>
        </section>
      )}
      {resource.section === 'accounts' && (
        <ConnectionsModeDetails resource={resource} catalog={catalog} />
      )}
      {(catalog?.details.models || resource.details.models) && (
        <p className="workspace-muted">
          Models listed here come from this account's catalog. Successful use is shown separately
          when recorded.
        </p>
      )}
      {resource.personalConnection && resource.personalConnection.state !== 'current' && (
        <p className="workspace-muted">
          {resource.personalConnection.state === 'stale'
            ? 'The personal account link is out of date. Refresh access to compare current details.'
            : 'Personal account details could not be checked. This catalog is shown separately.'}
        </p>
      )}
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
          {resource.section === 'services' && resource.accountIdentity && (
            <div>
              <dt>Provider account ID</dt>
              <dd>{resource.accountIdentity}</dd>
            </div>
          )}
          {catalog && (
            <>
              <div>
                <dt>Catalog resource</dt>
                <dd>{catalog.id}</dd>
              </div>
              <div>
                <dt>Catalog management owner</dt>
                <dd>{catalog.owner}</dd>
              </div>
            </>
          )}
          {resource.details.billing && (
            <div>
              <dt>Billing route</dt>
              <dd>{resource.details.billing}</dd>
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
    </div>
  );
}
const websiteAccess = [
  {
    label: 'Provider search',
    subtitle: 'Search through the selected AI provider',
    summary: 'Provider dependent',
    description:
      'Search is handled by the selected AI provider. A search approval applies to that request and does not grant sandbox network access. Availability depends on the account and provider selected inside a chat.',
  },
  {
    label: 'Public page reads',
    subtitle: 'Opening a public website directly',
    summary: 'Request scoped',
    description:
      'One approved website read covers the requested public page. It does not grant ongoing website access. Make one-off website access decisions inside a chat; this overview does not configure a global approval policy.',
  },
  {
    label: 'Sandbox network policies',
    subtitle: 'Base rules and connection-specific access',
    summary: 'Varies by sandbox',
    description:
      'Persistent sandbox website access is a separate network policy. This overview does not report its effective state for a conversation. Eligible ordinary OpenShell sandboxes share an operator base policy; other sandbox types may use different rules. Account-linked connection rules apply only with eligible assignments and active, verified access. Chat-specific grants apply to that chat’s sandbox. Network reachability does not grant service actions or widen a connection’s permissions.',
  },
] as const;
function runtimeLabel(resource: AccessResource) {
  if (resource.owner === 'account-profiles') return 'Ordinary chats';
  if (resource.owner === 'symposium-account-profiles' || resource.owner === 'symposium-personal')
    return 'Symposium';
  return null;
}
function AccessDrawer({
  title,
  children,
  onClose,
  resource,
}: {
  title: string;
  resource?: AccessResource;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const drawer = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);
  useEffect(() => {
    if (drawer.current && !drawer.current.contains(document.activeElement)) close.current?.focus();
  });
  return createPortal(
    <div
      className="access-drawer-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={drawer}
        className="access-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-drawer-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const items = Array.from(
            drawer.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]),a[href],select,input,summary,[tabindex="0"]',
            ) ?? [],
          );
          const first = items[0],
            last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="access-drawer-heading">
          {resource && (
            <span className={`access-row-icon ${resource.section}`} aria-hidden="true">
              {resource.section === 'accounts' ? '✧' : '↗'}
            </span>
          )}
          <div className="access-drawer-heading-copy">
            <p className="workspace-eyebrow">Connections</p>
            <h2 id="access-drawer-title">{title}</h2>
            {resource && runtimeLabel(resource) && (
              <span className="access-runtime-badge">{runtimeLabel(resource)}</span>
            )}
          </div>
          <button
            ref={close}
            className="access-drawer-close"
            aria-label="Close details"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="access-drawer-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
export function ConnectionsAccessView() {
  const [params] = useSearchParams();
  const connectedId = params.get('connected');
  const connectedRow = useRef<HTMLElement>(null);
  const revealedId = useRef<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const restoreFocusPending = useRef(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const addConnection = useRef<HTMLAnchorElement>(null);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [website, setWebsite] = useState<(typeof websiteAccess)[number] | null>(null);
  const [inventory, setInventory] = useState<ConnectionsAccessInventory | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const connectedResources =
    inventory?.resources.filter(
      (resource) => resource.kind === 'managed-connection' && resource.nativeId === connectedId,
    ) ?? [];
  const connected = connectedResources.length === 1 ? connectedResources[0] : undefined;
  const selection = inventory
    ? connectionsAccessCards(inventory).find(({ resource }) => resource.id === selectedResourceId)
    : undefined;
  const drawerOpen = Boolean(selection || website);
  useEffect(() => {
    if (!connected || revealedId.current === connected.id || !connectedRow.current) return;
    revealedId.current = connected.id;
    connectedRow.current.focus();
    connectedRow.current.scrollIntoView?.({ block: 'center' });
  }, [connected]);
  useEffect(() => {
    if (drawerOpen) {
      restoreFocusPending.current = true;
      return;
    }
    // A pending inventory effect can run after a click captures the opener but
    // before the drawer opens. Only consume it after an actual open drawer.
    if (!restoreFocusPending.current || !opener.current) return;
    if (!opener.current.isConnected && loading) return;
    // The page is no longer inert. Preserve the click target even when opening
    // the drawer caused the browser to blur it before the drawer mounted.
    const target = opener.current.isConnected
      ? opener.current
      : refreshButton.current && !refreshButton.current.disabled
        ? refreshButton.current
        : addConnection.current;
    target?.focus();
    opener.current = null;
    restoreFocusPending.current = false;
  }, [drawerOpen, loading]);
  useEffect(() => {
    if (selectedResourceId && inventory && !selection) setSelectedResourceId(null);
  }, [selectedResourceId, inventory, selection]);
  useEffect(() => {
    if (!inventory?.resources.some((resource) => resource.signIn?.status === 'verified')) return;
    const timer = setInterval(() => {
      setInventory((previous) => previous && expireAccountSignIns(previous));
    }, 1000);
    return () => clearInterval(timer);
  }, [inventory]);
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
          setInventory((previous) =>
            expireAccountSignIns(retainUnavailableAccounts(previous, result)),
          );
          setError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(true);
          setInventory(
            (previous) =>
              previous && {
                ...previous,
                resources: previous.resources.map((resource) =>
                  resource.signIn?.status === 'verified'
                    ? {
                        ...resource,
                        signIn: {
                          ...resource.signIn,
                          status: 'stale',
                          explanation:
                            resource.signIn.source === 'openshell-provider-grant'
                              ? 'Current connection check could not be refreshed. Showing an older check.'
                              : 'Current sign-in could not be refreshed. Showing an older check.',
                        },
                      }
                    : resource,
                ),
              },
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <>
      <main className="workspace-page connections-access-page" inert={drawerOpen}>
        <div className="access-page-heading">
          <WorkspacePageHeading
            title="Connections"
            description="Accounts and services for Mitzo. Choose an account inside a chat."
          />
          <Link ref={addConnection} className="access-add-connection" to="/connections">
            <span aria-hidden="true">+</span> Add connection
          </Link>
        </div>
        {connected && (
          <p role="status" className="access-source-notice">
            {connected.label} is listed below. Manage it to review access.
          </p>
        )}
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
          <button
            ref={refreshButton}
            className="workspace-text-link"
            disabled={loading}
            onClick={refresh}
          >
            Refresh access
          </button>
        )}
        {inventory && (
          <>
            {inventory.sources
              .filter((source) => source.state === 'unavailable')
              .map((source) => (
                <div
                  key={source.id}
                  className="access-source-notice"
                  role={source.state === 'unavailable' ? 'status' : undefined}
                >
                  <strong>Couldn't load {sourceLabels[source.id]}. Retry.</strong>
                  {source.reason && <p>{source.reason}</p>}
                </div>
              ))}
            {(['accounts', 'services'] as const).map((section) => {
              const resources = connectionsAccessCards(inventory).filter(
                ({ resource }) => resource.section === section,
              );
              const label = section === 'accounts' ? 'AI accounts' : 'Services';
              return (
                <section key={section} className="today-section access-section" aria-label={label}>
                  <div className="access-section-heading">
                    <h2>{label}</h2>
                    <span className="workspace-muted">
                      {section === 'accounts'
                        ? 'Choose inside a chat or agent'
                        : 'Each connection’s permissions apply'}
                    </span>
                  </div>
                  <div className="access-row-group">
                    {resources.map(({ resource }) => {
                      const identity = accountSignInIdentity(resource);
                      const title = connectionTitle(resource, inventory.resources);
                      return (
                        <article
                          key={resource.id}
                          ref={resource.id === connected?.id ? connectedRow : undefined}
                          tabIndex={resource.id === connected?.id ? -1 : undefined}
                          data-new-connection={resource.id === connected?.id ? 'true' : undefined}
                          className="access-row"
                          aria-label={title}
                        >
                          <span className={`access-row-icon ${section}`} aria-hidden="true">
                            {section === 'accounts' ? '✧' : '↗'}
                          </span>
                          <div className="access-row-copy">
                            <h3>
                              {title}
                              {runtimeLabel(resource) && (
                                <span className="access-runtime-badge">
                                  {runtimeLabel(resource)}
                                </span>
                              )}
                            </h3>
                            {hasAccountSignIn(resource) ? (
                              <>
                                {identity.observed?.email && <p>{identity.observed.email}</p>}
                                {identity.configuredEmail && (
                                  <p>Configured: {identity.configuredEmail}</p>
                                )}
                              </>
                            ) : (
                              <p>
                                {resource.section === 'services'
                                  ? (serviceIdentity(resource) ?? 'Account not checked')
                                  : (identity.configuredEmail ?? resource.provider)}
                              </p>
                            )}
                            {resource.section === 'services' && (
                              <>
                                {serviceScope(resource).map((scope) => (
                                  <p key={scope}>{scope}</p>
                                ))}
                                {resource.details.endpoint && !serviceScope(resource).length && (
                                  <p>{resource.details.endpoint}</p>
                                )}
                                <p>
                                  {resource.details.permissions?.length
                                    ? resource.details.permissions.join(' · ')
                                    : 'Permissions not checked'}
                                </p>
                              </>
                            )}
                          </div>
                          <span className="access-row-status">
                            {hasAccountSignIn(resource) ? (
                              <>
                                <span>{connectionStatus(resource)}</span>
                                <small>
                                  {accountCheckLabel(resource)}: {accountSignInLabel(resource)}
                                </small>
                              </>
                            ) : (
                              <>
                                <span>{connectionStatus(resource)}</span>
                                {resource.section === 'accounts' && !resource.lastSuccessfulUse && (
                                  <small>
                                    {resource.provider === 'openai-codex'
                                      ? 'Sign-in not checked'
                                      : 'Credentials not checked'}
                                  </small>
                                )}
                              </>
                            )}
                            {resource.lastSuccessfulUse && (
                              <small>
                                Last used successfully:{' '}
                                {new Date(resource.lastSuccessfulUse.succeededAt).toLocaleString()}
                              </small>
                            )}
                            {resource.section === 'services' &&
                              resource.verification.verifiedAt !== null && (
                                <small>
                                  Last successful credential check:{' '}
                                  {new Date(resource.verification.verifiedAt).toLocaleString()}
                                </small>
                              )}
                          </span>
                          <button
                            className="access-row-action"
                            aria-label={`Manage ${title}`}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              setSelectedResourceId(resource.id);
                            }}
                          >
                            Manage <span aria-hidden="true">›</span>
                          </button>
                        </article>
                      );
                    })}
                  </div>
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
        <section
          className="today-section access-section access-web-guide"
          aria-label="How web access works"
        >
          <div className="access-section-heading">
            <h2>How web access works</h2>
          </div>
          <p className="workspace-muted">
            These options explain web access inside a chat. They are not connection status checks.
          </p>
          <div className="access-web-options">
            {websiteAccess.map((item) => (
              <div key={item.label} className="access-web-option">
                <div className="access-row-copy">
                  <h3>{item.label}</h3>
                  <p>{item.subtitle}</p>
                </div>
                <button
                  className="access-row-action"
                  aria-label={`View ${item.label}`}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setWebsite(item);
                  }}
                >
                  View <span aria-hidden="true">›</span>
                </button>
              </div>
            ))}
          </div>
        </section>
      </main>
      {selection && (
        <AccessDrawer
          title={connectionTitle(selection.resource, inventory?.resources ?? [])}
          resource={selection.resource}
          onClose={() => setSelectedResourceId(null)}
        >
          {loading && <p role="status">Refreshing access… Showing the last loaded results.</p>}
          {error && (
            <div role="alert" className="access-source-notice">
              <p>Showing older results. Current access could not be refreshed.</p>
              <button className="workspace-text-link" disabled={loading} onClick={refresh}>
                Try again
              </button>
            </div>
          )}
          {inventory?.sources.some(
            (source) =>
              source.id === accountResourceSource(selection.resource) &&
              source.state === 'unavailable',
          ) && (
            <p role="status" className="access-source-notice">
              Showing an older account. Its source is unavailable; current account details could not
              be checked.
            </p>
          )}
          <ResourceDetails
            key={`${selection.resource.id}:${inventory?.generatedAt}`}
            {...selection}
          />
        </AccessDrawer>
      )}
      {website && (
        <AccessDrawer title={website.label} onClose={() => setWebsite(null)}>
          {website.label === 'Sandbox network policies' ? (
            <div className="access-network-policy">
              <p className="access-policy-description">
                Persistent sandbox website access is a separate network policy. Actual destinations
                depend on the sandbox and its attached connections.
              </p>
              <section>
                <h3>Shared base rules</h3>
                <p>
                  Eligible ordinary OpenShell sandboxes share an operator base policy. Other sandbox
                  types may use different rules.
                </p>
              </section>
              <section>
                <h3>Account-linked connections</h3>
                <p>
                  Connection rules apply only with eligible account assignments and active, verified
                  access. Network reachability does not grant service actions or widen a
                  connection’s permissions.
                </p>
              </section>
              <section>
                <h3>Chat-specific grants</h3>
                <p>
                  Additional grants apply to that chat’s sandbox. Approvals for directly opening
                  public pages are separate.
                </p>
              </section>
              <section>
                <h3>Effective access not checked</h3>
                <p>
                  This overview does not report the destinations a conversation’s sandbox can
                  currently reach.
                </p>
              </section>
            </div>
          ) : (
            <p className="access-policy-description">{website.description}</p>
          )}
          <p className="workspace-muted">
            Access decisions remain inside the chat and existing management controls.
          </p>
        </AccessDrawer>
      )}
    </>
  );
}
