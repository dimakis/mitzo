import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createBrowserId } from '../lib/browser-crypto';
import {
  discoverApiModels,
  enrollOpenAIAccount,
  refreshEnrolledApiModels,
  OpenAIAccountEnrollmentFailure,
  ApiModelDiscoveryFailure,
} from '../lib/connections-api';
import type { EnrolledOpenAIAccount } from '../types/connections';
import { MotionDetails } from './MotionDetails';
import { ModelVisibilitySettings } from './ModelVisibilitySettings';
import { pickerModels, useModelVisibility } from '../lib/model-visibility';
import { createChatDraft, saveChatDraft } from '../lib/chat-drafts';
import { chatStorage } from '../lib/large-chat-storage';
import { readLocalAccountChatIntent } from '../lib/claude-account-api';

const enmaasHostedModels = [
  { id: 'rits/deepseek-ai/DeepSeek-V4.1-Flash-1017', label: 'DeepSeek V4.1 Flash' },
  { id: 'rits/zai-org/glm-5-3', label: 'GLM 5.3' },
];
type Model = { id: string; label: string };
export function EnmaasAccountSetup({
  csrf,
  authorized,
  expiresAt,
  onReauthorizationNeeded,
  enabled,
  accounts,
  onRefresh,
  accountId,
  onChooseProvider,
}: {
  csrf: string;
  authorized: boolean;
  expiresAt?: number;
  onReauthorizationNeeded(): void;
  enabled: boolean | null;
  accounts: EnrolledOpenAIAccount[];
  onRefresh(): void | Promise<void>;
  accountId?: string;
  onChooseProvider?(): void;
}) {
  const navigate = useNavigate();
  const [label, setLabel] = useState('EnMaaS · Work');
  const [protocol, setProtocol] = useState<'responses' | 'messages'>('responses');
  const [endpoint, setEndpoint] = useState('https://api.enmaas.devshift.net/v1');
  const [apiKey, setApiKey] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [fallback, setFallback] = useState(false);
  const [review, setReview] = useState(false);
  const [saved, setSaved] = useState<EnrolledOpenAIAccount | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const generation = useRef(0),
    mounted = useRef(true),
    pending = useRef(false);
  const enrollmentStarted = useRef(false);
  const authority = useRef({ csrf, authorized, expiresAt, enabled, accounts });
  authority.current = { csrf, authorized, expiresAt, enabled, accounts };
  useModelVisibility();
  useEffect(() => {
    mounted.current = true;
    const lifetime = generation;
    return () => {
      mounted.current = false;
      lifetime.current++;
    };
  }, []);
  const unresolved = accounts.some(
    (account) => account.state === 'connecting' || account.state === 'needs_attention',
  );
  useEffect(() => {
    if (!authorized || enabled === false || unresolved) {
      generation.current++;
      setApiKey('');
      setFallback(false);
      if (pending.current && enrollmentStarted.current) {
        setReview(true);
        setMessage(
          'Account saving could not be confirmed after authorization changed. Check account status before trying again.',
        );
      }
    }
  }, [authorized, enabled, unresolved]);
  const account =
    saved ??
    accounts.find((row) =>
      accountId ? row.id === accountId : !!requestId && row.requestId === requestId,
    );
  const models = account?.models ?? [];
  const visible = account ? pickerModels(account.id, models) : [];
  const endpointValid = (() => {
    try {
      const u = new URL(endpoint);
      return (
        u.protocol === 'https:' &&
        u.hostname === 'api.enmaas.devshift.net' &&
        !u.username &&
        !u.password &&
        !endpoint.includes('?') &&
        !endpoint.includes('#')
      );
    } catch {
      return false;
    }
  })();
  const explicit = manual
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((id) => ({ id, label: id }));
  const validModels = explicit.length <= 198 && explicit.every((model) => model.id.length <= 256);
  const current = (version: number) => mounted.current && version === generation.current;
  const checkAuthorization = () => {
    const value = authority.current;
    if (!value.authorized || (value.expiresAt !== undefined && value.expiresAt <= Date.now())) {
      setApiKey('');
      onReauthorizationNeeded();
      return false;
    }
    if (
      value.enabled !== true ||
      value.accounts.some((row) => row.state === 'connecting' || row.state === 'needs_attention')
    ) {
      setMessage(
        'An enrollment needs review before this operation can continue. Check account status.',
      );
      return false;
    }
    return true;
  };
  const connect = async (useHosted = false) => {
    if (
      pending.current ||
      review ||
      !apiKey.trim() ||
      !label.trim() ||
      !endpointValid ||
      !validModels ||
      !checkAuthorization()
    )
      return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    const version = ++generation.current;
    const key = apiKey.trim();
    try {
      let discovered: Model[] = [];
      let partial = false;
      if (!useHosted) {
        try {
          const catalog = await discoverApiModels({
            csrf,
            endpoint,
            apiKey: key,
            ...(protocol === 'messages' ? { protocol, authentication: 'api-key' } : {}),
          });
          discovered = catalog.models;
          partial = catalog.partial;
        } catch (cause) {
          if (!current(version)) return;
          if (
            cause instanceof ApiModelDiscoveryFailure &&
            ['credential_rejected', 'access_denied'].includes(cause.code)
          ) {
            setApiKey('');
            setFallback(false);
            setMessage(cause.message);
          } else if (
            cause instanceof ApiModelDiscoveryFailure &&
            cause.code === 'AUTHORIZATION_REQUIRED'
          ) {
            setApiKey('');
            onReauthorizationNeeded();
          } else {
            setFallback(true);
            setMessage(
              'The model catalog is unavailable. Retry Connect, or save with the hosted models and refresh later.',
            );
          }
          return;
        }
      }
      if (!current(version) || !checkAuthorization()) return;
      const selected = [
        ...new Map(
          [...enmaasHostedModels, ...discovered, ...explicit].map((model) => [model.id, model]),
        ).values(),
      ];
      if (selected.length > 200) {
        setMessage(
          'The catalog exceeds the supported 200 models. Enter specific IDs under Advanced settings and save with hosted models.',
        );
        setFallback(true);
        return;
      }
      const operationId = requestId ?? createBrowserId();
      setRequestId(operationId);
      setApiKey('');
      setFallback(false);
      enrollmentStarted.current = true;
      const result = await enrollOpenAIAccount({
        csrf,
        requestId: operationId,
        label: label.trim(),
        projectLabel: 'EnMaaS',
        apiKey: key,
        billingConfirmed: true,
        connection: {
          endpoint,
          protocol,
          ...(protocol === 'messages' ? { authentication: 'api-key' } : {}),
          qualification: {
            source: 'operator',
            streaming: true,
            toolCalls: true,
            continuation: true,
            cancellation: true,
          },
        },
        models: selected,
      });
      if (!current(version)) return;
      enrollmentStarted.current = false;
      if (result.state === 'ready') {
        setSaved({ ...result, models: result.models ?? selected, protocol });
        setMessage(
          useHosted
            ? 'Saved with hosted models. Catalog access is still unverified; Refresh models to retry.'
            : partial
              ? 'The provider returned a partial catalog. Listed and hosted models are available; Refresh models to retry.'
              : '',
        );
      } else if (result.state === 'failed') {
        setRequestId(null);
        setMessage(
          'Account setup failed before saving the key. Check the details and enter your key again.',
        );
      } else {
        setReview(true);
        setMessage('Account saving needs attention. Check account status before trying again.');
      }
      await onRefresh();
    } catch (cause) {
      if (!current(version)) return;
      if (cause instanceof OpenAIAccountEnrollmentFailure && cause.retrySetup) {
        setRequestId(null);
        setMessage(cause.message);
      } else {
        setReview(true);
        setMessage('Could not confirm account saving. Check account status before trying again.');
      }
      await onRefresh();
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refreshModels = async () => {
    if (!account || pending.current || !checkAuthorization()) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    const version = ++generation.current;
    try {
      const result = await refreshEnrolledApiModels(account.id, csrf);
      if (current(version)) {
        setSaved(result);
        await onRefresh();
      }
    } catch (cause) {
      if (current(version)) {
        if (cause instanceof ApiModelDiscoveryFailure && cause.code === 'AUTHORIZATION_REQUIRED')
          onReauthorizationNeeded();
        setMessage(
          'Could not refresh models. Your last model list is retained. Check the account and retry.',
        );
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const startChat = async () => {
    if (!account || !visible.length || pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    const version = ++generation.current;
    try {
      const runtimeSelection = await readLocalAccountChatIntent(
        account.id,
        account.protocol === 'messages' ? 'anthropic-api' : 'openai',
        visible[0].id,
      );
      if (!current(version)) return;
      const draft = createChatDraft();
      draft.settings = {
        ...draft.settings,
        selection: runtimeSelection.account,
        retainRuntimeIntent: true,
        runtimeSelection,
      };
      if (!saveChatDraft(draft)) throw Error('Draft storage unavailable');
      await chatStorage.flush();
      if (current(version)) navigate(`/chat?draft=${encodeURIComponent(draft.id)}`);
    } catch {
      if (current(version))
        setMessage(
          'Could not prepare a new Local Mac chat. Your account is saved; try Start a chat again.',
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const clearDiscovery = () => {
    generation.current++;
    setFallback(false);
    setMessage('');
  };
  return (
    <section
      className="connections-setup openai-account-enrollment enmaas-account-setup"
      aria-label="EnMaaS account"
    >
      <h2>{account?.state === 'ready' ? account.label : 'Connect EnMaaS'}</h2>
      {message && <p role="alert">{message}</p>}
      {account?.state === 'ready' ? (
        <>
          <p role="status">Account saved</p>
          {enabled !== true && (
            <p role="status">
              Account status is unavailable. Your saved account and model list are retained. Check
              account status to retry.
            </p>
          )}
          <dl className="enmaas-account-facts">
            <dt>Provider</dt>
            <dd>EnMaaS</dd>
            <dt>Runtime</dt>
            <dd>{account.protocol === 'messages' ? 'Claude · Messages' : 'Codex'} · Local Mac</dd>
            <dt>API key</dt>
            <dd>Saved securely</dd>
          </dl>
          <div className="enmaas-models-section">
            <h3>Models</h3>
            <p className="workspace-muted">
              {models.length} available · {visible.length} shown
            </p>
            <p>
              All models are shown by default. Hide any you don’t want in the picker; refresh keeps
              your choices.
            </p>
            <div className="enmaas-actions">
              <ModelVisibilitySettings
                accountId={account.id}
                accountLabel={account.label}
                models={models}
                disabled={busy}
              />
              <button
                type="button"
                className="workspace-text-link"
                disabled={busy || enabled !== true}
                onClick={() => void refreshModels()}
              >
                {busy ? 'Working…' : 'Refresh models'}
              </button>
            </div>
            <MotionDetails summary="View available models" className="connections-technical">
              <ul>
                {models.map((model) => (
                  <li key={model.id}>{model.label}</li>
                ))}
              </ul>
            </MotionDetails>
          </div>
          <button
            type="button"
            className="workspace-primary"
            disabled={busy || !visible.length || enabled !== true}
            onClick={() => void startChat()}
          >
            Start a chat
          </button>
          {!visible.length && (
            <p role="status">No models are shown. Open Model picker settings to show one.</p>
          )}
          <p className="workspace-muted">
            A successful model reply is checked when you use the account.
          </p>
        </>
      ) : enabled === null ? (
        <p role="status">Loading account setup…</p>
      ) : !enabled ? (
        <p>Adding AI API accounts is unavailable.</p>
      ) : accountId && !account ? (
        <p role="status">This saved account is unavailable. Check account status.</p>
      ) : unresolved || review ? (
        <>
          <p role="status">Review the saved enrollment before adding another account.</p>
          {account?.state === 'failed' && !accountId && (
            <button
              type="button"
              className="workspace-primary"
              onClick={() => {
                setReview(false);
                setRequestId(null);
                setMessage(
                  'The failed operation did not save an account. Enter your key to try again.',
                );
              }}
            >
              Try a new key
            </button>
          )}
        </>
      ) : !authorized ? (
        <button className="workspace-primary" onClick={onReauthorizationNeeded}>
          Confirm identity to add an account
        </button>
      ) : (
        <>
          <p className="workspace-muted">Use your EnMaaS account with Codex or Claude.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <label className="connections-field">
              Account name
              <input
                value={label}
                maxLength={120}
                required
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="connections-field">
              Runtime
              <select
                value={protocol}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value as typeof protocol;
                  clearDiscovery();
                  setProtocol(value);
                  setEndpoint(
                    'https://api.enmaas.devshift.net' + (value === 'responses' ? '/v1' : ''),
                  );
                }}
              >
                <option value="responses">Codex</option>
                <option value="messages">Claude · Messages</option>
              </select>
            </label>
            <label className="connections-field">
              API key
              <input
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={16384}
                required
                value={apiKey}
                disabled={busy}
                onChange={(event) => {
                  clearDiscovery();
                  setApiKey(event.target.value);
                }}
              />
            </label>
            <p className="workspace-muted">Your key is saved securely on the Mac running Mitzo.</p>
            <div className="enmaas-models-section">
              <h3>Models</h3>
              <p>
                Models appear in the chat picker automatically. You can show or hide them in
                settings.
              </p>
              <p className="workspace-muted">
                Hosted GLM and DeepSeek IDs are included even if the catalog omits them.
              </p>
            </div>
            <MotionDetails className="connections-technical" summary="Advanced settings">
              <label className="connections-field">
                API base URL
                <input
                  type="url"
                  value={endpoint}
                  maxLength={2048}
                  disabled={busy}
                  onChange={(event) => {
                    clearDiscovery();
                    setEndpoint(event.target.value);
                  }}
                />
              </label>
              <label className="connections-field">
                Additional model IDs
                <textarea
                  value={manual}
                  maxLength={20000}
                  disabled={busy}
                  onChange={(event) => {
                    clearDiscovery();
                    setManual(event.target.value);
                  }}
                  placeholder="Optional · one ID per line"
                />
              </label>
              <p className="workspace-muted">
                {protocol === 'messages'
                  ? 'Messages uses x-api-key authentication.'
                  : 'Codex uses bearer authentication.'}{' '}
                Models must support the selected engine’s streaming, tools, follow-up turns and
                cancellation. Catalog entries may incur provider charges.
              </p>
            </MotionDetails>
            {(!endpointValid || !validModels) && (
              <p role="alert">
                Use the EnMaaS HTTPS hostname and at most 198 additional IDs of 256 characters each.
              </p>
            )}
            <div className="enmaas-actions">
              <button
                className="workspace-primary"
                disabled={busy || !apiKey.trim() || !label.trim() || !endpointValid || !validModels}
              >
                {busy ? 'Connecting…' : 'Connect EnMaaS'}
              </button>
              {fallback && (
                <button
                  type="button"
                  className="workspace-text-link"
                  disabled={busy}
                  onClick={() => void connect(true)}
                >
                  Save with hosted models
                </button>
              )}
            </div>
            <p className="workspace-muted">
              Connecting authorizes sending this key to EnMaaS to read the catalog and save the
              account for the selected engine. No model call is made.
            </p>
          </form>
        </>
      )}
      {(review || unresolved || accountId || enabled === false) && (
        <button
          type="button"
          className="workspace-text-link"
          disabled={busy}
          onClick={() => void onRefresh()}
        >
          Check account status
        </button>
      )}
      {onChooseProvider && !busy && !review && !unresolved && (
        <button type="button" className="workspace-text-link" onClick={onChooseProvider}>
          Choose another provider
        </button>
      )}
    </section>
  );
}
