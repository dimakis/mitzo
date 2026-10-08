import type { ConnectionCredentialField, ConnectionTemplate } from '../types/connections';
import { riskCopy, templateKey, singleChoiceCustomFields } from '../lib/connections-form';

export function ServiceCatalog({
  templates,
  onChoose,
}: {
  templates: ConnectionTemplate[];
  onChoose: (template: ConnectionTemplate) => void;
}) {
  const description = (template: ConnectionTemplate) =>
    ({
      'jira-readonly': 'Read issues and project details.',
      'github-readonly': 'Read selected repositories.',
      'custom-rest-readonly': 'Read a service with custom access rules.',
    })[template.id] ?? template.description;
  return (
    <div
      className="access-row-group connections-catalog"
      role="list"
      aria-label="Connection services"
    >
      {templates.map((template) => (
        <article
          className="access-row connections-template"
          role="listitem"
          key={templateKey(template)}
        >
          <span className="access-row-icon services" aria-hidden="true">
            ↗
          </span>
          <div className="access-row-copy">
            <h3>{template.label}</h3>
            <p>{description(template)}</p>
          </div>
          {template.available ? (
            <button className="access-row-action" type="button" onClick={() => onChoose(template)}>
              Choose {template.label}
            </button>
          ) : (
            <span className="connections-unavailable">Coming soon</span>
          )}
        </article>
      ))}
      {!templates.length && <p className="connections-empty">No services are available to add.</p>}
    </div>
  );
}

export function SecretField({
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
export function Authentication({
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
  const labelInvalid = !label.trim();
  return (
    <div>
      <h3>{template.label}</h3>
      <label className="connections-field">
        Connection label
        <input
          aria-label="Connection label"
          aria-invalid={labelInvalid}
          aria-describedby={labelInvalid ? 'connection-label-error' : undefined}
          maxLength={100}
          value={label}
          onChange={(event) => onLabel(event.target.value)}
        />
      </label>
      {labelInvalid && (
        <p id="connection-label-error" role="alert">
          Enter a connection label before continuing.
        </p>
      )}
      <p className="workspace-muted">
        Your token stays on this page until you submit. It is cleared after submission or when you
        leave setup.
      </p>
      {template.credentialFields.map((field) => (
        <SecretField
          key={field.key}
          field={field}
          value={credentials[field.key] ?? ''}
          onChange={(value) => onCredentials({ ...credentials, [field.key]: value })}
        />
      ))}
      <ProviderGuidance guidance={template.guidance} />
    </div>
  );
}
function ProviderGuidance({
  guidance,
}: {
  guidance?: { body: string; href: string; linkLabel: string };
}) {
  if (!guidance) return null;
  const href = safeHelpUrl(guidance.href);
  return (
    <p className="workspace-muted">
      {guidance.body}{' '}
      {href && (
        <a href={href} target="_blank" rel="noreferrer">
          {guidance.linkLabel}
        </a>
      )}
    </p>
  );
}
function safeHelpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
export function Scope({
  template,
  values,
  onValues,
}: {
  template: ConnectionTemplate;
  values: Record<string, string>;
  onValues: (next: Record<string, string>) => void;
}) {
  const updateCustomChoice = (key: string, choice: string) => {
    const next = { ...values, [key]: choice };
    if (template.id !== 'custom-rest-readonly') return onValues(next);
    if (key === 'protocol') {
      if (choice === 'graphql')
        Object.assign(next, { methods: 'GRAPHQL_QUERY', paths: '/graphql' });
      else Object.assign(next, { methods: 'GET', paths: '' });
    }
    if (key === 'credentialStyle')
      Object.assign(
        next,
        choice === 'bearer-token'
          ? { credentialLocation: 'header', credentialName: 'authorization' }
          : { credentialLocation: 'header', credentialName: 'x-api-key' },
      );
    if (key === 'credentialLocation' && next.credentialStyle === 'bearer-token')
      Object.assign(next, { credentialLocation: 'header', credentialName: 'authorization' });
    if (key === 'credentialLocation' && next.credentialStyle === 'api-token')
      Object.assign(next, { credentialName: choice === 'header' ? 'x-api-key' : 'api_key' });
    onValues(next);
  };
  if (!template.connectionFields.length)
    return (
      <div>
        <p className="workspace-muted">
          This reviewed template has no browser-configurable scope. Sandbox egress remains
          constrained by the template.
        </p>
      </div>
    );
  return (
    <div>
      {template.connectionFields.map((field) => (
        <div className="connections-field" key={field.key}>
          {field.kind === 'enum-list' ? (
            <fieldset className="connections-profiles">
              <legend>
                {field.label}
                <small>{field.description}</small>
              </legend>
              {field.choices?.map((choice) => (
                <label className="connections-profile-option" key={choice}>
                  <input
                    type={singleChoiceCustomFields.has(field.key) ? 'radio' : 'checkbox'}
                    name={
                      singleChoiceCustomFields.has(field.key)
                        ? `connection-${field.key}`
                        : undefined
                    }
                    checked={
                      singleChoiceCustomFields.has(field.key)
                        ? values[field.key] === choice
                        : (values[field.key] ?? '').split('\n').includes(choice)
                    }
                    onChange={() => {
                      if (singleChoiceCustomFields.has(field.key)) {
                        updateCustomChoice(field.key, choice);
                        return;
                      }
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
              <label htmlFor={`connection-field-${field.key}`}>{field.label}</label>
              {field.kind === 'string-list' ? (
                <textarea
                  id={`connection-field-${field.key}`}
                  aria-label={field.label}
                  required={field.required}
                  rows={4}
                  value={values[field.key] ?? ''}
                  onChange={(event) => onValues({ ...values, [field.key]: event.target.value })}
                />
              ) : (
                <input
                  id={`connection-field-${field.key}`}
                  aria-label={field.label}
                  type={field.kind === 'email' ? 'email' : field.kind === 'url' ? 'url' : 'text'}
                  required={field.required}
                  value={values[field.key] ?? ''}
                  onChange={(event) => onValues({ ...values, [field.key]: event.target.value })}
                />
              )}
              <small>
                {field.description}
                {field.kind === 'string-list' ? ' Enter one value per line.' : ''}
              </small>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
export function Assignments({
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
      <h3>AI accounts with access</h3>
      <fieldset className="connections-profiles">
        <legend>Choose AI accounts</legend>
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
          <p className="workspace-muted">
            No AI accounts are eligible yet. You can create this connection unassigned and assign
            access later.
          </p>
        )}
      </fieldset>
      <p className="workspace-muted">
        Service access is checked when a chat connects. Existing chats can request approved GitHub
        publishing separately.
      </p>
    </div>
  );
}
export function Review({
  template,
  label,
  scope,
  accounts,
}: {
  template: ConnectionTemplate;
  label: string;
  scope: Record<string, string | string[]>;
  accounts: string[];
}) {
  return (
    <div className="connections-review">
      <h3>{label}</h3>
      <dl>
        <dt>Service</dt>
        <dd>{template.label}</dd>
        <dt>Permissions</dt>
        <dd>{riskCopy[template.risk]}</dd>
        {Object.entries(scope).map(([key, value]) => (
          <div className="connections-review-fact" key={key}>
            <dt>{template.connectionFields.find((field) => field.key === key)?.label ?? key}</dt>
            <dd>{Array.isArray(value) ? value.join(', ') : value}</dd>
          </div>
        ))}
        <dt>AI accounts with access</dt>
        <dd>{accounts.join(', ') || 'No AI accounts selected. You can assign access later.'}</dd>
      </dl>
      {!!template.capabilityTemplates.length && (
        <p className="workspace-muted">
          Additional actions are off. Enable approved actions after connecting; each use requires
          approval.
        </p>
      )}
      <p className="workspace-muted">
        Mitzo verifies credentials before connecting. Each chat checks access separately.
      </p>
      {template.id === 'custom-rest-readonly' && <CustomPolicyPreview scope={scope} />}
    </div>
  );
}

function CustomPolicyPreview({ scope }: { scope: Record<string, string | string[]> }) {
  const endpoint = typeof scope.endpoint === 'string' ? scope.endpoint : '';
  const port = typeof scope.port === 'string' ? scope.port : '443';
  const protocol = typeof scope.protocol === 'string' ? scope.protocol : 'rest';
  const methods = Array.isArray(scope.methods) ? scope.methods : [];
  const paths = Array.isArray(scope.paths) ? scope.paths : [];
  const rules = methods.flatMap((method) => paths.map((path) => `${method} ${path}`));
  return (
    <details className="connections-policy-preview">
      <summary>Technical policy preview</summary>
      <p>
        HTTPS {endpoint || 'endpoint'}:{port} · {protocol} inspection · redirects denied · all
        A/AAAA answers are pinned before provisioning and checked before every use.
      </p>
      <p>Effective rules: {rules.join(', ') || 'none'}.</p>
      <p>
        Warnings: wildcard hosts/paths are denied; credentials are one-shot and never forwarded on
        redirects.
      </p>
    </details>
  );
}
