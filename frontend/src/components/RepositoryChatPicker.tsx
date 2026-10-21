import { SessionRuntimeBindingV2Schema, type SessionRuntimeBindingV2 } from '@mitzo/protocol';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import './RepositoryChatPicker.css';
import { UiIcon } from './UiIcon';
import { useQuickSettings } from '../lib/quick-settings-context';
import { QuickSettingsField } from './QuickChatSettings';
import {
  repositoryDraftKey,
  savedRepositoryDraft,
  consumeRepositoryDraft,
} from '../lib/repository-draft';

export interface RepositoryChatSelection {
  repositoryWorkspaceId?: string;
  blocked: boolean;
  ordinaryRuntime?: SessionRuntimeBindingV2;
}
const workspaceSchema = z.object({
  id: z.uuid(),
  repository: z.string(),
  baseBranch: z.string(),
  baseOid: z.string().regex(/^[a-f0-9]{40}$/),
  featureBranch: z.string(),
  state: z.enum(['preview', 'preparing', 'ready', 'claiming', 'claimed', 'failed', 'discarded']),
  conversationId: z.uuid().optional(),
  ordinaryRuntime: SessionRuntimeBindingV2Schema.optional(),
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
  initialPreparationId,
  draftScoped = false,
  ordinaryRuntime,
  preparationNote,
  presentation = 'default',
}: {
  presentation?: 'default' | 'settings';
  accountId: string;
  model: string;
  onChange(value: RepositoryChatSelection | null): void;
  initialPreparationId?: string;
  /** Ordinary saved drafts never borrow another draft’s per-account preparation. */
  draftScoped?: boolean;
  preparationNote?: string;
  ordinaryRuntime?: {
    runOn: 'local' | 'openshell';
    runtime: {
      account: SessionRuntimeBindingV2['account'];
      harness: SessionRuntimeBindingV2['harness']['implementation'];
      targetId: string;
    };
  };
}) {
  const quick = useQuickSettings();
  const inSettings = !!quick && presentation === 'settings';
  const actionClass = inSettings ? 'home-secondary' : undefined;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [opened, setOpened] = useState(
    () => !!(initialPreparationId ?? (draftScoped ? null : savedRepositoryDraft(accountId, model))),
  );
  const [selected, setSelected] = useState('');
  const [url, setUrl] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [pendingPreparationId, setPendingPreparationId] = useState(
    () => initialPreparationId ?? (draftScoped ? null : savedRepositoryDraft(accountId, model)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retainedConversationId, setRetainedConversationId] = useState<string | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const restoreRefreshFocus = useRef(false);
  useEffect(() => {
    if (busy || !restoreRefreshFocus.current) return;
    restoreRefreshFocus.current = false;
    if (document.activeElement === document.body) refreshButton.current?.focus();
  }, [busy]);
  const callback = useRef(onChange);
  callback.current = onChange;
  const operation = useRef<AbortController | null>(null);
  const restoration = useRef<AbortController | null>(null);
  const storageKey = repositoryDraftKey(accountId, model);
  const [restorationAttempt, setRestorationAttempt] = useState(0);
  const runtimeKey = JSON.stringify(ordinaryRuntime ?? null);
  const previousRuntime = useRef(runtimeKey);
  useEffect(() => {
    if (previousRuntime.current === runtimeKey) return;
    previousRuntime.current = runtimeKey;
    // A preview has not acquired source yet. It must be made again for the
    // current runtime; never prepare the old environment's preview.
    operation.current?.abort();
    setBusy(false);
    if (pendingPreparationId || (workspace && workspace.state !== 'preview')) {
      setError(
        'This preparation belongs to the original execution choices. Restore those choices or remove the preparation.',
      );
      callback.current({
        blocked: true,
        ...(draftScoped && pendingPreparationId
          ? { repositoryWorkspaceId: pendingPreparationId }
          : {}),
      });
    } else {
      setWorkspace(null);
      setError('');
      callback.current(selected ? { blocked: true } : null);
    }
  }, [runtimeKey, pendingPreparationId, workspace, selected, draftScoped]);
  useEffect(() => {
    const controller = new AbortController();
    restoration.current = controller;
    const saved =
      initialPreparationId ?? (draftScoped ? null : savedRepositoryDraft(accountId, model));
    setWorkspace(null);
    setCatalog(null);
    setError('');
    setBusy(false);
    setPendingPreparationId(saved);
    callback.current(
      saved ? { blocked: true, ...(draftScoped ? { repositoryWorkspaceId: saved } : {}) } : null,
    );
    if (saved) setOpened(true);
    const query = new URLSearchParams({ accountId, model });
    void Promise.resolve(
      apiFetch(`/api/repository-workspaces/catalog?${query}`, { signal: controller.signal }),
    )
      .then(async (response) => {
        if (!response?.ok) throw new Error('Repository catalog unavailable');
        const data = catalogSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setCatalog(data);
        if (!saved) return;
        if (!data.available && !initialPreparationId)
          throw new Error('Repository onboarding unavailable');
        const restored = await apiFetch(
          `/api/repository-workspaces/${encodeURIComponent(saved)}?${query}`,
          {
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        if (!restored.ok) {
          setError(
            'Saved repository preparation is unavailable. Discard it below before choosing another repository.',
          );
          return;
        }
        const ready = workspaceSchema.parse(await restored.json());
        if (controller.signal.aborted) return;
        if (ready.id !== saved) throw new Error('Repository preparation identity changed');
        setWorkspace(ready);
        setOpened(true);
        callback.current(
          ready.state === 'ready' && data.available
            ? {
                repositoryWorkspaceId: ready.id,
                blocked: false,
                ordinaryRuntime: ready.ordinaryRuntime,
              }
            : { blocked: true, ...(draftScoped ? { repositoryWorkspaceId: ready.id } : {}) },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted && saved)
          setError(
            'Repository preparation unavailable. Discard it below before choosing another repository.',
          );
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [accountId, model, storageKey, initialPreparationId, draftScoped, restorationAttempt]);
  const repositories = catalog?.available ? catalog.repositories : [];
  const savedId =
    initialPreparationId || draftScoped ? null : savedRepositoryDraft(accountId, model);
  const pendingId = pendingPreparationId ?? savedId;
  const unresolvedSaved = !!pendingId && workspace?.id !== pendingId;
  const selection =
    selected === 'url'
      ? repositories.find((entry) => {
          const normalized = url
            .replace(/^https:\/\/github\.com\//, '')
            .replace(/\.git$/, '')
            .toLowerCase();
          return entry.repository.toLowerCase() === normalized;
        })
      : repositories.find((entry) => `${entry.connectionId}:${entry.repository}` === selected);
  async function requestWorkspace(action: 'preview' | 'prepare') {
    if (!selection || busy || unresolvedSaved || (action === 'preview' && pendingId)) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    let responseReceived = false;
    callback.current({
      blocked: true,
      ...(draftScoped && action === 'prepare' && workspace
        ? { repositoryWorkspaceId: workspace.id }
        : {}),
    });
    try {
      if (action === 'prepare' && workspace) {
        setPendingPreparationId(workspace.id);
        try {
          if (!draftScoped) sessionStorage.setItem(storageKey, workspace.id);
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
                ...(ordinaryRuntime ? { ordinaryRuntime } : {}),
              }
            : {}),
        }),
      });
      responseReceived = true;
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
          if (!draftScoped) sessionStorage.setItem(storageKey, result.id);
        } catch {
          /* The current draft still holds the receipt. */
        }
        callback.current({
          repositoryWorkspaceId: result.id,
          blocked: false,
          ordinaryRuntime: result.ordinaryRuntime,
        });
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          action === 'prepare' && !responseReceived
            ? 'Could not confirm repository preparation. Refresh its status to continue.'
            : failure instanceof Error
              ? failure.message
              : 'Repository preparation unavailable',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const refreshPreparation = async () => {
    const id = pendingId ?? workspace?.id;
    if (!id || busy) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setBusy(true);
    setError('');
    callback.current({ blocked: true, ...(draftScoped ? { repositoryWorkspaceId: id } : {}) });
    try {
      const query = new URLSearchParams({ accountId, model });
      const response = await apiFetch(
        `/api/repository-workspaces/${encodeURIComponent(id)}?${query}`,
        {
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw Error('Repository preparation status is unavailable. Retry before preparing again.');
      const result = workspaceSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      if (result.id !== id) throw Error('Repository preparation identity changed.');
      const bound = result.ordinaryRuntime;
      if (
        ordinaryRuntime &&
        (!bound ||
          bound.execution.location !== ordinaryRuntime.runOn ||
          bound.execution.targetId !== ordinaryRuntime.runtime.targetId ||
          bound.harness.implementation !== ordinaryRuntime.runtime.harness ||
          bound.account.accountId !== ordinaryRuntime.runtime.account.accountId ||
          bound.account.provider !== ordinaryRuntime.runtime.account.provider ||
          bound.account.profileRevision !== ordinaryRuntime.runtime.account.profileRevision)
      )
        throw Error(
          'This preparation belongs to the original execution choices. Restore those choices or remove the preparation.',
        );
      setWorkspace(result);
      callback.current(
        result.state === 'ready' && catalog?.available
          ? { repositoryWorkspaceId: id, blocked: false, ordinaryRuntime: result.ordinaryRuntime }
          : { blocked: true, ...(draftScoped ? { repositoryWorkspaceId: id } : {}) },
      );
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Repository preparation status is unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const changeSource = (value: string) => {
    setSelected(value);
    setWorkspace(null);
    setError('');
    callback.current({ blocked: true });
  };
  const cancel = async () => {
    if (busy) return;
    if (
      initialPreparationId &&
      (!workspace || ['preparing', 'claiming'].includes(workspace.state))
    ) {
      setError('Refresh the original preparation status before removing it.');
      return;
    }
    restoration.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const id = pendingId ?? workspace?.id;
    setBusy(true);
    callback.current({
      blocked: true,
      ...(draftScoped && id ? { repositoryWorkspaceId: id } : {}),
    });
    try {
      if (id && workspace?.state === 'claimed' && workspace.id === id) {
        setRetainedConversationId(workspace.conversationId ?? null);
      } else if (id) {
        const query = new URLSearchParams({ accountId, model });
        const response = await apiFetch(
          `/api/repository-workspaces/${encodeURIComponent(id)}?${query}`,
          {
            method: 'DELETE',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
          },
        );
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error('Discard unavailable');
      }
      if (controller.signal.aborted) return;
      if (id && !draftScoped) consumeRepositoryDraft(storageKey, id);
      setPendingPreparationId(null);
      setOpened(false);
      setWorkspace(null);
      setSelected('');
      setError('');
      callback.current(null);
    } catch {
      if (!controller.signal.aborted)
        setError('Could not discard this preparation. Retry before choosing another repository.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  if ((!catalog?.available || !repositories.length) && !opened && !retainedConversationId) {
    const hint = catalog?.available ? (
      <p className="repository-chat-hint">
        Assign a GitHub connection with repository access to this AI account in{' '}
        <a href="/connections">Connections</a>.
      </p>
    ) : (
      <p className="repository-chat-hint">
        {error || 'Repository choices are unavailable for this account.'}
      </p>
    );
    return quick && presentation === 'settings' ? (
      <QuickSettingsField page="repository" title="Repository" value="Unavailable">
        {hint}
      </QuickSettingsField>
    ) : catalog?.available ? (
      hint
    ) : null;
  }
  const checkoutDetails = workspace && (
    <>
      <span>
        {workspace.baseBranch} · <code>{workspace.baseOid.slice(0, 12)}</code>
      </span>
      <span>
        New branch: <code>{workspace.featureBranch}</code>
      </span>
    </>
  );
  const editor = (
    <section
      className={`repository-chat-picker${inSettings ? ' repository-chat-picker--settings' : ''}`}
      aria-label="Repository for new chat"
    >
      {!opened ? (
        catalog?.available &&
        repositories.length > 0 && (
          <button
            type="button"
            className={actionClass}
            onClick={() => {
              setOpened(true);
              callback.current({ blocked: true });
            }}
          >
            Add repository
          </button>
        )
      ) : (
        <>
          {(!inSettings || (workspace && (pendingId || workspace.state !== 'preview'))) && (
            <strong>
              {workspace && (workspace.state !== 'preview' || (inSettings && pendingId))
                ? workspace.repository
                : 'Repository for this chat'}
            </strong>
          )}
          {!initialPreparationId &&
            (!workspace || workspace.state === 'preview') &&
            !(inSettings && pendingId) && (
              <>
                <label>
                  GitHub repository
                  <select
                    value={selected}
                    disabled={busy || !catalog?.available}
                    onChange={(event) => changeSource(event.target.value)}
                  >
                    <option value="">Select repository</option>
                    {repositories.map((entry) => (
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
                  className={actionClass}
                  disabled={busy || !selection || unresolvedSaved || !!pendingId}
                  onClick={() => void requestWorkspace('preview')}
                >
                  Preview repository
                </button>
              </>
            )}
          {workspace && (
            <div className="repository-chat-preview">
              {inSettings ? (
                <details className="chat-settings-advanced">
                  <summary>
                    <span>Checkout details</span>
                    <UiIcon name="down" size={16} />
                  </summary>
                  <div className="repository-chat-preview">
                    {checkoutDetails}
                    {preparationNote && <p>{preparationNote}</p>}
                  </div>
                </details>
              ) : (
                checkoutDetails
              )}
              {workspace.state === 'preview' &&
              !initialPreparationId &&
              !(inSettings && pendingId) ? (
                <>
                  <p>
                    {inSettings
                      ? 'Prepare an independent checkout. Its contents are shared with the selected AI account when you send your first prompt.'
                      : 'Repository contents will be shared with the selected AI account when you send your first prompt. Preparation downloads the source into an independent workspace.'}
                  </p>
                  <button
                    type="button"
                    className={actionClass}
                    disabled={busy || !!pendingId}
                    onClick={() => void requestWorkspace('prepare')}
                  >
                    Prepare repository
                  </button>
                </>
              ) : (
                <p role="status">
                  {workspace.state === 'preview' && pendingId
                    ? 'Check the original preparation before continuing.'
                    : workspace.state === 'claimed'
                      ? 'This preparation already belongs to a conversation. Open that conversation below, or continue without this repository.'
                      : workspace.state === 'ready'
                        ? 'Ready for your first prompt. Dependency setup happens in the chat workspace.'
                        : `Repository preparation is ${workspace.state}. Refresh its status before sending.`}
                </p>
              )}
            </div>
          )}
          {busy && <p role="status">Preparing repository…</p>}
          {error && <p role="alert">{error}</p>}
          {(initialPreparationId || pendingId || (workspace && workspace.state !== 'preview')) && (
            <button
              type="button"
              className={actionClass}
              disabled={busy}
              ref={refreshButton}
              onClick={(event) => {
                restoreRefreshFocus.current = document.activeElement === event.currentTarget;
                if (!catalog) setRestorationAttempt((value) => value + 1);
                else void refreshPreparation();
              }}
            >
              Refresh preparation status
            </button>
          )}
          <button
            type="button"
            className={actionClass}
            disabled={busy}
            onClick={() => void cancel()}
          >
            Continue without repository
          </button>
        </>
      )}
      {(workspace?.state === 'claimed' ? workspace.conversationId : retainedConversationId) && (
        <a
          href={`/chat/${workspace?.state === 'claimed' ? workspace.conversationId : retainedConversationId}`}
        >
          Open repository conversation
        </a>
      )}
    </section>
  );
  return quick && presentation === 'settings' ? (
    <QuickSettingsField
      page="repository"
      title="Repository"
      value={workspace?.repository ?? (unresolvedSaved ? 'Check preparation' : 'Add repository')}
      add={!workspace && !unresolvedSaved}
      onOpen={() => {
        if (!opened) {
          setOpened(true);
          callback.current({ blocked: true });
        }
      }}
    >
      {editor}
    </QuickSettingsField>
  ) : (
    editor
  );
}
