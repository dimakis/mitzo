import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import './RepositoryChatPicker.css';

export interface RepositoryChatSelection {
  repositoryWorkspaceId?: string;
  blocked: boolean;
}
const workspaceSchema = z.object({
  id: z.uuid(),
  repository: z.string(),
  baseBranch: z.string(),
  baseOid: z.string().regex(/^[a-f0-9]{40}$/),
  featureBranch: z.string(),
  state: z.enum(['preview', 'ready']),
});
type Workspace = z.infer<typeof workspaceSchema>;
const catalogSchema = z.object({
  available: z.boolean(),
  repositories: z.array(
    z.object({
      connectionId: z.string(),
      label: z.string(),
      repository: z.string(),
    }),
  ),
});
type Catalog = z.infer<typeof catalogSchema>;
export function RepositoryChatPicker({
  accountId,
  model,
  onChange,
}: {
  accountId: string;
  model: string;
  onChange(value: RepositoryChatSelection | null): void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState('');
  const [url, setUrl] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const callback = useRef(onChange);
  callback.current = onChange;
  const operation = useRef<AbortController | null>(null);
  const storageKey = `mitzo-repository-draft:${accountId}:${model}`;
  useEffect(() => {
    const controller = new AbortController();
    callback.current(null);
    let restoring = false;
    const query = new URLSearchParams({ accountId, model });
    void Promise.resolve(
      apiFetch(`/api/repository-workspaces/catalog?${query}`, { signal: controller.signal }),
    )
      .then(async (response) => {
        if (!response?.ok) return;
        const data = catalogSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setCatalog(data);
        let saved: string | null = null;
        try {
          saved = sessionStorage.getItem(storageKey);
        } catch {
          /* Storage is optional. */
        }
        if (!data.available || !saved) return;
        restoring = true;
        setOpened(true);
        callback.current({ blocked: true });
        const restored = await apiFetch(`/api/repository-workspaces/${saved}?${query}`, {
          signal: controller.signal,
        });
        if (!restored.ok) {
          setError(
            'Saved repository preparation is unavailable. Preview again or continue without a repository.',
          );
          return;
        }
        const ready = workspaceSchema.parse(await restored.json());
        if (controller.signal.aborted || ready.state !== 'ready') return;
        setWorkspace(ready);
        setOpened(true);
        callback.current({ repositoryWorkspaceId: ready.id, blocked: false });
      })
      .catch(() => {
        if (!controller.signal.aborted && restoring)
          setError(
            'Repository preparation unavailable. Preview again or continue without a repository.',
          );
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [accountId, model, storageKey]);
  if (!catalog?.available) return null;
  if (!catalog.repositories.length)
    return (
      <p className="repository-chat-hint">
        Assign a GitHub connection with repository access to this AI account in{' '}
        <a href="/connections">Connections</a>.
      </p>
    );
  const selection =
    selected === 'url'
      ? catalog.repositories.find((entry) => {
          const normalized = url
            .replace(/^https:\/\/github\.com\//, '')
            .replace(/\.git$/, '')
            .toLowerCase();
          return entry.repository.toLowerCase() === normalized;
        })
      : catalog.repositories.find(
          (entry) => `${entry.connectionId}:${entry.repository}` === selected,
        );
  async function requestWorkspace(action: 'preview' | 'prepare') {
    if (!selection || busy) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    callback.current({ blocked: true });
    try {
      if (action === 'prepare' && workspace) {
        try {
          sessionStorage.setItem(storageKey, workspace.id);
        } catch {
          /* The current draft still retains its original operation ID. */
        }
      }
      const endpoint =
        action === 'preview'
          ? '/api/repository-workspaces/preview'
          : `/api/repository-workspaces/${workspace!.id}/prepare`;
      const response = await apiFetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          model,
          ...(action === 'preview'
            ? {
                connectionId: selection.connectionId,
                repository: selected === 'url' ? url : selection.repository,
              }
            : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          typeof data.error === 'string' ? data.error : 'Repository preparation failed',
        );
      const result = workspaceSchema.parse(data);
      if (controller.signal.aborted) return;
      setWorkspace(result);
      if (result.state === 'ready') {
        try {
          sessionStorage.setItem(storageKey, result.id);
        } catch {
          /* The current draft still holds the receipt. */
        }
        callback.current({ repositoryWorkspaceId: result.id, blocked: false });
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Repository preparation unavailable');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const changeSource = (value: string) => {
    setSelected(value);
    setWorkspace(null);
    setError('');
    callback.current({ blocked: true });
  };
  const cancel = async () => {
    if (busy) return;
    if (workspace) {
      const query = new URLSearchParams({ accountId, model });
      const response = await apiFetch(`/api/repository-workspaces/${workspace.id}?${query}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        setError('Could not discard this preparation. Retry before choosing another repository.');
        return;
      }
    }
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Storage is optional. */
    }
    setOpened(false);
    setWorkspace(null);
    setSelected('');
    setError('');
    callback.current(null);
  };
  return (
    <section className="repository-chat-picker" aria-label="Repository for new chat">
      {!opened ? (
        <button
          type="button"
          onClick={() => {
            setOpened(true);
            callback.current({ blocked: true });
          }}
        >
          Add repository
        </button>
      ) : (
        <>
          <strong>
            {workspace?.state === 'ready' ? workspace.repository : 'Repository for this chat'}
          </strong>
          {workspace?.state !== 'ready' && (
            <>
              <label>
                GitHub repository
                <select
                  value={selected}
                  disabled={busy}
                  onChange={(event) => changeSource(event.target.value)}
                >
                  <option value="">Select repository</option>
                  {catalog.repositories.map((entry) => (
                    <option
                      key={`${entry.connectionId}:${entry.repository}`}
                      value={`${entry.connectionId}:${entry.repository}`}
                    >
                      {entry.repository} · {entry.label}
                    </option>
                  ))}
                  <option value="url">Paste a GitHub URL</option>
                </select>
              </label>
              {selected === 'url' && (
                <label>
                  Repository URL
                  <input
                    type="url"
                    value={url}
                    disabled={busy}
                    onChange={(event) => {
                      setUrl(event.target.value);
                      setWorkspace(null);
                      callback.current({ blocked: true });
                    }}
                    placeholder="https://github.com/owner/repository"
                  />
                </label>
              )}
              {selected === 'url' && url && !selection && (
                <p>
                  Add this repository to the GitHub connection’s allowed repositories in{' '}
                  <a href="/connections">Connections</a>.
                </p>
              )}
              <button
                type="button"
                disabled={busy || !selection}
                onClick={() => void requestWorkspace('preview')}
              >
                Preview repository
              </button>
            </>
          )}
          {workspace && (
            <div className="repository-chat-preview">
              <span>
                {workspace.baseBranch} · <code>{workspace.baseOid.slice(0, 12)}</code>
              </span>
              <span>
                New branch: <code>{workspace.featureBranch}</code>
              </span>
              {workspace.state === 'preview' ? (
                <>
                  <p>
                    Repository contents will be shared with the selected AI account when you send
                    your first prompt. Preparation downloads the source into an independent
                    workspace.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void requestWorkspace('prepare')}
                  >
                    Prepare repository
                  </button>
                </>
              ) : (
                <p role="status">
                  Ready for your first prompt. Dependency setup happens in the chat workspace.
                </p>
              )}
            </div>
          )}
          {busy && <p role="status">Preparing repository…</p>}
          {error && <p role="alert">{error}</p>}
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            Continue without repository
          </button>
        </>
      )}
    </section>
  );
}
