import { useCallback, useEffect, useState } from 'react';
import { getOpenAIKeyStatus, replaceOpenAIKey, synchronizeOpenAIKey } from '../lib/connections-api';
import type { OpenAIKeyHealth } from '../types/connections';

export function OpenAIKeyControls({
  csrf,
  authorized,
  onReauthorizationNeeded,
}: {
  csrf: string;
  authorized: boolean;
  onReauthorizationNeeded: () => void;
}) {
  const [accounts, setAccounts] = useState<OpenAIKeyHealth[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setAccounts(await getOpenAIKeyStatus());
      setError('');
    } catch {
      setAccounts([]);
      setError('OpenAI connection status is unavailable. Try checking again.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <section className="today-section connections-card" aria-labelledby="openai-keys-heading">
      <h2 id="openai-keys-heading">OpenAI API accounts</h2>
      <p className="workspace-muted">
        Replace a key once to keep host API calls and sandbox chats synchronized.
      </p>
      {error && <p role="alert">{error}</p>}
      {accounts.map((account) => (
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
        />
      ))}
      <button onClick={() => void refresh()}>Check OpenAI status</button>
    </section>
  );
}

function OpenAIKeyCard({
  account,
  csrf,
  authorized,
  onReauthorizationNeeded,
  onUpdated,
  refresh,
}: {
  account: OpenAIKeyHealth;
  csrf: string;
  authorized: boolean;
  onReauthorizationNeeded: () => void;
  onUpdated: (result: OpenAIKeyHealth) => void;
  refresh: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'replace' | 'synchronize' | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [sameProject, setSameProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!authorized) {
      setMode(null);
      setApiKey('');
      setSameProject(false);
    }
  }, [authorized]);
  const open = (next: 'replace' | 'synchronize') => {
    if (!authorized) {
      onReauthorizationNeeded();
      return;
    }
    setApiKey('');
    setSameProject(false);
    setMode(next);
    setMessage('');
  };
  const submit = async () => {
    if (!authorized) {
      setApiKey('');
      setMode(null);
      onReauthorizationNeeded();
      return;
    }
    const oneShot = apiKey;
    setApiKey('');
    setMode(null);
    setBusy(true);
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
      onUpdated(result);
      if (result.health !== 'ready')
        setMessage('Synchronization needs attention. Check the status and retry synchronization.');
    } catch {
      setMessage(
        'Could not confirm the update. Check the work project and Luna 6 access, then refresh and retry.',
      );
      await refresh();
    } finally {
      setBusy(false);
      setSameProject(false);
    }
  };
  return (
    <div className="connections-card">
      <h3>{account.label}</h3>
      <p role="status">
        {account.health === 'ready'
          ? 'Credentials synchronized'
          : account.health === 'needs_attention'
            ? 'Synchronization needs attention'
            : account.health === 'unavailable'
              ? 'Connection unavailable'
              : 'Synchronization has not been verified'}
      </p>
      {account.verifiedAt && (
        <p className="workspace-muted">
          Last verified: {new Date(account.verifiedAt).toLocaleString()}
        </p>
      )}
      {message && <p role="alert">{message}</p>}
      {!mode && (
        <div className="connections-actions">
          <button disabled={busy || !account.revision} onClick={() => open('replace')}>
            Replace API key
          </button>
          {account.canSynchronize && account.health !== 'ready' && (
            <button disabled={busy || !account.revision} onClick={() => open('synchronize')}>
              {account.health === 'needs_attention'
                ? 'Retry synchronization'
                : 'Synchronize saved key'}
            </button>
          )}
        </div>
      )}
      {busy && <p role="status">Validating and synchronizing…</p>}
      {mode && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {mode === 'replace' && (
            <label className="connections-field">
              Replacement API key
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={16384}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
          )}
          <label className="connections-field">
            <input
              type="checkbox"
              checked={sameProject}
              onChange={(event) => setSameProject(event.target.checked)}
            />
            This key belongs to the same work OpenAI project.
          </label>
          <p className="workspace-muted">
            Checks the key and Luna 6 availability before saving. Affected sandbox chats pause
            during the update. Key validation cannot independently identify the billing project;
            confirm it above.
          </p>
          <button
            className="workspace-primary"
            type="submit"
            disabled={busy || !sameProject || (mode === 'replace' && !apiKey.trim())}
          >
            {mode === 'replace' ? 'Validate and save' : 'Validate and synchronize'}
          </button>
          <button
            type="button"
            onClick={() => {
              setApiKey('');
              setSameProject(false);
              setMode(null);
            }}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
