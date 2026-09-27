import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { copyToClipboard } from '../lib/clipboard';
import { apiFetch } from '../lib/api-fetch';
import './SymposiumDeviceLogin.css';

const statusSchema = z.object({
  state: z.enum(['idle', 'pending', 'completed', 'failed', 'cancelled', 'expired', 'unknown']),
  attemptId: z.string().min(1).optional(),
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
}: {
  disabled?: boolean;
  onAccountsChanged?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const receipt = useRef<Status>({ state: 'idle' });
  const polling = useRef<number | null>(null);
  const startingVersion = useRef<number | null>(null);
  const [error, setError] = useState('');
  const [copyFeedback, setCopyFeedback] = useState('');
  const [statusFailed, setStatusFailed] = useState(false);
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef<string | undefined>(undefined);
  const previousAttempt = useRef<string | undefined>(undefined);
  const refreshed = useRef(new Set<string>());
  const changed = useRef(onAccountsChanged);
  changed.current = onAccountsChanged;

  function stop() {
    clearTimeout(timer.current);
    version.current += 1;
    startingVersion.current = null;
    setStarting(false);
    setCancelling(false);
    return version.current;
  }
  function schedule(generation: number) {
    clearTimeout(timer.current);
    if (generation === version.current && polling.current !== generation)
      timer.current = setTimeout(() => void check(generation), 2000);
  }
  function accept(value: unknown, expectedId?: string) {
    const next = statusSchema.parse(value);
    if (expectedId && next.attemptId !== expectedId && next.state !== 'unknown')
      throw new Error('Mismatched receipt');
    if (next.state === 'pending' && !next.attemptId) throw new Error('Missing receipt');
    if (next.verificationUrl && next.verificationUrl !== 'https://auth.openai.com/codex/device')
      throw new Error('Unsupported sign-in address');
    // Recovery may still describe the previous attempt until the new start allocates.
    if (
      startingVersion.current === version.current &&
      ((next.attemptId && next.attemptId === previousAttempt.current) ||
        (next.state === 'unknown' && !next.attemptId && !attempt.current))
    )
      return receipt.current;
    if (attempt.current && next.attemptId && next.attemptId !== attempt.current)
      throw new Error('Mismatched active receipt');
    // Idle before allocation is acknowledged does not prove the start failed.
    if (
      next.state === 'idle' &&
      (startingVersion.current === version.current || receipt.current.state !== 'idle')
    )
      return receipt.current;
    // A late allocation reply cannot reopen an attempt already observed terminal.
    if (
      receipt.current.state !== 'idle' &&
      receipt.current.state !== 'pending' &&
      next.state === 'pending' &&
      next.attemptId === attempt.current
    )
      return receipt.current;
    receipt.current = next;
    if (next.state !== 'pending') {
      clearTimeout(timer.current);
      if (next.state !== 'idle') {
        startingVersion.current = null;
        setStarting(false);
      }
    }
    if (next.attemptId !== attempt.current || next.state !== 'pending') setCopyFeedback('');
    attempt.current = next.attemptId ?? attempt.current;
    setStatus(next);
    setError('');
    setStatusFailed(false);
    if (next.state === 'completed' && next.attemptId && !refreshed.current.has(next.attemptId)) {
      refreshed.current.add(next.attemptId);
      changed.current?.();
    }
    return next;
  }
  async function check(generation = stop()) {
    if (generation !== version.current || polling.current === generation) return;
    polling.current = generation;
    clearTimeout(timer.current);
    setBusy(true);
    let continuePolling = false;
    const id = attempt.current;
    try {
      const response = await apiFetch(
        `${endpoint}/status${id ? `?attemptId=${encodeURIComponent(id)}` : ''}`,
      );
      if (!response.ok) throw new Error('Status unavailable');
      const value = await response.json();
      if (generation !== version.current) return;
      if (id !== attempt.current) {
        continuePolling = receipt.current.state === 'pending';
        return;
      }
      const next = accept(value, id);
      continuePolling = next.state === 'pending' || startingVersion.current === generation;
    } catch {
      if (generation !== version.current) return;
      if (id !== attempt.current) {
        continuePolling = receipt.current.state === 'pending';
        return;
      }
      if (!['idle', 'pending'].includes(receipt.current.state)) return;
      setError('Could not check sign-in status. Retry status before starting another attempt.');
      setStatusFailed(true);
    } finally {
      if (polling.current === generation) polling.current = null;
      if (generation === version.current) {
        setBusy(false);
        if (continuePolling) schedule(generation);
      }
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
    setCancelling(kind === 'cancel');
    if (kind === 'start') {
      receipt.current = { state: 'idle' };
      previousAttempt.current = attempt.current;
      attempt.current = undefined;
      startingVersion.current = generation;
      setStarting(true);
      schedule(generation);
    }
    try {
      const response = await apiFetch(kind === 'start' ? endpoint : `${endpoint}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'start' ? { method: 'device-code' } : { attemptId: attempt.current },
        ),
      });
      if (!response.ok) throw new Error('Action unavailable');
      const value = await response.json();
      if (generation !== version.current) return;
      const next = accept(value, kind === 'cancel' ? attempt.current : undefined);
      if (next.state === 'pending') schedule(generation);
    } catch {
      if (generation !== version.current) return;
      if (kind === 'start' && !['idle', 'pending'].includes(receipt.current.state)) return;
      setError('Could not confirm the sign-in request. Check status before trying again.');
      setStatusFailed(true);
    } finally {
      if (generation === version.current) {
        startingVersion.current = null;
        setStarting(false);
        setCancelling(false);
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
            receipt.current = { state: 'idle' };
            setStatus({ state: 'idle' });
            setError('');
            setStatusFailed(false);
            attempt.current = undefined;
            setOpen(true);
            void check();
          }}
        >
          Connect ChatGPT
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
            This Mac holds one personal ChatGPT connection. Reconnect replaces it. Sign in again
            after Mitzo restarts.
          </p>
          {status.state === 'pending' &&
            status.method === 'device-code' &&
            status.verificationUrl &&
            status.userCode && (
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
              This local attempt ends at {new Date(status.expiresAt).toLocaleTimeString()}. OpenAI
              may require a new code sooner.
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
            {(statusFailed || status.retryBlocked) && (
              <button
                type="button"
                disabled={busy || disabled}
                onClick={() => void check(version.current)}
              >
                Retry status
              </button>
            )}
            {status.state === 'pending' ? (
              <button
                type="button"
                disabled={cancelling || disabled}
                onClick={() => void action('cancel')}
              >
                Cancel sign-in
              </button>
            ) : !statusFailed && !status.retryBlocked ? (
              <button
                type="button"
                disabled={busy || starting || disabled}
                onClick={() => void action('start')}
              >
                {status.state === 'completed' ? 'Reconnect ChatGPT' : 'Get sign-in code'}
              </button>
            ) : null}
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
