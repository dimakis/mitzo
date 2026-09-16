import { useCallback, useEffect, useMemo, useState } from 'react';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import {
  createConnection,
  deleteConnection,
  getConnectionAudit,
  getConnectionTemplates,
  getConnections,
  reauthorize,
  retryConnection,
  revokeConnection,
  rotateConnection,
  testConnection,
  updateAssignments,
} from '../lib/connections-api';
import type {
  ConnectionAuditEntry,
  ConnectionCapability,
  ConnectionCredentialField,
  ConnectionTemplate,
  ConnectionsCatalog,
  ConnectionTemplateCatalog,
  ManagedConnection,
} from '../types/connections';

type WizardStep = 'service' | 'authenticate' | 'scope' | 'capabilities' | 'assignments' | 'review';
const steps: WizardStep[] = [
  'service',
  'authenticate',
  'scope',
  'capabilities',
  'assignments',
  'review',
];
const stepLabel: Record<WizardStep, string> = {
  service: 'Service',
  authenticate: 'Authenticate',
  scope: 'Scope',
  capabilities: 'Capabilities',
  assignments: 'Assignments',
  review: 'Review',
};
const riskCopy = {
  'read-only': 'Read-only sandbox egress',
  'bounded-write': 'Bounded write access',
  'operator-defined': 'Operator-defined reviewed access',
} as const;
const time = (value: number | null) =>
  value ? new Date(value).toLocaleString() : 'Not yet verified';
export const connectionErrorMessage = (code: string) =>
  ({
    JIRA_AUTH_REJECTED:
      'Jira rejected the token. Check that it is for redhat.atlassian.net and that the Atlassian account email matches the token.',
    JIRA_PERMISSION_DENIED:
      'Jira denied the identity check. Give the scoped token the Jira read permission needed for /myself and confirm the account has site access.',
    JIRA_HTTP_ERROR:
      'Jira returned an unexpected response. Retry, then check the selected site and token if it continues.',
    JIRA_NETWORK_FAILED: 'Could not reach Jira. Retry the connection.',
    ACCOUNT_ALREADY_ASSIGNED:
      'This work profile is already assigned to another connection. Remove the old connection or choose a different work profile.',
  })[code] ?? code;
const status = (connection: ManagedConnection) =>
  connection.errorCode
    ? `${connection.status.replaceAll('_', ' ')}: ${connectionErrorMessage(connection.errorCode)}`
    : connection.status.replaceAll('_', ' ');
const secretValid = (fields: ConnectionCredentialField[], values: Record<string, string>) =>
  fields.every((field) => !field.required || Boolean(values[field.key]));
const scopeValid = (template: ConnectionTemplate, values: Record<string, string>) =>
  template.connectionFields.every((field) => !field.required || Boolean(values[field.key]?.trim()));
const scopeValues = (template: ConnectionTemplate, values: Record<string, string>) =>
  Object.fromEntries(
    template.connectionFields
      .map((field) => [
        field.key,
        field.kind === 'string-list' || field.kind === 'enum-list'
          ? (values[field.key] ?? '')
              .split('\n')
              .map((v) => v.trim())
              .filter(Boolean)
          : (values[field.key] ?? '').trim(),
      ])
      .filter(([, value]) => (Array.isArray(value) ? value.length : value)),
  );

export function ConnectionsView() {
  const [data, setData] = useState<ConnectionsCatalog | null>(null);
  const [templates, setTemplates] = useState<ConnectionTemplateCatalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [csrf, setCsrf] = useState('');
  const [csrfExpiresAt, setCsrfExpiresAt] = useState(0);
  const [passphrase, setPassphrase] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [step, setStep] = useState<WizardStep>('service');
  const [busy, setBusy] = useState<string | null>(null);
  const [audit, setAudit] = useState<Record<string, ConnectionAuditEntry[]>>({});
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotationCredentials, setRotationCredentials] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    setLoadError('');
    try {
      const [nextData, nextTemplates] = await Promise.all([
        getConnections(),
        getConnectionTemplates(),
      ]);
      setData(nextData);
      setTemplates(nextTemplates);
      setTemplateId(
        (current) =>
          current ||
          nextTemplates.templates.find((item) => item.id === 'jira-readonly')?.id ||
          nextTemplates.templates[0]?.id ||
          '',
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load connections.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () => () => {
      setCredentials({});
      setRotationCredentials({});
    },
    [],
  );
  const template = useMemo(
    () => templates?.templates.find((item) => item.id === templateId) ?? null,
    [templates, templateId],
  );
  const availableCapabilities = useMemo(
    () =>
      template
        ? (templates?.capabilities.filter((item) => template.capabilityIds.includes(item.id)) ?? [])
        : [],
    [template, templates],
  );
  const run = async (
    name: string,
    action: () => Promise<unknown>,
    success: string,
    onFailure?: () => void,
  ) => {
    setBusy(name);
    setMessage('');
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The request failed. Refresh and retry.');
      onFailure?.();
      await refresh();
    } finally {
      setBusy(null);
    }
  };
  const requireReauthorization = () => {
    if (csrf && csrfExpiresAt > Date.now()) return true;
    setCsrf('');
    setCsrfExpiresAt(0);
    setMessage('Reauthorize with your passphrase before changing managed access.');
    return false;
  };
  const toggle = (id: string, values: string[], setter: (next: string[]) => void) =>
    setter(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const chooseTemplate = (next: ConnectionTemplate) => {
    setTemplateId(next.id);
    setLabel(next.label);
    setScope({});
    setCredentials({});
    setCapabilities([]);
    setStep('authenticate');
  };
  if ((!data || !templates) && !loadError) return <PageState text="Loading connections…" />;
  if (!data || !templates) return <PageState text={loadError} error retry={refresh} />;
  return (
    <main className="workspace-page connections-page">
      <WorkspacePageHeading
        title="Connections"
        description={`Assignments apply to ${data.appliesTo}. Adding a connection never expands a retained conversation; removal and revocation reduce managed access immediately.`}
      />
      {message && (
        <p className="connections-notice" role="status">
          {message}
        </p>
      )}
      <Reauthorization
        busy={busy}
        passphrase={passphrase}
        onPassphrase={setPassphrase}
        onSubmit={() =>
          void run(
            'reauthorize',
            async () => {
              const next = await reauthorize(passphrase);
              setCsrf(next.csrf);
              setCsrfExpiresAt(next.expiresAt);
              setPassphrase('');
            },
            'Reauthorization is active for five minutes.',
          )
        }
      />
      <section className="today-section connections-card" aria-labelledby="add-connection-heading">
        <h2 id="add-connection-heading">Add connection</h2>
        <p className="workspace-muted">
          Choose a reviewed service, then verify its effective access before activation.
        </p>
        <ol className="connections-steps" aria-label="Connection setup steps">
          {steps.map((item) => (
            <li key={item} aria-current={step === item ? 'step' : undefined}>
              {stepLabel[item]}
            </li>
          ))}
        </ol>
        {step === 'service' && (
          <ServiceCatalog templates={templates.templates} onChoose={chooseTemplate} />
        )}
        {template && step === 'authenticate' && (
          <Authentication
            template={template}
            label={label}
            onLabel={setLabel}
            credentials={credentials}
            onCredentials={setCredentials}
          />
        )}
        {template && step === 'scope' && (
          <Scope template={template} values={scope} onValues={setScope} />
        )}
        {template && step === 'capabilities' && (
          <CapabilitySelection
            items={availableCapabilities}
            selected={capabilities}
            onToggle={(id) => toggle(id, capabilities, setCapabilities)}
          />
        )}
        {template && step === 'assignments' && (
          <Assignments
            accounts={data.eligibleAccounts}
            selected={accounts}
            onToggle={(id) => toggle(id, accounts, setAccounts)}
          />
        )}
        {template && step === 'review' && (
          <Review
            template={template}
            label={label}
            scope={scopeValues(template, scope)}
            capabilities={availableCapabilities.filter((item) => capabilities.includes(item.id))}
            accounts={accounts}
          />
        )}
        {template && (
          <div className="connections-wizard-actions">
            {step !== 'service' && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setStep(steps[Math.max(0, steps.indexOf(step) - 1)]!)}
              >
                Back
              </button>
            )}
            {step !== 'review' ? (
              <button
                type="button"
                className="workspace-primary"
                disabled={
                  busy !== null ||
                  (step === 'authenticate' &&
                    !secretValid(template.credentialFields, credentials)) ||
                  (step === 'scope' && !scopeValid(template, scope)) ||
                  (step === 'assignments' && !accounts.length)
                }
                onClick={() => setStep(steps[steps.indexOf(step) + 1] ?? step)}
              >
                Continue
              </button>
            ) : (
              <button
                className="workspace-primary"
                disabled={
                  busy === 'create' ||
                  !label.trim() ||
                  !accounts.length ||
                  !secretValid(template.credentialFields, credentials) ||
                  !scopeValid(template, scope)
                }
                onClick={() => {
                  if (!requireReauthorization()) return;
                  const oneShot = credentials;
                  setCredentials({});
                  void run(
                    'create',
                    () =>
                      createConnection({
                        templateId: template.id,
                        templateVersion: template.version,
                        label: label.trim(),
                        fields: scopeValues(template, scope),
                        credentials: oneShot,
                        accountIds: accounts,
                        csrf,
                      }),
                    `${template.label} connection verified and activated.`,
                    () => setCredentials({}),
                  );
                }}
              >
                {busy === 'create'
                  ? 'Verifying connection…'
                  : `Verify and connect ${template.label}`}
              </button>
            )}
          </div>
        )}
      </section>
      <section className="today-section" aria-labelledby="managed-heading">
        <h2 id="managed-heading">External service connections</h2>
        {data.connections.length === 0 ? (
          <p>No managed connections.</p>
        ) : (
          data.connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              template={templates.templates.find((item) => item.id === connection.templateId)}
              accounts={data.eligibleAccounts}
              csrf={csrf}
              busy={busy}
              audit={audit[connection.id]}
              rotateOpen={rotateId === connection.id}
              rotationCredentials={rotationCredentials}
              requireReauthorization={requireReauthorization}
              onRotateOpen={() => {
                setRotateId(connection.id);
                setRotationCredentials({});
              }}
              onRotationCredentials={setRotationCredentials}
              onRotateClose={() => {
                setRotateId(null);
                setRotationCredentials({});
              }}
              onAction={run}
              onAudit={async (id) => {
                setBusy(`audit:${id}`);
                try {
                  const entries = await getConnectionAudit(id);
                  setAudit((current) => ({ ...current, [id]: entries }));
                } catch (error) {
                  setMessage(
                    error instanceof Error ? error.message : 'Unable to load audit history.',
                  );
                } finally {
                  setBusy(null);
                }
              }}
            />
          ))
        )}
      </section>
      <section className="today-section">
        <h2>Operator-managed legacy services</h2>
        <p>
          {data.legacy.length
            ? data.legacy.map((service) => `${service.label} (${service.management})`).join(', ')
            : 'None reported.'}
        </p>
        <p className="workspace-muted">
          These providers are managed by the operator and are not changed here.
        </p>
      </section>
    </main>
  );
}

function PageState({
  text,
  error,
  retry,
}: {
  text: string;
  error?: boolean;
  retry?: () => Promise<void>;
}) {
  return (
    <main className="workspace-page">
      <WorkspacePageHeading title="Connections" />
      <p role={error ? 'alert' : undefined}>{text}</p>
      {retry && (
        <button className="workspace-primary" onClick={() => void retry()}>
          Retry
        </button>
      )}
    </main>
  );
}
function Reauthorization({
  busy,
  passphrase,
  onPassphrase,
  onSubmit,
}: {
  busy: string | null;
  passphrase: string;
  onPassphrase: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="today-section connections-card" aria-labelledby="reauthorize-heading">
      <h2 id="reauthorize-heading">Recent reauthorization</h2>
      <p className="workspace-muted">
        Required before creating, testing, assigning, rotating, or revoking a managed connection.
      </p>
      <label className="connections-field">
        Passphrase
        <input
          aria-label="Passphrase"
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => onPassphrase(event.target.value)}
        />
      </label>
      <button
        className="workspace-primary"
        disabled={busy === 'reauthorize' || !passphrase}
        onClick={onSubmit}
      >
        {busy === 'reauthorize' ? 'Reauthorizing…' : 'Reauthorize'}
      </button>
    </section>
  );
}
function ServiceCatalog({
  templates,
  onChoose,
}: {
  templates: ConnectionTemplate[];
  onChoose: (template: ConnectionTemplate) => void;
}) {
  return (
    <div className="connections-catalog" role="list" aria-label="Reviewed connection services">
      {templates.map((template) => (
        <article
          className="connections-template"
          role="listitem"
          key={`${template.id}@${template.version}`}
        >
          <div>
            <h3>{template.label}</h3>
            <p>{template.description}</p>
            <p className="workspace-muted">
              {template.category.replaceAll('-', ' ')} ·{' '}
              <strong className={`connections-risk connections-risk--${template.risk}`}>
                {riskCopy[template.risk]}
              </strong>
            </p>
            <p className="workspace-muted">
              Authentication:{' '}
              {template.credentialFields
                .map((field) => field.style.replaceAll('-', ' '))
                .join(', ') || 'none'}{' '}
              · Capabilities: {template.capabilityIds.length || 'none'}
            </p>
          </div>
          <button className="workspace-primary" type="button" onClick={() => onChoose(template)}>
            Choose {template.label}
          </button>
        </article>
      ))}
    </div>
  );
}
function SecretField({
  field,
  value,
  onChange,
  prefix = '',
}: {
  field: ConnectionCredentialField;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
}) {
  const name = `${prefix}${field.label}`;
  return (
    <label className="connections-field">
      {name}
      <input
        aria-label={name}
        type="password"
        autoComplete="off"
        required={field.required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>{field.description}</small>
    </label>
  );
}
function Authentication({
  template,
  label,
  onLabel,
  credentials,
  onCredentials,
}: {
  template: ConnectionTemplate;
  label: string;
  onLabel: (value: string) => void;
  credentials: Record<string, string>;
  onCredentials: (next: Record<string, string>) => void;
}) {
  return (
    <div>
      <h3>Authenticate with {template.label}</h3>
      <label className="connections-field">
        Connection label
        <input
          aria-label="Connection label"
          maxLength={100}
          value={label}
          onChange={(event) => onLabel(event.target.value)}
        />
      </label>
      <p className="workspace-muted">
        Secrets are one-shot gateway inputs. They are cleared after submission succeeds or fails,
        when this service changes, and when you leave this page.
      </p>
      {template.credentialFields.map((field) => (
        <SecretField
          key={field.key}
          field={field}
          value={credentials[field.key] ?? ''}
          onChange={(value) => onCredentials({ ...credentials, [field.key]: value })}
        />
      ))}
    </div>
  );
}
function Scope({
  template,
  values,
  onValues,
}: {
  template: ConnectionTemplate;
  values: Record<string, string>;
  onValues: (next: Record<string, string>) => void;
}) {
  if (!template.connectionFields.length)
    return (
      <div>
        <h3>Scope</h3>
        <p className="workspace-muted">
          This reviewed template has no browser-configurable scope. Sandbox egress remains
          constrained by the template.
        </p>
      </div>
    );
  return (
    <div>
      <h3>Scope</h3>
      {template.connectionFields.map((field) => (
        <label className="connections-field" key={field.key}>
          {field.label}
          {field.kind === 'enum-list' ? (
            <fieldset className="connections-profiles">
              <legend>{field.description}</legend>
              {field.choices?.map((choice) => (
                <label className="connections-profile-option" key={choice}>
                  <input
                    type="checkbox"
                    checked={(values[field.key] ?? '').split('\n').includes(choice)}
                    onChange={() => {
                      const next = new Set((values[field.key] ?? '').split('\n').filter(Boolean));
                      if (next.has(choice)) next.delete(choice);
                      else next.add(choice);
                      onValues({ ...values, [field.key]: [...next].join('\n') });
                    }}
                  />{' '}
                  {choice}
                </label>
              ))}
            </fieldset>
          ) : (
            <>
              <textarea
                aria-label={field.label}
                required={field.required}
                rows={field.kind === 'string-list' ? 4 : undefined}
                value={values[field.key] ?? ''}
                onChange={(event) => onValues({ ...values, [field.key]: event.target.value })}
              />
              <small>
                {field.description}
                {field.kind === 'string-list' ? ' Enter one value per line.' : ''}
              </small>
            </>
          )}
        </label>
      ))}
    </div>
  );
}
function CapabilitySelection({
  items,
  selected,
  onToggle,
}: {
  items: ConnectionCapability[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <h3>Capabilities</h3>
      {items.length ? (
        <>
          <p className="workspace-muted">
            These are controller-mediated mutations, separately approved from sandbox egress.
            Selection records intent for review; this release does not activate capabilities during
            connection creation.
          </p>
          {items.map((item) => (
            <label className="connections-capability" key={item.id}>
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={() => onToggle(item.id)}
              />
              <span>
                <strong>{item.label}</strong>
                <small>
                  {item.description} Approval: {item.approval}.
                </small>
              </span>
            </label>
          ))}
        </>
      ) : (
        <p className="workspace-muted">This service exposes no reviewed mutation capabilities.</p>
      )}
    </div>
  );
}
function Assignments({
  accounts,
  selected,
  onToggle,
}: {
  accounts: string[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <h3>Assignments</h3>
      <fieldset className="connections-profiles">
        <legend>Eligible profiles for new conversations</legend>
        {accounts.length ? (
          accounts.map((id) => (
            <label className="connections-profile-option" key={id}>
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={() => onToggle(id)}
              />{' '}
              {id}
            </label>
          ))
        ) : (
          <p className="workspace-muted">No profiles are eligible for managed access.</p>
        )}
      </fieldset>
      <p className="workspace-muted">
        Retained sandboxes do not gain this connection automatically.
      </p>
    </div>
  );
}
function Review({
  template,
  label,
  scope,
  capabilities,
  accounts,
}: {
  template: ConnectionTemplate;
  label: string;
  scope: Record<string, string | string[]>;
  capabilities: ConnectionCapability[];
  accounts: string[];
}) {
  return (
    <div className="connections-review">
      <h3>Effective access review</h3>
      <p>
        <strong>{label}</strong> uses {template.label} v{template.version} with{' '}
        <strong className={`connections-risk connections-risk--${template.risk}`}>
          {riskCopy[template.risk]}
        </strong>
        .
      </p>
      <dl>
        <dt>Sandbox data access</dt>
        <dd>{template.description}</dd>
        <dt>Configured scope</dt>
        <dd>
          {Object.entries(scope).length
            ? Object.entries(scope)
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                .join('; ')
            : 'Template-defined only'}
        </dd>
        <dt>Mutation capabilities</dt>
        <dd>
          {capabilities.length
            ? capabilities.map((item) => item.label).join(', ')
            : 'None selected'}
        </dd>
        <dt>Assigned profiles</dt>
        <dd>{accounts.join(', ') || 'None'}</dd>
      </dl>
      <p className="workspace-muted">
        A candidate provider is verified before activation. Secret values are intentionally not
        shown.
      </p>
    </div>
  );
}

function ConnectionCard({
  connection,
  template,
  accounts,
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
  ) => Promise<void>;
  onAudit: (id: string) => Promise<void>;
}) {
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const credentialFields = template?.credentialFields ?? [];
  return (
    <article className="workspace-record connections-record">
      <div>
        <strong>{connection.label}</strong>
        <small>
          {template ? `${template.label} v${connection.templateVersion}` : connection.templateId} ·{' '}
          {connection.identity ?? 'Identity not verified'} · last tested{' '}
          {time(connection.verifiedAt)}
        </small>
        <small>
          {connection.endpoint} · {status(connection)}
        </small>
        {Object.keys(connection.publicConfig).length > 0 && (
          <small>
            Effective scope:{' '}
            {Object.entries(connection.publicConfig)
              .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
              .join('; ')}
          </small>
        )}
        <fieldset className="connections-profiles">
          <legend>Profiles with access</legend>
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
          className="connections-danger"
          disabled={busy !== null || connection.status === 'revoked'}
          onClick={() => {
            if (requireReauthorization())
              void onAction(
                `revoke:${connection.id}`,
                () => revokeConnection({ id: connection.id, revision: connection.revision, csrf }),
                'Revocation confirmed. Revoke the upstream credential separately if needed.',
              );
          }}
        >
          Revoke
        </button>
        <button
          className="connections-danger"
          disabled={busy !== null}
          onClick={() => {
            setRemovalError('');
            setRemovalOpen(true);
          }}
        >
          Remove connection
        </button>
        <button
          disabled={busy === `audit:${connection.id}`}
          onClick={() => void onAudit(connection.id)}
        >
          Show audit
        </button>
      </div>
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
            if (!requireReauthorization() || !secretValid(credentialFields, rotationCredentials))
              return;
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
