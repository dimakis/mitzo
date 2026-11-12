import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserId } from '../lib/browser-crypto';
import {
  discoverApiModels,
  enrollOpenAIAccount,
  getOpenAIAccounts,
  OpenAIAccountEnrollmentFailure,
} from '../lib/connections-api';
import type { EnrolledOpenAIAccount } from '../types/connections';
import { MotionDetails } from './MotionDetails';
import { EnmaasAccountSetup } from './EnmaasAccountSetup';

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
  accountId,
}: {
  csrf: string;
  authorized: boolean;
  expiresAt?: number;
  onReauthorizationNeeded: () => void;
  accountId?: string;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<EnrolledOpenAIAccount[]>([]);
  const [label, setLabel] = useState('');
  const [projectLabel, setProjectLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState(accountId ? 'enmaas' : 'openai');
  const [protocol, setProtocol] = useState<'responses' | 'messages'>('responses');
  const [authentication, setAuthentication] = useState<'api-key' | 'bearer'>('api-key');
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
  const missing = [
    !label.trim() && 'Enter an account label',
    !projectLabel.trim() && 'Enter a project name',
    !apiKey.trim() && 'Enter an API key',
    custom && !endpointValid && 'Enter a public HTTPS API base URL',
    custom &&
      !modelsValid &&
      'Select or enter at least one model (up to 200 IDs, 256 characters each)',
    !billingConfirmed && 'Confirm the authorization below',
  ].filter(Boolean);
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
      const result = await discoverApiModels({
        csrf,
        endpoint: endpoint.trim(),
        apiKey,
        ...(protocol === 'messages' ? { protocol, authentication } : {}),
      });
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
                protocol,
                ...(protocol === 'messages' ? { authentication } : {}),
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
  if (provider === 'enmaas')
    return (
      <EnmaasAccountSetup
        csrf={csrf}
        authorized={authorized}
        expiresAt={expiresAt}
        onReauthorizationNeeded={onReauthorizationNeeded}
        enabled={enabled}
        accounts={accounts}
        onRefresh={refresh}
        accountId={accountId}
        onChooseProvider={accountId ? undefined : () => setProvider('openai')}
      />
    );
  return (
    <section
      className="connections-setup openai-account-enrollment"
      aria-label="Add a new AI API account"
    >
      <h2>Add a new AI API account</h2>
      <p className="workspace-muted">
        Existing tasks keep their current account. Use this account in a new chat.
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
                setProtocol('responses');
                setAuthentication('api-key');
                setEndpoint(value === 'enmaas' ? 'https://api.enmaas.devshift.net/v1' : '');
                setExplicitModels(value === 'enmaas' ? enmaasModels.join('\n') : '');
                setApiKey('');
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="enmaas">EnMaaS</option>
              <option value="custom">Custom API</option>
            </select>
          </label>
          {custom && (
            <label className="connections-field">
              Model API
              <select
                value={protocol}
                disabled={busy || discovering}
                onChange={(event) => {
                  const next = event.target.value as 'responses' | 'messages';
                  resetDiscovery();
                  setProtocol(next);
                  setExplicitModels(provider === 'enmaas' ? enmaasModels.join('\n') : '');
                  if (provider === 'enmaas')
                    setEndpoint(
                      'https://api.enmaas.devshift.net' + (next === 'responses' ? '/v1' : ''),
                    );
                }}
              >
                <option value="responses">Responses · Codex</option>
                <option value="messages">Anthropic Messages · Claude</option>
              </select>
            </label>
          )}
          {custom && protocol === 'messages' && (
            <label className="connections-field">
              Key authentication
              <select
                value={authentication}
                disabled={busy || discovering}
                onChange={(event) => {
                  resetDiscovery();
                  setAuthentication(event.target.value as 'api-key' | 'bearer');
                }}
              >
                <option value="api-key">Anthropic API key</option>
                <option value="bearer">Bearer token</option>
              </select>
            </label>
          )}
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
              required
              maxLength={120}
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="connections-field">
            Intended work project name
            <input
              value={projectLabel}
              required
              maxLength={120}
              disabled={busy}
              onChange={(event) => setProjectLabel(event.target.value)}
            />
          </label>
          <label className="connections-field">
            API key
            <input
              type="password"
              required
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
                {provider === 'enmaas'
                  ? 'The two hosted models are prefilled. Get models is optional.'
                  : 'Select models below or enter their exact IDs. Get models is optional.'}
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
              <MotionDetails className="connections-technical" summary="API setup details">
                <p className="workspace-muted">
                  {protocol === 'messages'
                    ? 'Uses the existing Claude Agent SDK engine. Enter the provider base URL before /v1/messages. EnMaaS requires Anthropic API key authentication; Vertex authentication is disabled.'
                    : 'Uses the Codex engine with a Responses-compatible API.'}
                </p>
                <p className="workspace-muted">
                  Use a public HTTPS provider hostname without credentials, query or fragment. Get
                  models sends this key to that endpoint for a catalog read, with no inference call.
                  Catalogs may omit working models. Saving explicit IDs makes no model call and does
                  not validate the key. Project names record intended use only.
                </p>
                <p className="workspace-muted">
                  Models must support streaming, tools, follow-up turns and cancellation with the
                  selected engine. Other catalog models may incur charges.
                  {provider === 'enmaas' &&
                    protocol === 'responses' &&
                    ' GLM compatibility with Codex tools needs separate verification.'}
                </p>
              </MotionDetails>
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
                ? `I authorize sending this key to the selected endpoint and confirm these models support ${protocol === 'messages' ? 'Claude' : 'Codex'} streaming, tools, follow-up turns and cancellation.`
                : 'I authorize this validation charge to the project associated with this key.'}
            </span>
          </label>
          {missing.length > 0 && (
            <p className="workspace-muted" id="api-account-save-help">
              {missing.join('. ')}.
            </p>
          )}
          <button
            className="workspace-primary"
            aria-describedby={missing.length > 0 ? 'api-account-save-help' : undefined}
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
