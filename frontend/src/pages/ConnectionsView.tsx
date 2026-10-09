import { Link } from 'react-router-dom';
import { CredentialConnectionsPanel } from '../components/CredentialConnectionsPanel';
import { SymposiumPersonalConnections } from '../components/SymposiumPersonalConnections';
import { OpenAIKeyControls } from '../components/OpenAIKeyControls';
import { OpenAIAccountEnrollment } from '../components/OpenAIAccountEnrollment';
import { GoogleWorkspaceControls } from '../components/GoogleWorkspaceControls';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import {
  createConnection,
  ConnectionCreationFailure,
  getConnectionAudit,
  getConnectionTemplates,
  getConnections,
  reauthorize,
} from '../lib/connections-api';
import {
  scopeFieldValid,
  scopeValid,
  scopeValues,
  secretValid,
  templateKey,
} from '../lib/connections-form';
import {
  Assignments,
  Authentication,
  Review,
  Scope,
  ServiceCatalog,
} from '../components/ConnectionSetupFields';
import { ConnectionCard } from '../components/ConnectionManagement';
import type {
  ConnectionAuditEntry,
  ConnectionsCatalog,
  ConnectionTemplate,
  ConnectionTemplateCatalog,
  ManagedConnection,
  ConnectionsViewProps,
} from '../types/connections';

type WizardStep = 'service' | 'authenticate' | 'assignments' | 'review';
const steps: WizardStep[] = ['authenticate', 'assignments', 'review'];
const stepLabel: Record<WizardStep, string> = {
  service: 'Choose a connection',
  authenticate: 'Connect',
  assignments: 'Access',
  review: 'Review',
};
export function ConnectionsView({ mode = 'add', connectionId }: ConnectionsViewProps = {}) {
  const [data, setData] = useState<ConnectionsCatalog | null>(null);
  const [connectionRefreshEpoch, setConnectionRefreshEpoch] = useState(0);
  const [templates, setTemplates] = useState<ConnectionTemplateCatalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [connectionsRefreshing, setConnectionsRefreshing] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [csrf, setCsrf] = useState('');
  const [csrfExpiresAt, setCsrfExpiresAt] = useState(0);
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [personalChosen, setPersonalChosen] = useState(false);
  const [personalCreationUncertain, setPersonalCreationUncertain] = useState(false);
  const [personalCreationBusy, setPersonalCreationBusy] = useState(false);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('');
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<string[]>([]);
  const [step, setStep] = useState<WizardStep>('service');
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<ManagedConnection | null>(null);
  const [recovery, setRecovery] = useState<ConnectionCreationFailure | null>(null);
  const [audit, setAudit] = useState<Record<string, ConnectionAuditEntry[]>>({});
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotationCredentials, setRotationCredentials] = useState<Record<string, string>>({});
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const authorizationField = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const refreshGeneration = useRef(0);
  const latestConnectionRefresh = useRef<Promise<void>>(Promise.resolve());
  const resetWizard = useCallback(() => {
    setSelectedTemplateKey('');
    setLabel('');
    setScope({});
    setCredentials({});
    setAccounts([]);
    setStep('service');
    setAuthorizationOpen(false);
    setPassphrase('');
  }, []);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setConnectionsRefreshing(true);
    setTemplateError('');
    const connectionsRefresh = getConnections().then(
      (value) => {
        if (generation === refreshGeneration.current) {
          setData(value);
          setLoadError('');
          setConnectionsRefreshing(false);
          setConnectionRefreshEpoch((current) => current + 1);
        }
      },
      (reason) => {
        if (generation === refreshGeneration.current) {
          setLoadError(reason instanceof Error ? reason.message : 'Unable to load connections.');
          setConnectionsRefreshing(false);
        }
      },
    );
    latestConnectionRefresh.current = connectionsRefresh;
    void getConnectionTemplates().then(
      (value) => {
        if (generation === refreshGeneration.current) setTemplates(value);
      },
      () => {
        if (generation === refreshGeneration.current)
          setTemplateError(
            'Connection setup is temporarily unavailable. Existing connections remain manageable.',
          );
      },
    );
    await connectionsRefresh;
    if (generation !== refreshGeneration.current) await latestConnectionRefresh.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    if (
      mode === 'add' ||
      mode === 'manage' ||
      mode === 'google' ||
      mode === 'legacy' ||
      mode === 'openai' ||
      mode === 'openai-add'
    )
      void refresh();
  }, [refresh, mode]);
  useEffect(() => {
    stepHeading.current?.focus();
  }, [step, personalChosen, created, recovery]);
  useEffect(() => {
    if (authorizationOpen) authorizationField.current?.focus();
  }, [authorizationOpen]);
  useEffect(() => {
    if (
      selectedTemplateKey &&
      templates &&
      !templates.templates.some(
        (item) => templateKey(item) === selectedTemplateKey && item.available,
      )
    ) {
      resetWizard();
      setMessage('This service is no longer available. Choose another connection.');
      setFailed(true);
    }
  }, [resetWizard, selectedTemplateKey, templates]);
  const setupTemplates = templateError ? null : templates;
  const template = useMemo(
    () =>
      setupTemplates?.templates.find(
        (item) => templateKey(item) === selectedTemplateKey && item.available,
      ) ?? null,
    [selectedTemplateKey, setupTemplates],
  );
  useEffect(() => {
    if (!data || !template) return;
    const eligible = data.eligibleAccountsByTemplate?.[template.id] ?? data.eligibleAccounts;
    if (!accounts.some((id) => !eligible.includes(id))) return;
    setAccounts(accounts.filter((id) => eligible.includes(id)));
    setAuthorizationOpen(false);
    setPassphrase('');
    setMessage(
      (current) =>
        `${current ? `${current} ` : ''}Eligible AI accounts changed. Review access before connecting.`,
    );
    setStep(secretValid(template.credentialFields, credentials) ? 'assignments' : 'authenticate');
  }, [data, template, accounts, credentials]);
  const run = async (
    name: string,
    action: () => Promise<unknown>,
    success: string,
    onFailure?: () => void,
    onSuccess?: () => void,
  ): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(name);
    setMessage('');
    setFailed(false);
    try {
      await action();
      setMessage(success);
      onSuccess?.();
      await refresh();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The request failed. Refresh and retry.');
      setFailed(true);
      onFailure?.();
      await refresh();
      return false;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  const requireReauthorization = (force = false) => {
    if (connectionsRefreshing || loadError) {
      setMessage('Refresh connection details before changing access.');
      setFailed(true);
      return false;
    }
    if (!force && csrf && csrfExpiresAt > Date.now()) return true;
    setCsrf('');
    setCsrfExpiresAt(0);
    setAuthorizationOpen(true);
    setPassphrase('');
    setMessage(
      mode === 'openai'
        ? 'Confirm your identity to continue.'
        : 'Confirm your identity, then retry the change.',
    );
    setFailed(false);
    return false;
  };
  const authorizeChanges = () =>
    void run(
      'reauthorize',
      async () => {
        const next = await reauthorize(passphrase);
        if (next.expiresAt <= Date.now())
          throw new Error('Authorization expired. Enter your passphrase again.');
        setCsrf(next.csrf);
        setCsrfExpiresAt(next.expiresAt);
        setPassphrase('');
        setAuthorizationOpen(false);
      },
      mode === 'openai' ? '' : 'Identity confirmed. You can retry the change.',
    );
  const toggle = (id: string, values: string[], setter: (next: string[]) => void) =>
    setter(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const chooseTemplate = (next: ConnectionTemplate) => {
    if (!next.available) return;
    resetWizard();
    setMessage('');
    setFailed(false);
    setSelectedTemplateKey(templateKey(next));
    setLabel(next.label);
    setScope(
      next.id === 'custom-rest-readonly'
        ? {
            port: '443',
            protocol: 'rest',
            methods: 'GET\nHEAD\nOPTIONS',
            credentialStyle: 'bearer-token',
            credentialLocation: 'header',
            credentialName: 'authorization',
            binaries: 'curl',
            attachmentMode: 'automatic',
          }
        : {},
    );
    setStep('authenticate');
  };
  const submit = async (authorize = false) => {
    if (
      inFlight.current ||
      !template ||
      !data ||
      connectionsRefreshing ||
      loadError ||
      !label.trim() ||
      !secretValid(template.credentialFields, credentials) ||
      !scopeValid(template, scope)
    )
      return;
    if (!authorize && !requireReauthorization()) return;
    inFlight.current = true;
    setMessage('');
    setFailed(false);
    const generation = refreshGeneration.current;
    let submitted = false;
    try {
      let proof = csrf;
      if (authorize) {
        setBusy('reauthorize');
        const next = await reauthorize(passphrase);
        if (!mounted.current) return;
        setPassphrase('');
        if (next.expiresAt <= Date.now())
          throw new Error('Authorization expired. Enter your passphrase again.');
        proof = next.csrf;
        setCsrf(proof);
        setCsrfExpiresAt(next.expiresAt);
      }
      if (generation !== refreshGeneration.current)
        throw new Error('Connection details changed. Review setup and try again.');
      setAuthorizationOpen(false);
      setBusy('create');
      const oneShot = credentials;
      setCredentials({});
      submitted = true;
      const connection = await createConnection({
        templateId: template.id,
        templateVersion: template.version,
        label: label.trim(),
        fields: scopeValues(template, scope),
        credentials: oneShot,
        accountIds: accounts,
        csrf: proof,
      });
      setCreated(connection);
      setAccounts([]);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Connection could not be verified. Try again.',
      );
      setFailed(true);
      setPassphrase('');
      if (error instanceof ConnectionCreationFailure && error.authorizationRequired) {
        setCsrf('');
        setCsrfExpiresAt(0);
      }
      if (submitted) {
        setCredentials({});
        if (error instanceof ConnectionCreationFailure && !error.retrySetup) setRecovery(error);
        else setStep('authenticate');
      }
    } finally {
      if (mounted.current) await refresh();
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const managed =
    data?.connections.filter((item) => !connectionId || item.id === connectionId) ?? [];
  const title =
    mode === 'openai-add'
      ? 'Add OpenAI API account'
      : mode === 'openai'
        ? 'Manage OpenAI API'
        : mode === 'add'
          ? 'Add connection'
          : mode === 'personal'
            ? 'Manage ChatGPT account'
            : mode === 'google'
              ? 'Manage Google Workspace'
              : mode === 'keychain'
                ? 'Apple Keychain connections'
                : mode === 'api'
                  ? 'API connections'
                  : mode === 'legacy'
                    ? 'Provider details'
                    : 'Manage connection';
  const identityFields = template?.connectionFields.filter((field) => field.kind === 'email') ?? [];
  const resourceFields = template?.connectionFields.filter((field) => field.kind !== 'email') ?? [];
  const stepValid =
    template &&
    (step === 'authenticate'
      ? label.trim() &&
        secretValid(template.credentialFields, credentials) &&
        identityFields.every((field) => scopeFieldValid(field, scope[field.key] ?? ''))
      : scopeValid(template, scope));
  return (
    <main className="workspace-page connections-page connections-focused-page">
      <Link className="connections-back workspace-text-link" to="/connections-access">
        Connections
      </Link>
      <WorkspacePageHeading
        title={title}
        description={
          mode === 'add' && step === 'service' && !personalChosen && !created
            ? 'Choose an AI account or a service to connect to Mitzo.'
            : undefined
        }
      />
      {message && (
        <p className="connections-notice" role={failed ? 'alert' : 'status'}>
          {message}
        </p>
      )}
      {mode === 'add' ? (
        recovery ? (
          <section className="connections-complete" aria-label="Connection recovery">
            <h2 ref={stepHeading} tabIndex={-1}>
              Review connection status
            </h2>
            <p>
              {recovery.connectionId
                ? 'A saved connection needs review. Open it to check its status and finish setup.'
                : 'Check Connections before adding this service again. It may have been saved even though the result could not be confirmed.'}
            </p>
            <div className="connections-wizard-actions">
              {recovery.connectionId && (
                <Link
                  className="workspace-primary"
                  to={`/connections?manage=service&connection=${encodeURIComponent(recovery.connectionId)}`}
                >
                  Review saved connection
                </Link>
              )}
              <Link className="workspace-text-link" to="/connections-access">
                Back to Connections
              </Link>
            </div>
          </section>
        ) : created ? (
          <section className="connections-complete" aria-label="Connection result">
            <h2 ref={stepHeading} tabIndex={-1}>
              {created.status === 'active'
                ? `${created.label} connected`
                : `${created.label} needs attention`}
            </h2>
            <p>
              {created.status === 'active'
                ? 'Credentials verified. Review access in Connections before using this service in a chat.'
                : 'Open the connection to review its status and finish recovery.'}
            </p>
            <p className="workspace-muted">
              {created.desiredAccountIds.length
                ? 'Service access is checked when a chat connects. Existing chats can request approved GitHub publishing separately.'
                : 'No AI accounts are assigned yet. Open Manage access when you’re ready.'}
            </p>
            <div className="connections-wizard-actions">
              <Link
                className="workspace-primary"
                to={`/connections-access?connected=${encodeURIComponent(created.id)}`}
              >
                Back to Connections
              </Link>
              <Link
                className="workspace-text-link"
                to={`/connections?manage=service&connection=${encodeURIComponent(created.id)}`}
              >
                Manage access
              </Link>
            </div>
          </section>
        ) : personalChosen ? (
          <>
            <button
              className="workspace-text-link"
              disabled={personalCreationBusy}
              onClick={() => setPersonalChosen(false)}
            >
              Choose another connection
            </button>
            <SymposiumPersonalConnections
              mode="add"
              creationBlocked={personalCreationUncertain}
              onCreationUncertain={() => setPersonalCreationUncertain(true)}
              onCreationPendingChange={setPersonalCreationBusy}
            />
          </>
        ) : step === 'service' ? (
          <>
            <section className="access-section" aria-labelledby="add-accounts-heading">
              <div className="access-section-heading">
                <h2 id="add-accounts-heading">AI accounts</h2>
              </div>
              <div className="access-row-group">
                <article className="access-row">
                  <span className="access-row-icon accounts" aria-hidden="true">
                    ✧
                  </span>
                  <div className="access-row-copy">
                    <h3>ChatGPT</h3>
                    <p>Use a personal ChatGPT subscription.</p>
                  </div>
                  <button
                    className="access-row-action"
                    onClick={() => {
                      setMessage('');
                      setPersonalChosen(true);
                    }}
                  >
                    Choose ChatGPT
                  </button>
                </article>
                {data?.openAIAccountsManaged && !loadError && !connectionsRefreshing && (
                  <article className="access-row">
                    <span className="access-row-icon accounts" aria-hidden="true">
                      ✧
                    </span>
                    <div className="access-row-copy">
                      <h3>OpenAI API</h3>
                      <p>Add a new work account for new chats.</p>
                    </div>
                    <Link className="access-row-action" to="/connections?manage=openai-add">
                      Choose OpenAI API
                    </Link>
                  </article>
                )}
              </div>
            </section>
            <section className="access-section" aria-labelledby="add-services-heading">
              <div className="access-section-heading">
                <h2 id="add-services-heading">Services</h2>
              </div>
              <div className="access-row-group">
                <article className="access-row">
                  <span className="access-row-icon" aria-hidden="true">
                    ⌘
                  </span>
                  <div className="access-row-copy">
                    <h3>Authenticated API</h3>
                    <p>
                      Connect any HTTPS API with a token or password. Each chat asks for approval.
                    </p>
                  </div>
                  <Link className="access-row-action" to="/connections?manage=api">
                    Choose API connection
                  </Link>
                </article>
              </div>
              {setupTemplates ? (
                <ServiceCatalog templates={setupTemplates.templates} onChoose={chooseTemplate} />
              ) : (
                <div className="access-source-notice" role={templateError ? 'alert' : 'status'}>
                  <p>{templateError || 'Loading services…'}</p>
                  {templateError && (
                    <button className="workspace-text-link" onClick={() => void refresh()}>
                      Retry setup
                    </button>
                  )}
                </div>
              )}
            </section>
          </>
        ) : template ? (
          <section className="connections-setup" aria-label={`Connect ${template.label}`}>
            <p className="connections-progress">
              Step {steps.indexOf(step) + 1} of {steps.length} · {stepLabel[step]}
            </p>
            <h2 className="connections-step-heading" ref={stepHeading} tabIndex={-1}>
              {stepLabel[step]}
            </h2>
            {loadError && (
              <p className="connections-notice" role="alert">
                {loadError} <button onClick={() => void refresh()}>Retry access</button>
              </p>
            )}
            {step === 'authenticate' && (
              <>
                <Authentication
                  template={template}
                  label={label}
                  onLabel={setLabel}
                  credentials={credentials}
                  onCredentials={setCredentials}
                />
                {!!identityFields.length && (
                  <Scope
                    template={{ ...template, connectionFields: identityFields }}
                    values={scope}
                    onValues={setScope}
                  />
                )}
              </>
            )}
            {step === 'assignments' && (
              <>
                {!!resourceFields.length && (
                  <Scope
                    template={{ ...template, connectionFields: resourceFields }}
                    values={scope}
                    onValues={setScope}
                  />
                )}
                {data ? (
                  <Assignments
                    accounts={
                      data.eligibleAccountsByTemplate?.[template.id] ?? data.eligibleAccounts
                    }
                    selected={accounts}
                    onToggle={(id) => toggle(id, accounts, setAccounts)}
                  />
                ) : (
                  <p role="status">Loading eligible AI accounts…</p>
                )}
              </>
            )}
            {step === 'review' && (
              <Review
                template={template}
                label={label}
                scope={scopeValues(template, scope)}
                accounts={accounts}
              />
            )}
            {step === 'review' && authorizationOpen && (
              <Reauthorization
                busy={busy}
                passphrase={passphrase}
                onPassphrase={setPassphrase}
                inputRef={authorizationField}
                actionLabel={`Authorize and connect ${template.label}`}
                onSubmit={() => void submit(true)}
                onCancel={() => {
                  setAuthorizationOpen(false);
                  setPassphrase('');
                }}
              />
            )}
            <div className="connections-wizard-actions" hidden={authorizationOpen}>
              <button
                disabled={busy !== null}
                onClick={() => {
                  setAuthorizationOpen(false);
                  setPassphrase('');
                  if (step === 'authenticate') resetWizard();
                  else setStep(steps[steps.indexOf(step) - 1]!);
                }}
              >
                Back
              </button>
              {step !== 'review' ? (
                <button
                  className="workspace-primary"
                  disabled={
                    busy !== null ||
                    !stepValid ||
                    (step === 'assignments' && (!data || !!loadError || connectionsRefreshing))
                  }
                  onClick={() => setStep(steps[steps.indexOf(step) + 1]!)}
                >
                  Continue
                </button>
              ) : (
                !authorizationOpen && (
                  <button
                    className="workspace-primary"
                    disabled={busy !== null || !data || !!loadError || connectionsRefreshing}
                    onClick={() => void submit()}
                  >
                    {busy === 'create'
                      ? 'Verifying connection…'
                      : `Verify and connect ${template.label}`}
                  </button>
                )
              )}
            </div>
          </section>
        ) : (
          <div role="alert" className="access-source-notice">
            <p>{templateError || 'This service is unavailable.'}</p>
            <button onClick={() => void refresh()}>Retry setup</button>
            <button onClick={resetWizard}>Choose another connection</button>
          </div>
        )
      ) : mode === 'personal' ? (
        <SymposiumPersonalConnections mode="manage" connectionId={connectionId} />
      ) : mode === 'keychain' || mode === 'api' ? (
        <CredentialConnectionsPanel
          connectionId={connectionId}
          initialTemplate={mode === 'api' ? 'custom' : 'home-assistant'}
        />
      ) : (
        <>
          {loadError && (
            <p className="connections-notice" role="alert">
              {loadError} <button onClick={() => void refresh()}>Retry</button>
            </p>
          )}
          {!data && !loadError && <p role="status">Loading connection…</p>}
          {authorizationOpen && (
            <Reauthorization
              busy={busy}
              passphrase={passphrase}
              onPassphrase={setPassphrase}
              inputRef={authorizationField}
              onSubmit={authorizeChanges}
              onCancel={() => {
                setAuthorizationOpen(false);
                setPassphrase('');
              }}
            />
          )}
          {data &&
            mode === 'google' &&
            (data.googleWorkspaceManaged ? (
              <GoogleWorkspaceControls
                csrf={csrf}
                authorized={!!csrf && csrfExpiresAt > Date.now()}
                onReauthorizationNeeded={requireReauthorization}
              />
            ) : (
              <p>Google Workspace is not configured.</p>
            ))}
          {data &&
            mode === 'openai-add' &&
            (data.openAIAccountsManaged && !loadError ? (
              <OpenAIAccountEnrollment
                csrf={csrf}
                expiresAt={csrfExpiresAt}
                authorized={!!csrf && csrfExpiresAt > Date.now() && !connectionsRefreshing}
                onReauthorizationNeeded={requireReauthorization}
              />
            ) : (
              <p>Adding OpenAI API accounts is unavailable.</p>
            ))}
          {data &&
            mode === 'openai' &&
            (data.openAIKeysManaged ? (
              <OpenAIKeyControls
                accountId={connectionId}
                csrf={csrf}
                authorized={!!csrf && csrfExpiresAt > Date.now()}
                onReauthorizationNeeded={() => requireReauthorization(true)}
              />
            ) : (
              <p>OpenAI API key management is not configured.</p>
            ))}
          {data && mode === 'manage' && (
            <>
              {connectionsRefreshing && <p role="status">Refreshing connection details…</p>}
              <button className="workspace-text-link" onClick={() => void refresh()}>
                Refresh connection
              </button>
              {templateError && <p className="workspace-muted">{templateError}</p>}
              {!managed.length && (
                <p>
                  This connection is no longer available. Return to Connections to refresh its
                  status.
                </p>
              )}
              {managed.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  template={templates?.templates.find(
                    (item) =>
                      item.id === connection.templateId &&
                      item.version === connection.templateVersion,
                  )}
                  accounts={
                    data.eligibleAccountsByTemplate?.[connection.templateId] ??
                    data.eligibleAccounts
                  }
                  capabilityCatalog={templates?.capabilities ?? []}
                  refreshEpoch={connectionRefreshEpoch}
                  csrf={csrf}
                  busy={busy ?? (loadError || connectionsRefreshing ? 'refresh-required' : null)}
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
                    if (inFlight.current) return;
                    inFlight.current = true;
                    setBusy(`audit:${id}`);
                    try {
                      const entries = await getConnectionAudit(id);
                      setAudit((current) => ({ ...current, [id]: entries }));
                    } catch (error) {
                      setFailed(true);
                      setMessage(
                        error instanceof Error ? error.message : 'Unable to load audit history.',
                      );
                    } finally {
                      inFlight.current = false;
                      setBusy(null);
                    }
                  }}
                />
              ))}
              {!!managed.length && (
                <button
                  className="workspace-text-link"
                  disabled={busy !== null}
                  onClick={() => {
                    setAuthorizationOpen(true);
                    setPassphrase('');
                  }}
                >
                  Authorize changes
                </button>
              )}
            </>
          )}
          {data && mode === 'legacy' && (
            <section className="access-section">
              <h2>Managed by your operator</h2>
              <p>
                {data.legacy
                  .filter((item) => !connectionId || item.id === connectionId)
                  .map((item) => item.label)
                  .join(', ') || 'No provider reported.'}
              </p>
              <p className="workspace-muted">
                Ask your Mitzo operator to change this service’s configuration.
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Reauthorization({
  busy,
  passphrase,
  onPassphrase,
  onSubmit,
  onCancel,
  inputRef,
  actionLabel = 'Reauthorize',
}: {
  busy: string | null;
  passphrase: string;
  onPassphrase: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  actionLabel?: string;
}) {
  return (
    <form
      className="connections-authorization"
      aria-labelledby="reauthorize-heading"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h2 id="reauthorize-heading">Confirm it’s you</h2>
      <p className="workspace-muted">Enter your Mitzo passphrase to authorize this change.</p>
      <label className="connections-field">
        Passphrase
        <input
          ref={inputRef}
          aria-label="Passphrase"
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => onPassphrase(event.target.value)}
        />
      </label>
      <div className="connections-wizard-actions">
        <button className="workspace-primary" disabled={busy !== null || !passphrase}>
          {busy === 'reauthorize'
            ? 'Authorizing…'
            : busy === 'create'
              ? 'Verifying connection…'
              : actionLabel}
        </button>
        <button
          className="workspace-text-link"
          type="button"
          disabled={busy !== null}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
