import { useCallback, useEffect, useRef, useState } from 'react';
import {
  authorizeOpenAIKey,
  getOpenAIKeyStatus,
  OpenAIKeyFailure,
  replaceOpenAIKey,
  synchronizeOpenAIKey,
} from '../lib/connections-api';
import type { OpenAIKeyHealth } from '../types/connections';
import './OpenAIKeyControls.css';

const updateExplanation = (code: string | null) => {
  switch (code) {
    case 'NOT_APPLIED':
      return 'The previous update did not save a replacement. Enter your new key again.';
    case 'CHAT_PAUSE_FAILED':
      return 'The replacement was not saved because Mitzo could not safely pause all chats using this account. Check the affected workspaces before trying again.';
    case 'ACCOUNT_CHANGED':
      return 'The account changed during the update. Refresh its status before trying again.';
    case 'KEYCHAIN_WRITE_UNCONFIRMED':
      return 'Mitzo could not confirm whether the new key was saved on this Mac. Refresh status before trying again.';
    case 'CHAT_UPDATE_UNCONFIRMED':
    case 'SYNC_PENDING':
      return 'The key update is incomplete. Refresh status to see whether it can be finished with the saved key.';
    default:
      return 'The saved key needs attention. Replace it to restore this account.';
  }
};

export function OpenAIKeyControls({
  accountId,
  csrf,
  authorized,
  onReauthorizationNeeded,
}: {
  accountId?: string;
  csrf: string;
  authorized: boolean;
  onReauthorizationNeeded: () => void;
}) {
  const [accounts, setAccounts] = useState<OpenAIKeyHealth[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setAccounts(await getOpenAIKeyStatus());
      setCheckedAt(Date.now());
    } catch {
      setError(
        'Could not refresh account status. The details below may be out of date. Try again.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <section className="openai-key-management" aria-label="OpenAI API key management">
      <p className="workspace-muted openai-key-intro">
        Update the API key used by this account on your Mac and in its chats.
      </p>
      {error && <p role="alert">{error}</p>}
      {!loading && !error && accounts.length === 0 && (
        <p>No accounts are configured for key replacement.</p>
      )}
      {accountId &&
        accounts.length > 0 &&
        !accounts.some((account) => account.accountId === accountId) && (
          <p>This account is no longer configured. Return to Connections to refresh its status.</p>
        )}
      {accounts
        .filter((account) => !accountId || account.accountId === accountId)
        .map((account) => (
          <OpenAIKeyCard
            key={account.accountId}
            account={account}
            csrf={csrf}
            authorized={authorized}
            onReauthorizationNeeded={onReauthorizationNeeded}
            onUpdated={(result) =>
              setAccounts((previous) =>
                previous.map((item) => (item.accountId === result.accountId ? result : item)),
              )
            }
            refresh={refresh}
            statusUnavailable={!!error || loading}
          />
        ))}
      <div className="openai-key-refresh">
        <button type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? 'Checking…' : 'Refresh status'}
        </button>
        <span role="status">
          {loading
            ? 'Checking saved account status…'
            : !error && checkedAt
              ? `Status refreshed at ${new Date(checkedAt).toLocaleTimeString()}.`
              : ''}
        </span>
      </div>
    </section>
  );
}

type Mode = 'replace' | 'synchronize';
function OpenAIKeyCard({
  account,
  csrf,
  authorized,
  onReauthorizationNeeded,
  onUpdated,
  refresh,
  statusUnavailable,
}: {
  account: OpenAIKeyHealth;
  csrf: string;
  authorized: boolean;
  onReauthorizationNeeded: () => void;
  onUpdated: (result: OpenAIKeyHealth) => void;
  refresh: () => Promise<void>;
  statusUnavailable: boolean;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [sameProject, setSameProject] = useState(false);
  const [busy, setBusy] = useState<'authorize' | 'save' | null>(null);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const ownRevision = useRef(account.revision);
  const pendingOpen = useRef<Mode | null>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const needsKeychainAuthorization = account.errorCode === 'KEYCHAIN_AUTHORIZATION_REQUIRED';
  useEffect(() => {
    if (ownRevision.current === account.revision) return;
    ownRevision.current = account.revision;
    setApiKey('');
    setSameProject(false);
    setMode(null);
    if (mode || success) {
      setSuccess(false);
      setMessage('The account changed. Review its current status before entering a new key.');
    }
  }, [account.revision, mode, success]);
  useEffect(() => {
    if (!authorized) {
      setMode(null);
      setApiKey('');
      setSameProject(false);
    }
  }, [authorized]);
  const accept = useCallback(
    (result: OpenAIKeyHealth) => {
      ownRevision.current = result.revision;
      onUpdated(result);
    },
    [onUpdated],
  );
  const open = useCallback(
    async (next: Mode) => {
      if (statusUnavailable) {
        setMessage('Refresh account status before changing the key.');
        return;
      }
      if (!authorized) {
        pendingOpen.current = next;
        onReauthorizationNeeded();
        return;
      }
      setMessage('');
      setSuccess(false);
      if (needsKeychainAuthorization) {
        setBusy('authorize');
        try {
          const result = await authorizeOpenAIKey({
            accountId: account.accountId,
            revision: account.revision,
            csrf,
          });
          accept(result);
          if (
            result.errorCode === 'KEYCHAIN_AUTHORIZATION_REQUIRED' ||
            result.health === 'unavailable'
          ) {
            setMessage(
              'Keychain access was not confirmed. Approve Mitzo Keychain Helper on the Mac, then try again.',
            );
            return;
          }
        } catch {
          setMessage(
            'Keychain access was not confirmed. Approve Mitzo Keychain Helper on the Mac, then try again.',
          );
          return;
        } finally {
          setBusy(null);
        }
      }
      setApiKey('');
      setSameProject(false);
      setMode(next);
    },
    [
      authorized,
      statusUnavailable,
      onReauthorizationNeeded,
      needsKeychainAuthorization,
      account.accountId,
      account.revision,
      csrf,
      accept,
    ],
  );
  useEffect(() => {
    if (authorized && pendingOpen.current) {
      const next = pendingOpen.current;
      pendingOpen.current = null;
      void open(next);
    }
  }, [authorized, open]);
  const submit = async () => {
    if (!authorized) {
      setApiKey('');
      setMode(null);
      pendingOpen.current = 'replace';
      onReauthorizationNeeded();
      return;
    }
    setSuccess(false);
    if (mode === 'replace' && !apiKey.trim()) {
      setMessage('Enter your replacement API key.');
      keyInput.current?.focus();
      return;
    }
    if (!sameProject) {
      setMessage('Confirm that this key belongs to the same OpenAI project.');
      confirmation.current?.focus();
      return;
    }
    const oneShot = apiKey;
    setApiKey('');
    setMode(null);
    setBusy('save');
    setMessage('');
    try {
      const selection = {
        accountId: account.accountId,
        revision: account.revision,
        csrf,
        sameProject,
      };
      const result =
        mode === 'replace'
          ? await replaceOpenAIKey({ ...selection, apiKey: oneShot })
          : await synchronizeOpenAIKey(selection);
      accept(result);
      const applied = result.health === 'ready' && !result.errorCode;
      setSuccess(applied);
      setMessage(
        applied
          ? 'API key updated. This account is ready to use.'
          : updateExplanation(result.errorCode),
      );
    } catch (error) {
      const code = error instanceof OpenAIKeyFailure ? error.code : 'UPDATE_UNCONFIRMED';
      setMessage(
        code === 'KEY_VALIDATION_FAILED'
          ? 'OpenAI could not validate this key with gpt-6-luna. No replacement was saved. Check the key, project and model access, then try again.'
          : code === 'AUTHORIZATION_REQUIRED'
            ? 'Your authorization expired. Confirm your identity again before entering the key.'
            : code === 'ACCOUNT_CHANGED'
              ? updateExplanation(code)
              : 'Could not confirm the update. Refresh status before trying again; the key may already have been saved.',
      );
      if (code === 'AUTHORIZATION_REQUIRED') onReauthorizationNeeded();
      await refresh();
    } finally {
      setBusy(null);
      setSameProject(false);
    }
  };
  return (
    <div className="connections-card openai-key-card">
      <h2>{account.label}</h2>
      <p className="openai-key-health" role="status">
        {account.health === 'ready'
          ? 'Ready to use'
          : needsKeychainAuthorization
            ? 'Keychain access needs approval'
            : account.health === 'needs_attention'
              ? 'Key update incomplete'
              : account.health === 'unavailable'
                ? 'Account status unavailable'
                : 'Saved key has not been verified'}
      </p>
      {account.verifiedAt && (
        <p className="workspace-muted">
          Last verified: {new Date(account.verifiedAt).toLocaleString()}
        </p>
      )}
      {message && (
        <p
          className={`openai-key-feedback${success ? ' openai-key-feedback--success' : ''}`}
          role={success ? 'status' : 'alert'}
        >
          {message}
        </p>
      )}
      {!message && account.errorCode && !needsKeychainAuthorization && (
        <p role="alert">{updateExplanation(account.errorCode)}</p>
      )}
      {needsKeychainAuthorization && (
        <p className="workspace-muted">
          Approve Mitzo Keychain Helper on this Mac when prompted. Choose Always Allow to remember
          access to this account.
        </p>
      )}
      {!mode && !busy && (
        <div className="connections-actions">
          <button
            className="workspace-primary"
            disabled={statusUnavailable || !account.revision}
            onClick={() => void open('replace')}
          >
            Replace API key
          </button>
          {account.canSynchronize && account.health === 'needs_attention' && (
            <button
              disabled={statusUnavailable || !account.revision}
              onClick={() => void open('synchronize')}
            >
              Finish key update
            </button>
          )}
        </div>
      )}
      {busy && (
        <p role="status">
          {busy === 'authorize'
            ? 'Waiting for Keychain approval on this Mac…'
            : 'Checking the key and updating this account… This may take up to two minutes.'}
        </p>
      )}
      {mode && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {mode === 'replace' ? (
            <label className="connections-field">
              New API key
              <input
                ref={keyInput}
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={16384}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
          ) : (
            <p>
              The new key is saved on this Mac, but its chat update is incomplete. Finish the update
              using that saved key.
            </p>
          )}
          <label className="connections-key-confirmation">
            <input
              ref={confirmation}
              type="checkbox"
              checked={sameProject}
              onChange={(event) => setSameProject(event.target.checked)}
            />
            <span>This key belongs to the same OpenAI project as {account.label}.</span>
          </label>
          <p className="workspace-muted openai-key-disclosure">
            Mitzo checks the key with one brief gpt-6-luna request (low reasoning), billed to{' '}
            {account.label}. Chats using this account pause during the update.
          </p>
          <div className="connections-actions">
            <button
              className="workspace-primary"
              type="submit"
              disabled={!!busy || statusUnavailable}
            >
              {mode === 'replace' ? 'Save API key' : 'Finish update'}
            </button>
            <button
              type="button"
              onClick={() => {
                setApiKey('');
                setSameProject(false);
                setMode(null);
                setMessage('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
