import { useEffect, useState } from 'react';
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

  useEffect(() => {
    setConsent(null);
    setOpen(false);
    setError('');
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId || !connected || !connectionId || running) return;
    const controller = new AbortController();
    void (async () => {
      try {
        // The session switch can reach the UI before the server attaches its owner.
        for (const delay of [0, 500, 1500]) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (cancelled) return;
          const response = await apiFetch(
            `/api/chat/web-search-consent/${encodeURIComponent(sessionId)}`,
            { signal: controller.signal, headers: { 'X-Connection-ID': connectionId } },
          );
          if (response.status === 404) continue;
          if (!response.ok) throw new Error('Could not load web access setting.');
          const value = Consent.parse(await response.json());
          if (!cancelled) {
            setConsent(value);
            setError('');
          }
          return;
        }
        if (!cancelled) setConsent(null); // Other providers have no native search grant.
      } catch {
        if (!cancelled) setError('Could not load web access setting.');
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, connected, connectionId, running, reload]);

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
          {mode === 'ask' && <p>Web search stays off in Ask mode, even if access is allowed.</p>}
          <div className="web-search-consent-actions">
            <button
              type="button"
              disabled={saving || running || !connected}
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
