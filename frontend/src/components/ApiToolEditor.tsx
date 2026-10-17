import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';
import {
  getCachedCredentialAuthorization,
  reauthorizeKeychain,
} from '../lib/credential-connections-api';
import { MotionPresence } from './MotionPresence';

type Configuration = {
  template: 'home-assistant.state@1';
  label: string;
  connectionId: string;
  entityId: string;
};
type Draft = { id: string; version: number; configuration: Configuration; verified: boolean };
type Inventory = {
  templates: {
    id: string;
    label: string;
    description: string;
    method: string;
    path: string;
    source: string;
    implementation: string;
    documentation: string;
    output: string[];
  }[];
  drafts: Draft[];
  connections: { id: string; label: string; endpoint: string }[];
};
async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  csrf?: string,
): Promise<T> {
  // Supported WebKit releases may lack AbortSignal.any and AbortSignal.timeout.
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 30000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await apiFetch('/api/agent-library/api-tools' + path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            headers: {
              'Content-Type': 'application/json',
              ...(csrf ? { 'x-csrf-token': csrf } : {}),
            },
            body: JSON.stringify(body),
          }),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error ?? 'API tool request failed');
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
const blank = (): Draft => ({
  id: createBrowserId(),
  version: 0,
  configuration: { template: 'home-assistant.state@1', label: '', connectionId: '', entityId: '' },
  verified: false,
});
export function ApiToolEditor({ onPublished }: { onPublished(): void }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const [inventory, setInventory] = useState<Inventory>();
  const [draft, setDraft] = useState<Draft>(blank);
  const [dirty, setDirty] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  async function load() {
    setBusy('Loading API templates…');
    setError('');
    try {
      const value = await request<Inventory>('');
      if (
        !Array.isArray(value.templates) ||
        !Array.isArray(value.connections) ||
        !Array.isArray(value.drafts)
      )
        throw Error('API template inventory is unavailable');
      setInventory(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load API templates');
    } finally {
      setBusy('');
    }
  }
  function edit(changes: Partial<Configuration>) {
    setDraft({ ...draft, configuration: { ...draft.configuration, ...changes }, verified: false });
    setDirty(true);
    setNotice('');
  }
  async function run(kind: 'save' | 'verify' | 'publish') {
    setError('');
    setNotice('');
    if (kind === 'verify' && !getCachedCredentialAuthorization()) {
      setAuthorized(false);
      setError('Authorize verification with your app passphrase first.');
      return;
    }
    const pending = new AbortController();
    controller.current = pending;
    setBusy(
      kind === 'save'
        ? 'Saving API draft…'
        : kind === 'verify'
          ? 'Verifying API read…'
          : 'Publishing API tool…',
    );
    if (kind === 'verify') setDraft({ ...draft, verified: false });
    try {
      if (kind === 'publish') {
        await request('/publish', { id: draft.id, version: draft.version }, pending.signal);
        setNotice(
          'Tool published. Add it and RequestConnectionAccess to an agent, publish the profile, then start a new local API chat.',
        );
        onPublished();
      } else {
        const result = await request<{ draft: Draft }>(
          kind === 'save' ? '/drafts' : '/verify',
          kind === 'save'
            ? { id: draft.id, expectedVersion: draft.version, configuration: draft.configuration }
            : { id: draft.id, version: draft.version },
          pending.signal,
          getCachedCredentialAuthorization()?.csrf,
        );
        setDraft(result.draft);
        setDirty(false);
        setInventory((value) =>
          value
            ? {
                ...value,
                drafts: [...value.drafts.filter((d) => d.id !== result.draft.id), result.draft],
              }
            : value,
        );
        setNotice(
          kind === 'save'
            ? 'Draft saved. Verify its read before publishing.'
            : 'API read verified. Ready to publish.',
        );
      }
    } catch (e) {
      setError(
        pending.signal.aborted
          ? 'Verification cancelled. Verify again before publishing.'
          : e instanceof Error
            ? e.message
            : 'API tool request failed',
      );
    } finally {
      controller.current = null;
      setBusy('');
    }
  }
  const template = inventory?.templates[0];
  const connection = inventory?.connections.find((c) => c.id === draft.configuration.connectionId);
  return (
    <section aria-label="Reviewed API tools">
      <div className="agent-library-actions">
        <button
          type="button"
          ref={opener}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (!open && !inventory && !busy) void load();
          }}
        >
          Configure API tool
        </button>
      </div>
      <MotionPresence open={open} kind="disclosure">
        <section
          aria-label="API tool configuration"
          className="agent-library-fields"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <h2>Configure an API tool</h2>
          <p>
            Use a reviewed read-only operation with an existing connection. Verification sends one
            API read; saving a draft sends none.
          </p>
          {busy && <p role="status">{busy}</p>}
          {error && (
            <p role="alert" className="agent-library-error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {!inventory && !busy && (
            <button type="button" onClick={() => void load()}>
              Retry API templates
            </button>
          )}
          {inventory && (
            <>
              <fieldset className="agent-library-fields" disabled={!!busy}>
                <label>
                  Saved API draft
                  <select
                    value={draft.version ? draft.id : ''}
                    onChange={(e) => {
                      const saved = inventory.drafts.find((d) => d.id === e.target.value);
                      setDraft(saved ?? blank());
                      setDirty(!saved);
                      setError('');
                      setNotice('');
                    }}
                  >
                    <option value="">New API tool</option>
                    {inventory.drafts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.configuration.label} · v{d.version}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  <strong>{template?.label}</strong> · Read only
                </p>
                <label>
                  Tool name
                  <input
                    value={draft.configuration.label}
                    maxLength={100}
                    onChange={(e) => edit({ label: e.target.value })}
                  />
                </label>
                <label>
                  Connection
                  <select
                    value={draft.configuration.connectionId}
                    onChange={(e) => edit({ connectionId: e.target.value })}
                  >
                    <option value="">Choose a Home Assistant connection</option>
                    {inventory.connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                {!inventory.connections.length && (
                  <p>
                    No eligible Home Assistant connection. Set one up in{' '}
                    <a href="/connections">Connections</a>, then reload templates.
                  </p>
                )}
                <label>
                  Entity ID
                  <input
                    value={draft.configuration.entityId}
                    placeholder="sensor.office_temperature"
                    maxLength={128}
                    onChange={(e) => edit({ entityId: e.target.value })}
                  />
                </label>
                <details>
                  <summary>Operation and implementation</summary>
                  <p>
                    {template?.method} {connection?.endpoint ?? 'Connection HTTPS origin'}
                    <wbr />
                    /api/states/{draft.configuration.entityId || '{entityId}'}
                  </p>
                  <p>
                    Input: no arguments. Output: {template?.output.join(', ')}. Other response
                    fields are omitted.
                  </p>
                  <p>
                    Authentication: existing managed connection. Each chat requires its own
                    approval.
                  </p>
                  <p>
                    Reviewed implementation: <code>{template?.implementation}</code> in{' '}
                    <code>{template?.source}</code>.
                  </p>
                  <a href={template?.documentation} target="_blank" rel="noreferrer">
                    Operation documentation
                  </a>
                </details>
                <details>
                  <summary>Authorize verification</summary>
                  <p>
                    Use the existing app authorization to permit this API read. This grants no chat
                    access.
                  </p>
                  <label>
                    App passphrase
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!passphrase}
                    onClick={() => {
                      const value = passphrase;
                      setPassphrase('');
                      setBusy('Authorizing verification…');
                      setError('');
                      void reauthorizeKeychain(value)
                        .then(() => setAuthorized(true))
                        .catch((e) => {
                          setAuthorized(false);
                          setError(e.message);
                        })
                        .finally(() => setBusy(''));
                    }}
                  >
                    Authorize API verification
                  </button>
                  {authorized && (
                    <p>Verification authorized for this browser’s current authorization window.</p>
                  )}
                </details>
                <div className="agent-library-actions">
                  <button
                    type="button"
                    disabled={
                      !draft.configuration.label.trim() ||
                      !draft.configuration.connectionId ||
                      !draft.configuration.entityId
                    }
                    onClick={() => void run('save')}
                  >
                    Save draft
                  </button>
                  <button
                    type="button"
                    disabled={dirty || !draft.version}
                    onClick={() => void run('verify')}
                  >
                    Verify API read
                  </button>
                  <button
                    type="button"
                    disabled={dirty || !draft.verified}
                    onClick={() => void run('publish')}
                  >
                    Publish tool
                  </button>
                </div>
              </fieldset>
              {busy === 'Verifying API read…' && (
                <button type="button" onClick={() => controller.current?.abort()}>
                  Cancel verification
                </button>
              )}
              <button type="button" onClick={close}>
                Done configuring
              </button>
            </>
          )}
        </section>
      </MotionPresence>
    </section>
  );
}
