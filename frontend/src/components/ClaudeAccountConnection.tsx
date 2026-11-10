import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import {
  changeClaudeLogin,
  readClaudeAccounts,
  readClaudeChatIntent,
  type ClaudeAccountSnapshot,
  type ClaudeLoginAttempt,
} from '../lib/claude-account-api';
import { invalidateSymposiumAccountCatalog } from '../lib/symposium-account-catalog';
import { createChatDraft, saveChatDraft } from '../lib/chat-drafts';
import { chatStorage } from '../lib/large-chat-storage';

const pending = (attempt?: ClaudeLoginAttempt) =>
  !!attempt && ['preparing', 'pending', 'verifying'].includes(attempt.state);
const labels: Record<ClaudeLoginAttempt['state'], string> = {
  preparing: 'Preparing Claude sign-in…',
  pending: 'Finish sign-in on this phone or computer, then paste the returned code below.',
  verifying: 'Checking Claude sign-in…',
  connected: 'Claude sign-in completed.',
  cancelled: 'Claude sign-in cancelled.',
  failed: 'Claude sign-in failed. Check status, then start a new sign-in when ready.',
  interrupted:
    'This sign-in was interrupted when the Mac restarted. Start a new sign-in when ready.',
};

/** Uses the shared Connections form/row pattern. Private codes live only in this mounted form. */
export function ClaudeAccountConnection({ accountId }: { accountId?: string }) {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<ClaudeAccountSnapshot | null>(null);
  const [label, setLabel] = useState('Personal Claude');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authority, setAuthority] = useState(true);
  const codeField = useRef<HTMLInputElement>(null);
  const mounted = useRef(false),
    mutation = useRef(false),
    version = useRef(0);
  const requestId = useRef<string | null>(null),
    notified = useRef(new Set<string>());
  const attempt = [...(snapshot?.attempts ?? [])]
    .reverse()
    .find((row) => !accountId || row.accountId === accountId);
  const accounts = snapshot?.accounts.filter((row) => !accountId || row.id === accountId) ?? [];
  const currentAccount =
    accounts.find((row) => row.id === attempt?.accountId) ?? (accountId ? accounts[0] : undefined);
  const busyAttempt = snapshot?.attempts.some(pending) ?? false;
  const recoveryRequired = !!snapshot?.attempts.some((row) =>
    [
      'CLAUDE_LOGIN_JOURNAL_FAILED',
      'CLAUDE_LOGIN_CHILD_UNCONFIRMED',
      'CLAUDE_LOGIN_CANCELLATION_UNCONFIRMED',
    ].includes(row.errorCode ?? ''),
  );
  const notify = useCallback((value: ClaudeAccountSnapshot) => {
    for (const row of value.attempts)
      if (row.state === 'connected' && !notified.current.has(row.requestId)) {
        notified.current.add(row.requestId);
        invalidateSymposiumAccountCatalog();
      }
  }, []);
  const refresh = useCallback(async () => {
    const generation = ++version.current;
    try {
      const value = await readClaudeAccounts();
      if (!mounted.current || generation !== version.current) return;
      setSnapshot(value);
      setError('');
      setAuthority(true);
      notify(value);
    } catch {
      if (mounted.current && generation === version.current)
        setError('Claude account status is unavailable. Check status before continuing.');
    }
  }, [notify]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const lost = () => {
      version.current++;
      if (codeField.current) codeField.current.value = '';
      setCode('');
      setAuthority(false);
      setError('Sign in to Mitzo again to continue.');
    };
    const restored = () => {
      setCode('');
      void refresh();
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    return () => {
      mounted.current = false;
      version.current++;
      if (codeField.current) codeField.current.value = '';
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
    };
  }, [refresh]);
  useEffect(() => {
    if (!authority || !busyAttempt || error) return;
    const timer = setTimeout(() => {
      if (!mutation.current) void refresh();
    }, 3000);
    return () => clearTimeout(timer);
  }, [authority, busyAttempt, error, snapshot, refresh]);
  const change = async (path: string, body: unknown) => {
    if (mutation.current || !authority) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    const generation = ++version.current;
    try {
      const row = await changeClaudeLogin(path, body);
      if (!mounted.current || generation !== version.current) return;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              attempts: [...current.attempts.filter((old) => old.requestId !== row.requestId), row],
            }
          : current,
      );
      if (row.state === 'connected') await refresh();
    } catch {
      if (mounted.current && generation === version.current)
        setError('Claude sign-in could not be confirmed. Check status before continuing.');
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const start = () => {
    if (
      !requestId.current ||
      snapshot?.attempts.some((row) => row.requestId === requestId.current && !pending(row))
    )
      requestId.current = crypto.randomUUID();
    return change('/start', {
      requestId: requestId.current,
      label: currentAccount?.label ?? label,
      ...(accountId ? { accountId } : {}),
    });
  };
  const startChat = async (id: string) => {
    if (mutation.current || !authority) return;
    mutation.current = true;
    setBusy(true);
    try {
      const runtimeSelection = await readClaudeChatIntent(id);
      const draft = createChatDraft(),
        account = runtimeSelection.account;
      draft.settings = {
        ...draft.settings,
        selection: account,
        retainRuntimeIntent: true,
        runtimeSelection,
      };
      if (!saveChatDraft(draft)) throw Error('Draft storage unavailable');
      await chatStorage.flush();
      if (mounted.current) navigate(`/chat?draft=${encodeURIComponent(draft.id)}`);
    } catch {
      if (mounted.current)
        setError(
          'Could not prepare the new Local Mac chat. Your Claude account is saved; try Start chat again.',
        );
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const controlsDisabled = busy || !authority || !!error || recoveryRequired;
  return (
    <section className="connections-setup" aria-labelledby="claude-connect-heading">
      <h2 id="claude-connect-heading">Claude subscription</h2>
      <p>Connect your Claude Pro or Max account for chats on Local Mac.</p>
      {!snapshot && !error && <p role="status">Loading Claude account status…</p>}
      {snapshot?.enabled === false && <p>Claude subscription sign-in requires Local Mac.</p>}
      {authority &&
        accounts.map((account) => (
          <article className="access-row" key={account.id}>
            <div className="access-row-copy">
              <h3>{account.label}</h3>
              <p>
                {account.email} · {account.planType === 'max' ? 'Max' : 'Pro'}
              </p>
              <p className="workspace-muted">
                Last connected {new Date(account.verifiedAt).toLocaleString()}
              </p>
            </div>
            <button
              type="button"
              className="access-row-action"
              disabled={controlsDisabled || busyAttempt}
              onClick={() => void startChat(account.id)}
            >
              Start chat
            </button>
          </article>
        ))}
      {authority && attempt && (
        <div>
          <p
            role={
              attempt.state === 'failed' || attempt.state === 'interrupted' ? 'alert' : 'status'
            }
          >
            {labels[attempt.state]}
          </p>
          {attempt.diagnosticId && (
            <p className="workspace-muted">Reference: {attempt.diagnosticId}</p>
          )}
          {attempt.state === 'pending' && attempt.url && (
            <>
              <p>
                <a
                  className="workspace-primary"
                  href={attempt.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Claude sign-in
                </a>
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!controlsDisabled && code && attempt) {
                    const oneShot = code;
                    setCode('');
                    void change(`/${attempt.requestId}/code`, { code: oneShot });
                  }
                }}
              >
                <label className="connections-field">
                  Sign-in code
                  <input
                    ref={codeField}
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={4096}
                    value={code}
                    disabled={controlsDisabled}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
                <p className="workspace-muted">
                  Copy the complete code from Claude’s sign-in page. Enter it here to finish
                  connecting.
                </p>
                <button
                  className="workspace-primary"
                  type="submit"
                  disabled={controlsDisabled || !code.trim()}
                >
                  Complete sign-in
                </button>
              </form>
            </>
          )}
          {pending(attempt) && (
            <button
              type="button"
              disabled={busy || !authority}
              onClick={() => void change(`/${attempt.requestId}/cancel`, {})}
            >
              Cancel sign-in
            </button>
          )}
        </div>
      )}
      {snapshot?.enabled && !busyAttempt && authority && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!controlsDisabled) void start();
          }}
        >
          {!accountId && (
            <label className="connections-field">
              Account name
              <input
                value={label}
                maxLength={120}
                disabled={controlsDisabled}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          )}
          <button
            type="submit"
            className="workspace-primary"
            disabled={controlsDisabled || !label.trim() || (!!accountId && !currentAccount)}
          >
            {accountId ? 'Sign in again' : 'Sign in with Claude'}
          </button>
        </form>
      )}
      {authority && busyAttempt && !pending(attempt) && (
        <p>Finish or cancel the pending Claude sign-in before connecting another account.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {recoveryRequired && (
        <p role="alert">
          Claude sign-in needs recovery on the Mac. Check status and use the diagnostic reference
          before starting another sign-in.
        </p>
      )}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        Check sign-in status
      </button>
    </section>
  );
}
