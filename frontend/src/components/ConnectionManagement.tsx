import { useCallback, useEffect, useRef, useState } from 'react';
import { SecretField } from './ConnectionSetupFields';
import {
  jiraFallbackCredentials,
  time,
  status,
  secretValid,
  templateKey,
} from '../lib/connections-form';
import {
  deleteConnection,
  getConnectionCapabilityGrants,
  retryConnection,
  revokeConnection,
  rotateConnection,
  setConnectionCapabilityGrant,
  testConnection,
  updateAssignments,
} from '../lib/connections-api';
import type {
  ConnectionAuditEntry,
  ConnectionCapabilityGrant,
  ConnectionCapability,
  ConnectionTemplate,
  ManagedConnection,
} from '../types/connections';

function CapabilityGrants({
  connection,
  references,
  catalog,
  refreshEpoch,
  csrf,
  busy,
  requireReauthorization,
  onAction,
}: {
  connection: ManagedConnection;
  references: Array<{ id: string; version: number }>;
  catalog: ConnectionCapability[];
  refreshEpoch: number;
  csrf: string;
  busy: string | null;
  requireReauthorization: () => boolean;
  onAction: (name: string, action: () => Promise<unknown>, success: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState<ConnectionCapabilityGrant[]>([]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const dirtyKeys = useRef(new Set<string>());
  // A response refresh creates new arrays even when assignments did not change.
  // Keep an in-progress grant selection through reauthorization in that case.
  const assignmentKey = connection.desiredAccountIds.join('\u0000');
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const next = await getConnectionCapabilityGrants(connection.id);
      if (request !== generation.current) return;
      setGrants(next);
      const assigned = new Set(assignmentKey ? assignmentKey.split('\u0000') : []);
      const persisted = Object.fromEntries(
        next
          .filter(
            (grant) =>
              grant.connectionRevision === connection.revision && grant.status === 'active',
          )
          .map((grant) => [
            templateKey({ id: grant.capabilityId, version: grant.capabilityVersion }),
            grant.accountIds.filter((id) => assigned.has(id)),
          ]),
      );
      setSelected((previous) => ({
        ...persisted,
        ...Object.fromEntries(
          [...dirtyKeys.current]
            .filter((key) => key in previous)
            .map((key) => [key, previous[key]]),
        ),
      }));
    } catch (reason) {
      if (request === generation.current)
        setError(reason instanceof Error ? reason.message : 'Unable to load capability grants.');
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [connection.id, connection.revision, assignmentKey]);
  useEffect(() => {
    dirtyKeys.current.clear();
  }, [connection.id, connection.revision, assignmentKey]);
  useEffect(() => {
    if (open) void load();
    return () => {
      generation.current += 1;
    };
  }, [open, load, refreshEpoch]);
  if (!references.length) return null;
  return (
    <section
      className="connections-capabilities"
      aria-label={`Capabilities for ${connection.label}`}
    >
      <h3>Approved actions</h3>
      <p className="workspace-muted">
        Choose which AI accounts can request this action. Each use requires approval and is
        recorded.
      </p>
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? 'Hide capability grants' : 'Manage approved actions'}
      </button>
      {open && (
        <>
          {loading && <p role="status">Loading grants…</p>}
          {error && <p role="alert">{error}</p>}
          {!loading &&
            !error &&
            references.map((reference) => {
              const key = templateKey(reference);
              const capability = catalog.find(
                (item) => item.id === reference.id && item.version === reference.version,
              );
              const current = grants.find(
                (item) =>
                  item.connectionRevision === connection.revision &&
                  item.capabilityId === reference.id &&
                  item.capabilityVersion === reference.version,
              );
              const active = current?.status === 'active';
              const assigned = connection.desiredAccountIds;
              const values = selected[key] ?? [];
              const save = async (status: 'active' | 'revoked', accountIds: string[]) => {
                if (!requireReauthorization()) return;
                const saved = await onAction(
                  `grant:${connection.id}:${key}`,
                  () =>
                    setConnectionCapabilityGrant({
                      id: connection.id,
                      revision: connection.revision,
                      capabilityId: reference.id,
                      capabilityVersion: reference.version,
                      accountIds,
                      status,
                      csrf,
                    }),
                  status === 'active'
                    ? 'Capability grant updated for new conversations.'
                    : 'Capability grant revoked.',
                );
                if (saved) dirtyKeys.current.delete(key);
                await load();
              };
              return (
                <div className="connections-capability" key={key}>
                  <h4>{capability?.label ?? `${reference.id} v${reference.version}`}</h4>
                  {capability?.description && <p>{capability.description}</p>}
                  <p className="workspace-muted">
                    {active ? `Active for: ${current.accountIds.join(', ')}` : 'No active grant.'}
                  </p>
                  <fieldset className="connections-profiles">
                    <legend>Profiles allowed to request this capability</legend>
                    {assigned.map((id) => (
                      <label className="connections-profile-option" key={id}>
                        <input
                          type="checkbox"
                          checked={values.includes(id)}
                          disabled={busy !== null || connection.status !== 'active'}
                          onChange={() => {
                            dirtyKeys.current.add(key);
                            setSelected((previous) => ({
                              ...previous,
                              [key]: values.includes(id)
                                ? values.filter((value) => value !== id)
                                : [...values, id],
                            }));
                          }}
                        />{' '}
                        {id}
                      </label>
                    ))}
                    {!assigned.length && (
                      <p className="workspace-muted">
                        Assign a profile before enabling this capability.
                      </p>
                    )}
                  </fieldset>
                  <button
                    type="button"
                    disabled={
                      busy !== null ||
                      connection.status !== 'active' ||
                      !values.length ||
                      (active &&
                        values.length === current.accountIds.length &&
                        values.every((id) => current.accountIds.includes(id)))
                    }
                    onClick={() => void save('active', values)}
                  >
                    Save grant
                  </button>{' '}
                  {active && (
                    <button
                      type="button"
                      className="connections-danger"
                      disabled={busy !== null}
                      onClick={() => void save('revoked', current.accountIds)}
                    >
                      Revoke grant
                    </button>
                  )}
                </div>
              );
            })}
        </>
      )}
    </section>
  );
}

export function ConnectionCard({
  connection,
  template,
  accounts,
  capabilityCatalog,
  refreshEpoch,
  csrf,
  busy,
  audit,
  rotateOpen,
  rotationCredentials,
  requireReauthorization,
  onRotateOpen,
  onRotationCredentials,
  onRotateClose,
  onAction,
  onAudit,
}: {
  connection: ManagedConnection;
  template?: ConnectionTemplate;
  accounts: string[];
  capabilityCatalog: ConnectionCapability[];
  refreshEpoch: number;
  csrf: string;
  busy: string | null;
  audit?: ConnectionAuditEntry[];
  rotateOpen: boolean;
  rotationCredentials: Record<string, string>;
  requireReauthorization: () => boolean;
  onRotateOpen: () => void;
  onRotationCredentials: (next: Record<string, string>) => void;
  onRotateClose: () => void;
  onAction: (
    name: string,
    action: () => Promise<unknown>,
    success: string,
    onFailure?: () => void,
    onSuccess?: () => void,
  ) => Promise<boolean>;
  onAudit: (id: string) => Promise<void>;
}) {
  const [removalOpen, setRemovalOpen] = useState(false);
  const [revocationOpen, setRevocationOpen] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const credentialFields =
    connection.credentialFields ??
    template?.credentialFields ??
    (connection.templateId === 'jira-readonly' && connection.templateVersion === 1
      ? jiraFallbackCredentials
      : []);
  return (
    <article className="workspace-record connections-record">
      <div>
        <h2>{connection.label}</h2>
        <p>{connection.identity ?? 'Identity not verified'}</p>
        <p className="workspace-muted">
          {status(connection)} · Last checked {time(connection.verifiedAt)}
        </p>
        <details className="connections-technical">
          <summary>Technical details</summary>
          <p>
            {template ? `${template.label} v${connection.templateVersion}` : connection.templateId}
          </p>
          <p>{connection.endpoint}</p>
          {Object.keys(connection.publicConfig).length > 0 && (
            <dl>
              {Object.entries(connection.publicConfig).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{Array.isArray(value) ? value.join(', ') : value}</dd>
                </div>
              ))}
            </dl>
          )}
        </details>
        <fieldset className="connections-profiles">
          <legend>AI accounts with access</legend>
          {accounts.map((id) => (
            <label className="connections-profile-option" key={id}>
              <input
                type="checkbox"
                checked={connection.desiredAccountIds.includes(id)}
                disabled={busy !== null}
                onChange={() => {
                  if (!requireReauthorization()) return;
                  const next = connection.desiredAccountIds.includes(id)
                    ? connection.desiredAccountIds.filter((value) => value !== id)
                    : [...connection.desiredAccountIds, id];
                  void onAction(
                    `assign:${connection.id}`,
                    () =>
                      updateAssignments({
                        id: connection.id,
                        revision: connection.revision,
                        accountIds: next,
                        csrf,
                      }),
                    'Assignments updated for new conversations.',
                  );
                }}
              />{' '}
              {id}
            </label>
          ))}
        </fieldset>
        <CapabilityGrants
          connection={connection}
          references={connection.capabilityTemplates ?? template?.capabilityTemplates ?? []}
          catalog={capabilityCatalog}
          refreshEpoch={refreshEpoch}
          csrf={csrf}
          busy={busy}
          requireReauthorization={requireReauthorization}
          onAction={onAction}
        />
      </div>
      <div className="connections-actions">
        <button
          disabled={busy !== null || connection.status === 'revoked'}
          onClick={() => {
            if (requireReauthorization())
              void onAction(
                `test:${connection.id}`,
                () => testConnection({ id: connection.id, revision: connection.revision, csrf }),
                'Identity test completed.',
              );
          }}
        >
          Test identity
        </button>
        <button
          disabled={busy !== null || connection.status === 'revoked' || !credentialFields.length}
          onClick={onRotateOpen}
        >
          {connection.status === 'needs_attention' ? 'Retry credentials' : 'Rotate credentials'}
        </button>
        <button
          disabled={busy === `audit:${connection.id}`}
          onClick={() => void onAudit(connection.id)}
        >
          Show audit
        </button>
      </div>
      <details className="connections-destructive-actions">
        <summary>Disconnect or remove</summary>
        <p className="workspace-muted">
          Revoke stops access while keeping this saved connection. Remove also deletes it from
          Connections. Neither action revokes the token at the service.
        </p>
        <div className="connections-actions">
          <button
            className="connections-danger"
            disabled={busy !== null || connection.status === 'revoked'}
            onClick={() => {
              setRevocationOpen(true);
              setRemovalOpen(false);
            }}
          >
            Revoke
          </button>
          <button
            className="connections-danger"
            disabled={busy !== null}
            onClick={() => {
              setRemovalError('');
              setRevocationOpen(false);
              setRemovalOpen(true);
            }}
          >
            Remove connection
          </button>
        </div>
      </details>
      {revocationOpen && (
        <section className="connections-remove-confirm" aria-label={`Revoke ${connection.label}`}>
          <p>
            Stops managed access immediately, including existing chats. The saved connection remains
            in Connections. Revoke its token at the service separately if needed.
          </p>
          <button
            className="connections-danger"
            disabled={busy !== null}
            onClick={() => {
              if (!requireReauthorization()) return;
              void onAction(
                `revoke:${connection.id}`,
                () => revokeConnection({ id: connection.id, revision: connection.revision, csrf }),
                'Revocation confirmed. Revoke the upstream credential separately if needed.',
                undefined,
                () => setRevocationOpen(false),
              );
            }}
          >
            Confirm revocation
          </button>
          <button disabled={busy !== null} onClick={() => setRevocationOpen(false)}>
            Cancel
          </button>
        </section>
      )}
      {removalOpen && (
        <section className="connections-remove-confirm" aria-label={`Remove ${connection.label}`}>
          <p>
            Removing this connection revokes managed access before it is removed from this list.
            This does not revoke the upstream credential.
          </p>
          {removalError && <p role="alert">{removalError}</p>}
          <button
            className="connections-danger"
            disabled={busy !== null}
            onClick={() => {
              if (!requireReauthorization()) {
                setRemovalError('Reauthorize with your passphrase, then confirm removal.');
                return;
              }
              setRemovalError('');
              void onAction(
                `delete:${connection.id}`,
                () => deleteConnection({ id: connection.id, revision: connection.revision, csrf }),
                'Connection removed from this list after managed access was revoked.',
                () => setRemovalError('Connection removal failed. Refresh and retry.'),
              );
            }}
          >
            Confirm removal
          </button>
          <button type="button" disabled={busy !== null} onClick={() => setRemovalOpen(false)}>
            Cancel
          </button>
        </section>
      )}
      {rotateOpen && (
        <form
          className="connections-rotate"
          onSubmit={(event) => {
            event.preventDefault();
            if (!secretValid(credentialFields, rotationCredentials)) return;
            if (!requireReauthorization()) return;
            const oneShot = rotationCredentials;
            onRotationCredentials({});
            onRotateClose();
            void onAction(
              `rotate:${connection.id}`,
              () =>
                connection.status === 'needs_attention'
                  ? retryConnection({
                      id: connection.id,
                      revision: connection.revision,
                      credentials: oneShot,
                      csrf,
                    })
                  : rotateConnection({
                      id: connection.id,
                      revision: connection.revision,
                      credentials: oneShot,
                      csrf,
                    }),
              connection.status === 'needs_attention'
                ? 'Connection verified and activated.'
                : 'Credential rotation completed.',
              () => onRotationCredentials({}),
            );
          }}
        >
          {credentialFields.map((field) => (
            <SecretField
              key={field.key}
              prefix="Replacement "
              field={field}
              value={rotationCredentials[field.key] ?? ''}
              onChange={(value) =>
                onRotationCredentials({ ...rotationCredentials, [field.key]: value })
              }
            />
          ))}
          <button
            className="workspace-primary"
            disabled={busy !== null || !secretValid(credentialFields, rotationCredentials)}
          >
            Verify and rotate
          </button>
          <button type="button" onClick={onRotateClose}>
            Cancel
          </button>
        </form>
      )}
      {audit && (
        <ol className="connections-audit" aria-label={`${connection.label} audit history`}>
          {audit.map((entry) => (
            <li key={entry.id}>
              {new Date(entry.createdAt).toLocaleString()}: {entry.operation} {entry.outcome}
              {entry.affectedRefs.length ? ` (${entry.affectedRefs.join(', ')})` : ''}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
