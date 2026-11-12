import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserId } from '../lib/browser-crypto';
import {
  discoverApiModels,
  enrollOpenAIAccount,
  getOpenAIAccounts,
  OpenAIAccountEnrollmentFailure,
} from '../lib/connections-api';
import type { EnrolledOpenAIAccount } from '../types/connections';

const enmaasModels = ['rits/zai-org/glm-5-3', 'rits/deepseek-ai/DeepSeek-V4.1-Flash-1017'];

function validProviderEndpoint(value: string) {
  const endpoint = value.trim();
  if (!endpoint || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return (
      url.protocol === 'https:' &&
      !!host &&
      url.toString().replace(/\/+$/, '').length <= 2048 &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !host.includes(':') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
      !url.username &&
      !url.password &&
      !endpoint.includes('?') &&
      !endpoint.includes('#')
    );
  } catch {
    return false;
  }
}

export function OpenAIAccountEnrollment({
  csrf,
  authorized,
  expiresAt,
  onReauthorizationNeeded,
}: {
  csrf: string;
  authorized: boolean;
  expiresAt?: number;
  onReauthorizationNeeded: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<EnrolledOpenAIAccount[]>([]);
  const [label, setLabel] = useState('');
  const [projectLabel, setProjectLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState('openai');
  const [endpoint, setEndpoint] = useState('');
  const [catalog, setCatalog] = useState<{ id: string; label: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [explicitModels, setExplicitModels] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [partial, setPartial] = useState(false);
  const discoveryGeneration = useRef(0);
  const invalidateDiscovery = useCallback(() => {
    discoveryGeneration.current++;
  }, []);
  const custom = provider !== 'openai';
  const endpointValid = validProviderEndpoint(endpoint);
  const modelIds = [...new Set([...selected, ...explicitModels.split(/[\s,]+/).filter(Boolean)])];
  const modelsValid =
    modelIds.length > 0 && modelIds.length <= 200 && modelIds.every((id) => id.length <= 256);
  const [billingConfirmed, setBillingConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [created, setCreated] = useState<EnrolledOpenAIAccount | null>(null);
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  const pending = useRef(false);
  const requestId = useRef<string | null>(null);
  const unresolved = accounts.some(
    (account) => account.state === 'connecting' || account.state === 'needs_attention',
  );
  const retrySafe =
    !unresolved &&
    accounts.some(
      (account) => account.requestId === requestId.current && account.state === 'failed',
    );
  const refresh = useCallback(async () => {
    try {
      const status = await getOpenAIAccounts();
      if (!mounted.current) return;
      setEnabled(status.enabled);
      setAccounts(status.accounts);
    } catch {
      if (!mounted.current) return;
      setEnabled(false);
      setMessage('Account status could not be loaded. Check again before adding an account.');
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      invalidateDiscovery();
    };
  }, [refresh, invalidateDiscovery]);
  useEffect(() => {
    if (!authorized || enabled === false || unresolved) {
      discoveryGeneration.current++;
      setDiscovering(false);
      setApiKey('');
      setBillingConfirmed(false);
    }
  }, [authorized, enabled, unresolved]);
  const resetDiscovery = () => {
    discoveryGeneration.current++;
    setDiscovering(false);
    setCatalog([]);
    setSelected([]);
    setPartial(false);
    setBillingConfirmed(false);
    setMessage('');
  };
  const discover = async () => {
    if (discovering || busy || !endpointValid || !apiKey.trim()) return;
    if (!authorized || (expiresAt !== undefined && expiresAt <= Date.now())) {
      setApiKey('');
      onReauthorizationNeeded();
      return;
    }
    const generation = ++discoveryGeneration.current;
    setDiscovering(true);
    setBillingConfirmed(false);
    setMessage('');
    try {
      const result = await discoverApiModels({ csrf, endpoint: endpoint.trim(), apiKey });
      if (!mounted.current || generation !== discoveryGeneration.current) return;
      setCatalog(result.models);
      setSelected([]);
      setPartial(result.partial);
      if (!result.models.length)
        setMessage('The catalog returned no models. Enter explicit model IDs to continue.');
    } catch {
      if (mounted.current && generation === discoveryGeneration.current)
        setMessage(
          'Could not read the provider catalog. Check the endpoint and key, or enter explicit model IDs.',
        );
    } finally {
      if (mounted.current && generation === discoveryGeneration.current) setDiscovering(false);
    }
  };
  const submit = async () => {
    if (pending.current || discovering || reviewRequired || unresolved || created || !enabled)
      return;
    if (!authorized || (expiresAt !== undefined && expiresAt <= Date.now())) {
      setApiKey('');
      setBillingConfirmed(false);
      onReauthorizationNeeded();
      return;
    }
    if (
      !label.trim() ||
      !projectLabel.trim() ||
      !apiKey.trim() ||
      !billingConfirmed ||
      (custom && (!endpointValid || !modelsValid))
    )
      return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    const oneShot = apiKey;
    setApiKey('');
    setBillingConfirmed(false);
    try {
      requestId.current ??= createBrowserId();
      const account = await enrollOpenAIAccount({
        csrf,
        requestId: requestId.current,
        label: label.trim(),
        projectLabel: projectLabel.trim(),
        apiKey: oneShot,
        billingConfirmed: true,
        ...(custom
          ? {
              connection: {
                endpoint: endpoint.trim(),
                protocol: 'responses',
                qualification: {
                  source: 'operator',
                  streaming: true,
                  toolCalls: true,
                  continuation: true,
                  cancellation: true,
                },
              },
              models: modelIds.map((id) => ({
                id,
                label: catalog.find((model) => model.id === id)?.label || id,
              })),
            }
          : {}),
      });
      if (!mounted.current) return;
      if (account.state === 'ready') setCreated(account);
      else {
        setReviewRequired(true);
        setMessage('Enrollment needs attention. Check account status before trying again.');
      }
    } catch (error) {
      if (mounted.current) {
        if (error instanceof OpenAIAccountEnrollmentFailure && error.retrySetup) {
          requestId.current = null;
          setMessage(error.message);
        } else {
          setReviewRequired(true);
          setMessage('Could not confirm enrollment. Review account status before trying again.');
        }
      }
    } finally {
      if (mounted.current) {
        await refresh();
        setBusy(false);
      }
      pending.current = false;
    }
  };
  return (
    <section
      className="connections-card openai-account-enrollment"
      aria-label="Add a new AI API account"
    >
      <h2>Add a new AI API account</h2>
      <p>
        Existing tasks keep their current account. Select this new account when starting a new chat.
      </p>
      {message && <p role="alert">{message}</p>}
      {enabled === null ? (
        <p role="status">Loading account setup…</p>
      ) : created ? (
        <p role="status">{created.label} is ready for new chats.</p>
      ) : !enabled ? (
        <p>Adding AI API accounts is unavailable.</p>
      ) : unresolved ? (
        <p role="status">
          A previous enrollment must be reviewed before adding another account. Check its status and
          ask the operator to reconcile the saved operation.
        </p>
      ) : reviewRequired ? (
        <h3>Review enrollment status</h3>
      ) : !authorized ? (
        <button className="workspace-primary" onClick={onReauthorizationNeeded}>
          Confirm identity to add an account
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="connections-field">
            Provider
            <select
              value={provider}
              disabled={busy || discovering}
              onChange={(event) => {
                const value = event.target.value;
                resetDiscovery();
                setProvider(value);
                setEndpoint(value === 'enmaas' ? 'https://api.enmaas.devshift.net/v1' : '');
                setExplicitModels(value === 'enmaas' ? enmaasModels.join('\n') : '');
                setApiKey('');
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="enmaas">EnMaaS</option>
              <option value="custom">Custom Responses API</option>
            </select>
          </label>
          {custom && (
            <label className="connections-field">
              API base URL
              <input
                type="url"
                required
                value={endpoint}
                maxLength={2048}
                aria-invalid={endpoint.trim().length > 0 && !endpointValid}
                aria-describedby="api-provider-endpoint-help"
                disabled={busy}
                onChange={(event) => {
                  resetDiscovery();
                  setExplicitModels('');
                  setEndpoint(event.target.value);
                }}
              />
            </label>
          )}
          <label className="connections-field">
            Account label
            <input
              value={label}
              maxLength={120}
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="connections-field">
            Intended work project name
            <input
              value={projectLabel}
              maxLength={120}
              disabled={busy}
              onChange={(event) => setProjectLabel(event.target.value)}
            />
          </label>
          <p className="workspace-muted">
            This name records your intended use. It does not verify the key’s project identity.
          </p>
          <label className="connections-field">
            API key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={16384}
              value={apiKey}
              disabled={busy}
              onChange={(event) => {
                resetDiscovery();
                setApiKey(event.target.value);
              }}
            />
          </label>
          {custom && (
            <>
              <p className="workspace-muted" id="api-provider-endpoint-help">
                Use a public HTTPS provider hostname without credentials, query or fragment.
              </p>
              <p className="workspace-muted">
                Uses the Codex engine with a Responses-compatible API. Get models sends this key to
                the selected provider for a catalog read; it makes no inference call.
              </p>
              <button
                type="button"
                className="workspace-text-link"
                disabled={busy || discovering || !endpointValid || !apiKey.trim()}
                onClick={() => void discover()}
              >
                {discovering ? 'Getting models…' : 'Get models'}
              </button>
              {partial && (
                <p role="status">
                  This is a partial catalog. Select models or enter additional model IDs.
                </p>
              )}
              {catalog.length > 0 && (
                <label className="connections-field">
                  Available models
                  <select
                    multiple
                    size={Math.min(catalog.length, 8)}
                    value={selected}
                    disabled={busy || discovering}
                    onChange={(event) => {
                      setBillingConfirmed(false);
                      setSelected(
                        Array.from(event.target.selectedOptions, (option) => option.value),
                      );
                    }}
                  >
                    {catalog.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="connections-field">
                Additional model IDs
                <textarea
                  value={explicitModels}
                  maxLength={20000}
                  disabled={busy || discovering}
                  onChange={(event) => {
                    setBillingConfirmed(false);
                    setExplicitModels(event.target.value);
                  }}
                  placeholder="One model ID per line"
                />
              </label>
              <p className="workspace-muted">
                Catalogs may omit working models. Explicit IDs are saved without a model call or key
                validation. Confirm that the selected models support Codex Responses streaming,
                tools, follow-up turns and cancellation.
              </p>
              {provider === 'enmaas' && (
                <p className="workspace-muted">
                  The two hosted models are prefilled. Other catalog models may incur charges. GLM
                  compatibility with Codex tools needs separate verification. Anthropic models
                  require the Claude engine and are a follow-on.
                </p>
              )}
            </>
          )}
          {!custom && (
            <p className="workspace-muted">
              Validation runs one brief gpt-6-luna request with low reasoning, billed to the newly
              entered key’s project.
            </p>
          )}
          <label className="connections-key-confirmation">
            <input
              type="checkbox"
              checked={billingConfirmed}
              disabled={busy || discovering}
              onChange={(event) => setBillingConfirmed(event.target.checked)}
            />
            <span>
              {custom
                ? 'I authorize sending this key to the selected endpoint and confirm the selected models support the Codex features listed above.'
                : 'I authorize this validation charge to the project associated with this key.'}
            </span>
          </label>
          <button
            className="workspace-primary"
            disabled={
              busy ||
              discovering ||
              !label.trim() ||
              !projectLabel.trim() ||
              !apiKey.trim() ||
              !billingConfirmed ||
              (custom && (!endpointValid || !modelsValid))
            }
          >
            {busy
              ? custom
                ? 'Saving account…'
                : 'Validating new account…'
              : custom
                ? 'Save API account'
                : 'Validate and add account'}
          </button>
        </form>
      )}
      {accounts.length > 0 && (
        <div aria-label="Enrolled AI API accounts">
          <h3>Enrolled accounts</h3>
          {accounts.map((account) => (
            <p key={account.id}>
              {account.label} · {account.projectLabel}
              {account.endpoint ? ` · ${account.endpoint}` : ''} ·{' '}
              {account.state === 'ready'
                ? 'Ready'
                : account.state === 'connecting'
                  ? 'Connecting'
                  : account.state === 'failed'
                    ? 'Validation failed'
                    : 'Needs attention'}
              {account.errorCode ? ` · ${account.errorCode}` : ''}
            </p>
          ))}
        </div>
      )}
      {reviewRequired && retrySafe && (
        <button
          className="workspace-primary"
          disabled={busy}
          onClick={() => {
            requestId.current = null;
            setReviewRequired(false);
            setMessage(
              'Validation did not save an account. Enter a new key to start a new validation.',
            );
          }}
        >
          Try a new key
        </button>
      )}
      <button className="workspace-text-link" disabled={busy} onClick={() => void refresh()}>
        Check account status
      </button>
    </section>
  );
}
