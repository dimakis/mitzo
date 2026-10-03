import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { MitzoMode } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import './WebSearchConsent.css';

const Consent = z.object({
  ok: z.literal(true),
  grant: z.enum(['unresolved', 'denied', 'allowed']),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().nullable(),
});
type ConsentState = z.infer<typeof Consent>;

// Allow 2 seconds for a newly switched Codex runtime to attach before offering a retry.
class WebAccessLoadError extends Error {}

const CONSENT_ATTACH_RETRY_DELAYS_MS = [0, 500, 1500] as const;

export function WebSearchConsent({
  sessionId,
  mode,
  connected,
  connectionId,
  running,
}: {
  sessionId: string | null;
  mode: MitzoMode;
  connected: boolean;
  connectionId: string | null;
  running: boolean;
}) {
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const previousTurn = useRef({ sessionId, running });
  const pendingTurnRetry = useRef(false);
  const loadPending = useRef(false);
  const canRefresh = !!consent || !!error;

  useEffect(() => {
    setConsent(null);
    setOpen(false);
    setError('');
    pendingTurnRetry.current = false;
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId || !connected || !connectionId) return;
    const controller = new AbortController();
    loadPending.current = true;
    void (async () => {
      try {
        let transientFailure: Error | null = null;
        // The session switch can reach the UI before the Codex runtime is ready.
        for (const delay of CONSENT_ATTACH_RETRY_DELAYS_MS) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (cancelled) return;
          let response: Response;
          try {
            response = await apiFetch(
              `/api/chat/web-search-consent/${encodeURIComponent(sessionId)}`,
              { signal: controller.signal, headers: { 'X-Connection-ID': connectionId } },
            );
          } catch {
            transientFailure = new WebAccessLoadError(
              'Cannot reach the server to load web access. Retry when connected.',
            );
            continue;
          }
          transientFailure = null;
          if (response.status === 404) continue;
          if (!response.ok) {
            const failure = new WebAccessLoadError(
              `Web access setting request was rejected (HTTP ${response.status}).`,
            );
            if (response.status >= 500) {
              transientFailure = failure;
              continue;
            }
            throw failure;
          }
          let value: ConsentState;
          try {
            value = Consent.parse(await response.json());
          } catch {
            throw new WebAccessLoadError('The server returned an invalid web access setting.');
          }
          if (!cancelled) {
            pendingTurnRetry.current = false;
            setConsent(value);
            setError('');
          }
          return;
        }
        if (transientFailure) throw transientFailure;
        // A 404 can mean either another provider or a Codex runtime still starting.
        const metaResponse = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/meta`, {
          signal: controller.signal,
        });
        if (!metaResponse.ok)
          throw new WebAccessLoadError(
            `Could not check this chat's web access support (HTTP ${metaResponse.status}).`,
          );
        const isCodex = z
          .object({ codexQueue: z.object({}).passthrough() })
          .safeParse(await metaResponse.json()).success;
        if (!cancelled) {
          setConsent(null);
          if (isCodex) setError('Web search setting is still starting.');
        }
      } catch (cause) {
        if (!cancelled)
          setError(
            cause instanceof WebAccessLoadError
              ? cause.message
              : 'Cannot reach the server to load web access. Retry when connected.',
          );
      } finally {
        if (!cancelled) loadPending.current = false;
      }
    })();
    return () => {
      cancelled = true;
      loadPending.current = false;
      controller.abort();
    };
  }, [sessionId, connected, connectionId, reload]);

  useEffect(() => {
    const finished =
      previousTurn.current.sessionId === sessionId && previousTurn.current.running && !running;
    previousTurn.current = { sessionId, running };
    // Keep one retry available if a still-pending read fails after turn completion.
    if (finished && (loadPending.current || !consent || error)) pendingTurnRetry.current = true;
    if (!running && error && pendingTurnRetry.current && connected && connectionId) {
      pendingTurnRetry.current = false;
      setReload((value) => value + 1);
    }
  }, [sessionId, running, consent, error, connected, connectionId]);

  useEffect(() => {
    if (!sessionId || !connected || !connectionId || !canRefresh || saving) return;
    const refresh = () => setReload((value) => value + 1);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [sessionId, connected, connectionId, canRefresh, saving]);

  async function update(grant: 'allowed' | 'denied') {
    if (!sessionId || !consent || saving || running || !connected || !connectionId) return;
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch('/api/chat/web-search-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Connection-ID': connectionId },
        body: JSON.stringify({ sessionId, expectedRevision: consent.revision, grant }),
      });
      if (!response.ok)
        throw new Error('Setting changed or the conversation is busy. Refresh and try again.');
      setConsent(Consent.parse(await response.json()));
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update web access.');
    } finally {
      setSaving(false);
    }
  }

  if (!consent && !error) return null;
  const label =
    consent?.grant === 'allowed' ? 'Allowed' : consent?.grant === 'denied' ? 'Denied' : 'Choose';
  return (
    <div className="web-search-consent">
      {consent && (
        <button
          type="button"
          className="web-search-consent-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Web search permission: {label}
          {mode === 'ask' ? ' (off in Ask)' : ''}
        </button>
      )}
      {error && (
        <span role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setError('');
              setReload((value) => value + 1);
            }}
          >
            Refresh setting
          </button>
        </span>
      )}
      {consent && open && (
        <div className="web-search-consent-panel">
          <p>
            Allow sends model-generated searches to the model provider's hosted web search for this
            conversation. Searches are not approved one by one.
          </p>
          {mode === 'ask' && (
            <p>
              Deny access here, switch to Agent or Auto, then Allow. Web search stays off in Ask
              mode.
            </p>
          )}
          <p>This setting applies to the conversation in all tabs.</p>
          <div className="web-search-consent-actions">
            <button
              type="button"
              disabled={saving || running || !connected || mode === 'ask'}
              aria-pressed={consent.grant === 'allowed'}
              onClick={() => void update('allowed')}
            >
              Allow for this conversation
            </button>
            <button
              type="button"
              disabled={saving || running || !connected}
              aria-pressed={consent.grant === 'denied'}
              onClick={() => void update('denied')}
            >
              Deny
            </button>
          </div>
          {(saving || running) && <span role="status">Changes are available between turns.</span>}
        </div>
      )}
    </div>
  );
}
