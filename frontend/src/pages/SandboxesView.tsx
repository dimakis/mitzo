import { createBrowserId } from '../lib/browser-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { UiIcon } from '../components/UiIcon';
import { HomeDialog } from '../components/HomeDialog';
import { MotionPresence } from '../components/MotionPresence';
import { EmptyState } from '../components/EmptyState';
import { readApiJson } from '../lib/api-json-read';
import { apiFetch } from '../lib/api-fetch';
import type {
  SandboxesInventory,
  SandboxPoolSettings,
  SandboxSpare,
  SandboxConversation,
  SandboxCleanupPreview,
} from '../types/sandboxes';
import './SandboxesView.css';

const stateLabel = (s: SandboxSpare) =>
  s.observedState === 'ready' && s.state === 'ready'
    ? 'Ready'
    : s.state === 'preparing'
      ? 'Preparing'
      : 'Needs review';
export function SandboxesView() {
  const [data, setData] = useState<SandboxesInventory | null>(null),
    [draft, setDraft] = useState<SandboxPoolSettings | null>(null),
    [dirty, setDirty] = useState(false),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [resources, setResources] = useState(false),
    [selected, setSelected] = useState<SandboxSpare | null>(null),
    [remove, setRemove] = useState(false),
    [conversation, setConversation] = useState<SandboxConversation | null>(null),
    [preview, setPreview] = useState<SandboxCleanupPreview | null>(null),
    [ack, setAck] = useState(false);
  const mounted = useRef(false),
    inFlight = useRef(false),
    dirtyRef = useRef(false),
    epoch = useRef(0),
    cleanupEpoch = useRef(0);
  const refresh = useCallback(
    async (signal?: AbortSignal, replaceDraft = false, acceptRevision = false) => {
      const generation = ++epoch.current;
      setRefreshing(true);
      try {
        const next = await readApiJson<SandboxesInventory>('/api/sandboxes', signal);
        if (
          !next ||
          !next.settings ||
          !Number.isInteger(next.revision) ||
          !Array.isArray(next.spares) ||
          !Array.isArray(next.conversations)
        )
          throw Error('Sandbox inventory is unavailable.');
        if (!mounted.current || generation !== epoch.current || signal?.aborted) return;
        setData(next);
        setError('');
        if (acceptRevision && dirtyRef.current) {
          setRevision(next.revision);
          setMessage('Inventory refreshed. Review your unsaved settings before saving.');
        }
        if (!dirtyRef.current || replaceDraft) {
          setDraft(next.settings);
          setRevision(next.revision);
          setDirty(false);
          dirtyRef.current = false;
        }
      } catch (e) {
        if (mounted.current && generation === epoch.current && !signal?.aborted)
          setError(e instanceof Error ? e.message : 'Could not load sandboxes.');
      } finally {
        if (mounted.current && generation === epoch.current) setRefreshing(false);
      }
    },
    [],
  );
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [refresh]);
  const change = <K extends keyof SandboxPoolSettings>(key: K, value: SandboxPoolSettings[K]) => {
    if (!draft || !data) return;
    if (!dirtyRef.current) setRevision(data.revision);
    setDraft({ ...draft, [key]: value });
    setDirty(true);
    dirtyRef.current = true;
    setMessage('');
  };
  const mutate = async (
    action: string,
    extra: Record<string, unknown> = {},
    success = 'Sandbox inventory updated.',
  ) => {
    if (!data || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await apiFetch('/api/sandboxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          requestId: createBrowserId(),
          revision: action === 'settings' ? revision : data.revision,
          ...extra,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw Error(
          typeof body.error === 'string'
            ? body.error
            : 'Sandbox operation outcome is unknown. Refresh before retrying.',
        );
      if (!mounted.current) return;
      setSelected(null);
      setRemove(false);
      if (action === 'settings') dirtyRef.current = false;
      await refresh(undefined, action === 'settings');
      setMessage(success);
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : 'Sandbox operation outcome is unknown. Refresh before retrying.',
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const reviewCleanup = async (item: SandboxConversation) => {
    const generation = ++cleanupEpoch.current;
    setConversation(item);
    setPreview(null);
    setAck(false);
    setError('');
    if (!item.canReviewCleanup) return;
    try {
      const next = await readApiJson<SandboxCleanupPreview>(
        '/api/openshell/lifecycle/' + encodeURIComponent(item.conversationId) + '/preview',
      );
      if (mounted.current && cleanupEpoch.current === generation) setPreview(next);
    } catch (e) {
      if (mounted.current && cleanupEpoch.current === generation)
        setError(e instanceof Error ? e.message : 'Cleanup review unavailable.');
    }
  };
  const confirmCleanup = async () => {
    if (!preview || !ack || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await apiFetch('/api/openshell/lifecycle/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: preview.token }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error || 'Cleanup outcome is unverified.');
      if (mounted.current) {
        setConversation(null);
        setPreview(null);
        await refresh();
        setMessage('Conversation lifecycle action confirmed.');
      }
    } catch (e) {
      if (mounted.current) {
        setPreview(null);
        setError(e instanceof Error ? e.message : 'Cleanup outcome is unverified.');
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const ready = data?.spares.filter((x) => stateLabel(x) === 'Ready').length ?? 0;
  return (
    <main className="workspace-page sandboxes-page">
      <WorkspacePageHeading
        title="Sandboxes"
        description="Control sandbox readiness, resources and retention."
        actions={
          <>
            <button
              className="home-secondary"
              disabled={refreshing || busy}
              onClick={() => void refresh(undefined, false, true)}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <Link className="home-secondary" to="/chat">
              <UiIcon name="plus" size={16} />
              New chat
            </Link>
          </>
        }
      />
      {error && (
        <div role="alert" className="sandbox-error">
          <p>{error}</p>
          <button
            className="home-secondary"
            disabled={busy || refreshing}
            onClick={() => void refresh(undefined, false, true)}
          >
            Retry inventory
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {!data && !error && <p role="status">Loading sandboxes…</p>}
      {data && draft && (
        <>
          <section className="sandbox-pool" aria-label="Faster new chats">
            <div className="sandbox-section-heading">
              <h2>
                <UiIcon name="layers" size={20} />
                Faster new chats
              </h2>
              <span className="workspace-muted">This workspace</span>
            </div>
            <p className="workspace-muted">
              Shared OpenShell sandboxes, with no account or model provider attached.
            </p>
            {!data.available && (
              <p role="status">
                {data.reason || 'Warm sandbox preparation is unavailable on this host.'}
              </p>
            )}
            <div className="sandbox-section-heading">
              <p className="sandbox-status" role="status">
                {!data.settings.enabled
                  ? 'Warming paused'
                  : data.resting
                    ? 'Resting after inactivity'
                    : `${ready} of ${data.settings.capacity} spares ready`}
                {data.busy ? ' · Operation in progress' : ''}
              </p>
              <button
                className="home-secondary"
                disabled={
                  busy ||
                  data.busy ||
                  !data.available ||
                  data.spares.length >= data.settings.capacity
                }
                onClick={() => void mutate('prepare', {}, 'Pool prepared.')}
              >
                <UiIcon name="plus" size={16} />
                Prepare now
              </button>
            </div>
            <fieldset disabled={busy || data.busy} className="sandbox-settings">
              <legend>Pool settings</legend>
              <label className="sandbox-check">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Enable warming"
                  checked={draft.enabled}
                  disabled={!data.available}
                  onChange={(e) => change('enabled', e.target.checked)}
                />
                <span>Enable warming</span>
              </label>
              <div className="sandbox-fields">
                <label className="connections-field">
                  Warm spares
                  <select
                    value={draft.capacity}
                    onChange={(e) => change('capacity', Number(e.target.value))}
                  >
                    <option value={1}>1 spare</option>
                    <option value={2}>2 spares</option>
                  </select>
                </label>
                <label className="connections-field">
                  Replenishment
                  <select
                    value={draft.refill}
                    onChange={(e) => change('refill', e.target.value as 'auto' | 'manual')}
                  >
                    <option value="auto">Automatic</option>
                    <option value="manual">Manual preparation</option>
                  </select>
                </label>
                <label className="connections-field">
                  Release unused spares after
                  <select
                    value={draft.expiryMinutes}
                    onChange={(e) => change('expiryMinutes', Number(e.target.value))}
                  >
                    <option value={30}>30 minutes without a new chat</option>
                    <option value={120}>2 hours without a new chat</option>
                    <option value={0}>Keep until removed</option>
                  </select>
                </label>
                <div className="connections-field">
                  <span>Knowledge seed</span>
                  <span>Current workspace</span>
                  <small>Verified at preparation and rechecked at claim.</small>
                </div>
              </div>
              <button
                className="sandbox-disclosure"
                aria-expanded={resources}
                aria-controls="sandbox-resources"
                onClick={() => setResources(!resources)}
              >
                <UiIcon name={resources ? 'down' : 'forward'} size={16} />
                Resources per sandbox
              </button>
              <MotionPresence open={resources} kind="disclosure" id="sandbox-resources">
                <div className="sandbox-fields sandbox-resource-fields">
                  <label className="connections-field">
                    CPU
                    <select
                      disabled={!data.capabilities.cpu}
                      value={draft.cpu}
                      onChange={(e) => change('cpu', Number(e.target.value))}
                    >
                      {[1, 2, 4].map((n) => (
                        <option key={n} value={n}>
                          {n} vCPU
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="connections-field">
                    Memory
                    <select
                      disabled={!data.capabilities.memory}
                      value={draft.memoryGiB}
                      onChange={(e) => change('memoryGiB', Number(e.target.value))}
                    >
                      {[2, 4, 8].map((n) => (
                        <option key={n} value={n}>
                          {n} GiB
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="connections-field">
                    Disk
                    <select
                      disabled
                      aria-label="Disk"
                      aria-describedby="sandbox-disk-reason"
                      value="runtime"
                      onChange={() => {}}
                    >
                      <option value="runtime">Runtime default</option>
                    </select>
                    <small id="sandbox-disk-reason">{data.capabilities.diskReason}</small>
                  </label>
                </div>
              </MotionPresence>
              <p className="workspace-muted">
                {draft.refill === 'auto'
                  ? 'Automatic preparation fills the target when warming starts and after a claim.'
                  : 'Prepare now fills the target. Claimed spares are not replaced automatically.'}{' '}
                Expiry releases unclaimed spares and rests the pool until the next new chat or
                Prepare now.
              </p>
              <p className="workspace-muted">
                Resource changes replace unused spares. Existing conversation sandboxes keep their
                settings.
              </p>
              <div className="sandbox-settings-footer">
                <p className="workspace-muted">
                  Pool ceiling: {draft.capacity * draft.cpu} vCPU ·{' '}
                  {draft.capacity * draft.memoryGiB} GiB memory
                </p>
                <div className="sandbox-actions">
                  <button
                    className="home-secondary"
                    disabled={!dirty}
                    onClick={() => {
                      setDraft(data.settings);
                      setRevision(data.revision);
                      setDirty(false);
                      dirtyRef.current = false;
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="sandbox-save"
                    disabled={busy || !dirty || (!data.available && draft.enabled)}
                    onClick={() =>
                      void mutate('settings', { settings: draft }, 'Sandbox settings saved.')
                    }
                  >
                    {busy ? 'Saving…' : 'Save settings'}
                  </button>
                </div>
              </div>
              <p className="workspace-muted" role="status">
                {dirty ? 'Unsaved changes' : 'Saved settings'}
              </p>
            </fieldset>
          </section>
          <section aria-label="Warm sandbox inventory">
            <h2 className="sandbox-group-title">
              Warm spares <span className="workspace-muted">{data.spares.length}</span>
            </h2>
            {data.spares.length ? (
              <div className="access-row-group">
                {data.spares.map((item, i) => (
                  <div className="access-row" key={item.id}>
                    <span className="access-row-icon">
                      <UiIcon name="layers" />
                    </span>
                    <div className="access-row-copy">
                      <h3>Warm spare {i + 1}</h3>
                      <p>
                        No provider · No account · {item.resources.cpu} vCPU ·{' '}
                        {item.resources.memoryGiB} GiB
                      </p>
                    </div>
                    <span
                      className={
                        'sandbox-state ' +
                        (stateLabel(item) === 'Ready' ? 'sandbox-ready' : 'sandbox-warning')
                      }
                    >
                      {stateLabel(item)}
                    </span>
                    <button
                      className="home-secondary"
                      onClick={() => {
                        setSelected(item);
                        setRemove(false);
                      }}
                    >
                      Details
                      <UiIcon name="forward" size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<UiIcon name="layers" />}
                title="No spare prepared"
                subtitle="Use Prepare now to fill the saved target."
              />
            )}
            <p className="workspace-muted sandbox-caption">
              Account and agent software are selected at claim. Native seat routes continue to
              create their sandbox on demand.
            </p>
          </section>
          <section aria-label="Conversation sandboxes">
            <h2 className="sandbox-group-title">
              Conversations <span className="workspace-muted">{data.conversations.length}</span>
            </h2>
            {data.conversations.length ? (
              <div className="access-row-group">
                {data.conversations.map((item) => (
                  <div className="access-row" key={item.conversationId}>
                    <span className="access-row-icon">
                      <UiIcon name="chats" />
                    </span>
                    <div className="access-row-copy">
                      <h3>{item.title}</h3>
                      <p>
                        {item.account} · {item.state.replaceAll('_', ' ')}
                      </p>
                    </div>
                    <button className="home-secondary" onClick={() => void reviewCleanup(item)}>
                      Details
                      <UiIcon name="forward" size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="workspace-muted">No managed conversation sandboxes recorded.</p>
            )}
          </section>
        </>
      )}
      {selected && (
        <HomeDialog
          title={remove ? 'Remove this spare?' : 'Warm spare'}
          onClose={() => {
            if (!busy) {
              setSelected(null);
              setRemove(false);
            }
          }}
        >
          {error && <p role="alert">{error}</p>}
          {remove ? (
            <>
              <p>
                This removes only the unused spare and pauses warming. Other spares and conversation
                sandboxes are retained.
              </p>
              <div className="sandbox-actions">
                <button className="home-secondary" disabled={busy} onClick={() => setRemove(false)}>
                  Cancel
                </button>
                <button
                  className="sandbox-danger"
                  disabled={busy}
                  onClick={() =>
                    void mutate('remove', { id: selected.id }, 'Spare removed. Warming paused.')
                  }
                >
                  Remove spare and pause
                </button>
              </div>
            </>
          ) : (
            <>
              <dl className="sandbox-facts">
                <div>
                  <dt>State</dt>
                  <dd>{stateLabel(selected)}</dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>Unassigned</dd>
                </div>
                <div>
                  <dt>Account</dt>
                  <dd>None attached</dd>
                </div>
                <div>
                  <dt>Agent software</dt>
                  <dd>Selected at claim</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>Warm pool · Unclaimed</dd>
                </div>
                <div>
                  <dt>Resources</dt>
                  <dd>
                    {selected.resources.cpu} vCPU · {selected.resources.memoryGiB} GiB memory
                  </dd>
                </div>
                <div>
                  <dt>Model process</dt>
                  <dd>Not started</dd>
                </div>
                <div>
                  <dt>Sandbox</dt>
                  <dd>
                    <code>{selected.name}</code>
                  </dd>
                </div>
              </dl>
              {selected.failure && <p role="alert">{selected.failure}</p>}
              <p>
                At claim, Mitzo rechecks knowledge and runtime compatibility before attaching the
                selected account.
              </p>
              <div className="sandbox-actions">
                {(stateLabel(selected) === 'Ready' || selected.canRetire === true) && (
                  <>
                    <button
                      className="home-secondary"
                      disabled={busy}
                      onClick={() => void mutate('replace', { id: selected.id }, 'Spare replaced.')}
                    >
                      Replace spare
                    </button>
                    <button
                      className="sandbox-danger"
                      disabled={busy}
                      onClick={() => setRemove(true)}
                    >
                      Remove spare
                    </button>
                  </>
                )}
                {stateLabel(selected) !== 'Ready' && (
                  <button
                    className="home-secondary"
                    disabled={busy}
                    onClick={() =>
                      void mutate('recheck', { id: selected.id }, 'Ownership rechecked.')
                    }
                  >
                    Recheck ownership
                  </button>
                )}
              </div>
            </>
          )}
        </HomeDialog>
      )}
      {conversation && (
        <HomeDialog
          title={conversation.title}
          onClose={() => {
            if (!busy) {
              cleanupEpoch.current++;
              setConversation(null);
              setPreview(null);
            }
          }}
        >
          {error && <p role="alert">{error}</p>}
          <p>
            {conversation.account} · {conversation.state.replaceAll('_', ' ')}
          </p>
          <p>This sandbox belongs to its conversation and never returns to the warm pool.</p>
          <p>
            <code>{conversation.sandboxName}</code>
          </p>
          <Link
            className="home-secondary"
            to={'/chat/' + encodeURIComponent(conversation.conversationId)}
          >
            Open chat
          </Link>
          {!conversation.canReviewCleanup ? (
            <p className="workspace-muted">
              Cleanup controls are unavailable for this conversation. Open its chat to review active
              work.
            </p>
          ) : !preview ? (
            <p role="status">
              Cleanup preview unavailable or loading. Close and reopen to review again.
            </p>
          ) : preview.action === 'none' ? (
            <p className="workspace-muted">
              Cleanup is blocked:{' '}
              {preview.blockers.length
                ? preview.blockers.map((x) => x.replaceAll('_', ' ')).join(', ')
                : 'retention policy does not permit a change yet'}
              .
            </p>
          ) : (
            <>
              <p>
                {preview.action === 'stop'
                  ? 'Checkpoint and stop this sandbox. Its workspace is preserved.'
                  : 'Delete this stopped sandbox after its checkpoint and retention checks.'}
              </p>
              <label className="sandbox-check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I reviewed this lifecycle action and its effect on sandbox files.</span>
              </label>
              <button
                className="sandbox-danger"
                disabled={!ack || busy}
                onClick={() => void confirmCleanup()}
              >
                {preview.action === 'stop' ? 'Checkpoint and stop' : 'Delete retained sandbox'}
              </button>
            </>
          )}
        </HomeDialog>
      )}
    </main>
  );
}
