import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { copyToClipboard } from '../lib/clipboard';
import { apiFetch } from '../lib/api-fetch';
import './SymposiumDeviceLogin.css';

const statusSchema = z.object({
  state: z.enum(['idle', 'pending', 'completed', 'failed', 'cancelled', 'expired', 'unknown']),
  attemptId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  method: z.string().optional(),
  verificationUrl: z.string().optional(),
  userCode: z.string().min(1).max(64).optional(),
  expiresAt: z.number().optional(),
  retryBlocked: z.boolean().optional(),
  account: z
    .object({ label: z.string(), email: z.string().optional(), planType: z.string().optional() })
    .optional(),
});
type Status = z.infer<typeof statusSchema>;
const endpoint = '/api/symposium/personal/login';
const messages: Record<Status['state'], string> = {
  idle: 'Get a short-lived code when you are ready to sign in.',
  pending: 'Waiting for OpenAI sign-in. Keep this page available to check completion.',
  completed:
    'A completed connection is available. Choose its account and model when seating a reviewer.',
  failed: 'Sign-in failed. You can request a new code.',
  cancelled: 'Sign-in cancelled. You can request a new code.',
  expired: 'This sign-in attempt expired. Request a new code to continue.',
  unknown: 'No confirmed active sign-in receipt remains. Check status or request a new code.',
};

export function SymposiumDeviceLogin({
  disabled = false,
  onAccountsChanged,
  connectionId,
  expectedRevision,
  buttonLabel = 'Connect ChatGPT',
  onPendingChange,
}: {
  disabled?: boolean;
  onAccountsChanged?(): void;
  connectionId?: string;
  expectedRevision?: number;
  buttonLabel?: string;
  onPendingChange?(pending: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingVersion = useRef<number | null>(null);
  const [error, setError] = useState('');
  const [copyFeedback, setCopyFeedback] = useState('');
  const [statusFailed, setStatusFailed] = useState(false);
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef<string | undefined>(undefined);
  const refreshed = useRef(new Set<string>());
  const changed = useRef(onAccountsChanged);
  changed.current = onAccountsChanged;
  const pendingChanged = useRef(onPendingChange);
  pendingChanged.current = onPendingChange;

  function stop() {
    clearTimeout(timer.current);
    version.current += 1;
    startingVersion.current = null;
    setStarting(false);
    return version.current;
  }
  function accept(value: unknown, expectedId?: string) {
    const next = statusSchema.parse(value);
    if (expectedId && next.attemptId !== expectedId && next.state !== 'unknown')
      throw new Error('Mismatched receipt');
    if (
      connectionId &&
      next.attemptId &&
      next.connectionId !== connectionId &&
      next.state !== 'unknown'
    )
      throw new Error('Mismatched connection');
    if (next.state === 'pending' && !next.attemptId) throw new Error('Missing receipt');
    if (next.verificationUrl && next.verificationUrl !== 'https://auth.openai.com/codex/device')
      throw new Error('Unsupported sign-in address');
    if (next.attemptId !== attempt.current || next.state !== 'pending') setCopyFeedback('');
    attempt.current = next.attemptId;
    setStatus(next);
    pendingChanged.current?.(next.state === 'pending');
    setError('');
    setStatusFailed(false);
    if (next.state === 'completed' && next.attemptId && !refreshed.current.has(next.attemptId)) {
      refreshed.current.add(next.attemptId);
      changed.current?.();
    }
    return next;
  }
  async function check(generation = stop()) {
    setBusy(true);
    try {
      const id = attempt.current;
      const query = new URLSearchParams();
      if (id) query.set('attemptId', id);
      if (connectionId) query.set('connectionId', connectionId);
      const response = await apiFetch(`${endpoint}/status${query.size ? `?${query}` : ''}`);
      if (!response.ok) throw new Error('Status unavailable');
      const value = await response.json();
      if (generation !== version.current) return;
      const next = accept(value, id);
      if (next.state === 'pending') timer.current = setTimeout(() => void check(generation), 2000);
    } catch {
      if (generation !== version.current) return;
      setError('Could not check sign-in status. Retry status before starting another attempt.');
      setStatusFailed(true);
    } finally {
      if (generation === version.current) setBusy(false);
    }
  }
  useEffect(
    () => () => {
      stop();
    },
    [],
  );

  async function action(kind: 'start' | 'cancel') {
    const generation = stop();
    setBusy(true);
    setError('');
    if (kind === 'start') {
      attempt.current = undefined;
      startingVersion.current = generation;
      pendingChanged.current?.(true);
      setStarting(true);
      timer.current = setTimeout(() => void check(generation), 2000);
    }
    try {
      const response = await apiFetch(kind === 'start' ? endpoint : `${endpoint}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'start'
            ? { method: 'device-code', ...(connectionId ? { connectionId, expectedRevision } : {}) }
            : { attemptId: attempt.current },
        ),
      });
      if (!response.ok) throw new Error('Action unavailable');
      const value = await response.json();
      if (generation !== version.current) return;
      const next = accept(value, kind === 'cancel' ? attempt.current : undefined);
      if (next.state === 'pending') timer.current = setTimeout(() => void check(generation), 2000);
    } catch {
      if (generation !== version.current) return;
      setError('Could not confirm the sign-in request. Check status before trying again.');
      setStatusFailed(true);
    } finally {
      if (generation === version.current) {
        startingVersion.current = null;
        setStarting(false);
        setBusy(false);
      }
    }
  }

  return (
    <section className="symposium-device-login" aria-label="ChatGPT connection">
      {!open ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setStatus({ state: 'idle' });
            setError('');
            setStatusFailed(false);
            attempt.current = undefined;
            setOpen(true);
            void check();
          }}
        >
          {buttonLabel}
        </button>
      ) : (
        <>
          <h3>Connect ChatGPT from this device</h3>
          <p>
            Open OpenAI sign-in on this phone or computer. Your Mac completes sign-in and keeps the
            credentials privately. No localhost callback or SSH setup is needed for this option.
          </p>
          <p>
            First enable device-code authentication in ChatGPT Settings → Security.{' '}
            <a
              href="https://learn.chatgpt.com/docs/auth#login-on-headless-devices"
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenAI setup instructions
            </a>
          </p>
          <p role="status">{messages[status.state]}</p>
          {status.state === 'completed' && status.account && (
            <p>
              Verified account: <strong>{status.account.email || status.account.label}</strong>
              {status.account.planType ? ` (${status.account.planType})` : ''}
            </p>
          )}
          <p>
            On your phone, sign in to the intended ChatGPT account first, then reopen the device
            sign-in page in the same browser. If the page cannot accept the code, check the Security
            setting and request a fresh code. An OpenAI page error does not by itself mean the code
            expired.
          </p>
          {status.state === 'pending' &&
            status.method === 'device-code' &&
            status.verificationUrl &&
            status.userCode &&
            !statusFailed && (
              <div className="symposium-device-code">
                <span>Enter this code on OpenAI</span>
                <strong>{status.userCode}</strong>
                <button
                  type="button"
                  onClick={async () => {
                    const generation = version.current;
                    const copied = await copyToClipboard(status.userCode!);
                    if (generation === version.current)
                      setCopyFeedback(
                        copied
                          ? 'Code copied.'
                          : 'Could not copy. Select the code above and copy it manually.',
                      );
                  }}
                >
                  Copy code
                </button>
                {copyFeedback && <span role="status">{copyFeedback}</span>}
                <a href={status.verificationUrl} target="_blank" rel="noopener noreferrer">
                  Open OpenAI sign-in
                </a>
              </div>
            )}
          {status.state === 'pending' && !status.userCode && (
            <p>
              Preparing or recovering sign-in. If you already opened a login browser, continue there
              while Mitzo checks status.
            </p>
          )}
          {status.state === 'pending' && status.expiresAt && (
            <p>
              Mitzo will stop waiting at {new Date(status.expiresAt).toLocaleTimeString()}. This is
              not OpenAI's code-expiry time.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {status.retryBlocked && (
            <p role="alert">
              Sign-in cleanup could not be confirmed. The Mac host needs recovery before another
              code can be issued.
            </p>
          )}
          <div className="symposium-device-actions">
            {statusFailed || status.retryBlocked ? (
              <button type="button" disabled={busy || disabled} onClick={() => void check()}>
                Retry status
              </button>
            ) : status.state === 'pending' ? (
              <button
                type="button"
                disabled={busy || disabled}
                onClick={() => void action('cancel')}
              >
                Cancel sign-in
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || starting || disabled}
                onClick={() => void action('start')}
              >
                {status.state === 'completed' ? 'Reconnect ChatGPT' : 'Get sign-in code'}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                stop();
                setOpen(false);
              }}
            >
              Close
            </button>
          </div>
          <p>
            Connecting refreshes the account catalog. Active seats keep their selected account and
            model.
          </p>
        </>
      )}
    </section>
  );
}
