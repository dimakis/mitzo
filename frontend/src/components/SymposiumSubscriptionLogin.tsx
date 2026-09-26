import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import './SymposiumSubscriptionLogin.css';

const receiptSchema = z.object({
  attemptId: z.string().min(1),
  authorizationUrl: z.string().url(),
});
const statusSchema = z.object({
  state: z.enum(['idle', 'pending', 'completed', 'failed', 'unknown']),
  attemptId: z.string().optional(),
});

export function SymposiumSubscriptionLogin({
  onComplete,
  disabled = false,
}: {
  onComplete(): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [transport, setTransport] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<z.infer<typeof receiptSchema> | null>(null);
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const complete = useRef(onComplete);
  complete.current = onComplete;

  useEffect(() => {
    if (!receipt || state !== 'pending') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await apiFetch(
          `/api/symposium/personal/login/status?attemptId=${encodeURIComponent(receipt.attemptId)}`,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(
            'Could not check login. Keep the callback browser open and retry status.',
          );
        const status = statusSchema.parse(await response.json());
        if (!live) return;
        if (status.state === 'pending' && status.attemptId === receipt.attemptId) {
          timer = setTimeout(() => void poll(), 2000);
          return;
        }
        setReceipt(null);
        if (status.state === 'completed' && status.attemptId === receipt.attemptId) {
          setState('completed');
          complete.current();
        } else {
          setState('failed');
          setReady(false);
          setError(
            status.state === 'failed'
              ? 'Login failed or expired. Ensure callback port 1455 is available, prepare the browser setup, and start again.'
              : 'No matching login receipt remains. The server may have restarted. Check the callback browser, prepare the setup, and start again.',
          );
        }
      } catch {
        if (live) {
          setState('status-error');
          setError('Could not check login. Keep the callback browser open and retry status.');
        }
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [receipt, state]);

  const start = async () => {
    if (!ready || !transport || busy) return;
    setBusy(true);
    setError('');
    setReceipt(null);
    try {
      const response = await apiFetch('/api/symposium/personal/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackTransport: transport }),
      });
      if (!response.ok)
        throw new Error(
          'Login is unavailable or already pending. Check the existing callback browser and host port 1455, then retry after it finishes or expires.',
        );
      const result = receiptSchema.parse(await response.json());
      const url = new URL(result.authorizationUrl);
      if (
        url.origin !== 'https://auth.openai.com' ||
        url.pathname !== '/oauth/authorize' ||
        url.username ||
        url.password
      )
        throw new Error(
          'The server returned an unexpected authorization address. Check the host configuration before retrying.',
        );
      setReceipt(result);
      setState('pending');
    } catch (cause) {
      setState('failed');
      setReady(false);
      setError(
        cause instanceof Error && !('issues' in cause)
          ? cause.message
          : 'The login response was invalid. Check the host configuration.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        Connect personal subscription
      </button>
    );
  return (
    <section className="symposium-subscription-login" aria-label="Personal subscription login">
      <h4>Connect ChatGPT subscription</h4>
      <p>
        A phone cannot complete this localhost callback. Use a browser on the Mitzo server or an
        SSH-capable computer. After login, your phone can use the account in Mitzo.
      </p>
      <fieldset disabled={disabled || busy || state === 'pending' || state === 'status-error'}>
        <legend>Where will you open the login browser?</legend>
        <label>
          <input
            type="radio"
            name="callback-transport"
            checked={transport === 'host-local'}
            onChange={() => {
              setTransport('host-local');
              setReady(false);
            }}
          />
          Browser on the Mitzo server
        </label>
        <label>
          <input
            type="radio"
            name="callback-transport"
            checked={transport === 'ssh-forwarded'}
            onChange={() => {
              setTransport('ssh-forwarded');
              setReady(false);
            }}
          />
          Browser on another computer with SSH
        </label>
        {transport === 'ssh-forwarded' && (
          <>
            <p>
              Run this on the browser computer, replace USER@MITZO_HOST, and keep it running until
              login finishes:
            </p>
            <pre>
              ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:1455:127.0.0.1:1455 USER@MITZO_HOST
            </pre>
          </>
        )}
        {transport && (
          <>
            <p>
              Callback: http://localhost:1455/auth/callback. Keep this address unchanged. The
              browser must resolve localhost to or fall back to IPv4 127.0.0.1; IPv6-only localhost
              will fail.
            </p>
            <label>
              <input
                type="checkbox"
                checked={ready}
                onChange={(event) => setReady(event.target.checked)}
              />
              The callback setup is ready on the browser computer
            </label>
          </>
        )}
        <button type="button" disabled={!transport || !ready} onClick={() => void start()}>
          {busy ? 'Starting login…' : 'Start personal login'}
        </button>
      </fieldset>
      {receipt && (
        <>
          <a
            href={receipt.authorizationUrl}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            Open official OpenAI login
          </a>
          <p role="status">
            Waiting for login. Open this link only on the prepared browser computer and complete
            within ten minutes. Do not share callback URLs or codes.
          </p>
        </>
      )}
      {state === 'completed' && (
        <p role="status">
          Login completed. Refreshing account catalog; choose the account and model explicitly.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {state === 'status-error' && (
        <button
          type="button"
          onClick={() => {
            setError('');
            setState('pending');
          }}
        >
          Retry status
        </button>
      )}
      <button type="button" onClick={() => setOpen(false)}>
        Hide login setup
      </button>
    </section>
  );
}
