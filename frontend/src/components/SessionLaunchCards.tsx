import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  sessionLaunchConfigurationReason,
  sessionLaunchHandoverUrl,
  type SessionLaunchConfig,
  type SessionLaunchRecord,
} from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import { ShareButton } from './ShareButton';
import { SessionLaunchConfigEditor } from './SessionLaunchConfigEditor';
import { TelosLinkedContext } from './TelosLinkedContext';
import { readTelosRolePresentation } from '../lib/telos-role-presentation';
import './SessionLaunchCards.css';
import '../styles/chat-sheets.css';
import type { SessionLaunchOriginData } from '../hooks/useSessionLaunch';

export function SessionLaunchOrigin({ origin }: { origin?: SessionLaunchOriginData }) {
  if (!origin) return null;
  return (
    <p className="session-launch-origin">
      Created from{' '}
      <Link to={`/chat/${encodeURIComponent(origin.sessionId)}`}>
        {origin.title || 'Originating chat'} <UiIcon name="arrowUpRight" size={16} />
      </Link>
    </p>
  );
}

const states = {
  pending: 'Awaiting your approval',
  starting: 'Starting…',
  created: 'Created · start not yet confirmed',
  running: 'Started',
  failed: 'Could not start',
  uncertain: 'Start unconfirmed · check this request',
  cancelled: 'Cancelled',
  assigned: 'Created & assigned',
};

function launchState(request: SessionLaunchRecord) {
  if (request.telos) {
    if (request.state === 'starting') return 'Creating work chat…';
    if (request.state === 'uncertain') return 'Assignment unconfirmed · check this request';
    if (request.state === 'failed') return 'Could not create work chat';
  }
  return states[request.state];
}

function reviewedWorkContext(request: SessionLaunchRecord) {
  if (!request.telos || !request.telosReview) return null;
  const { telos, telosReview } = request;
  const selection = telosReview.selection;
  try {
    readTelosRolePresentation(selection, telosReview.presentation, telosReview.presentationRef);
    if (
      selection.itemId !== telos.itemId ||
      selection.role !== telos.role ||
      selection.brief.revision !== telos.expectedRevision ||
      JSON.stringify(selection.sources.map((source) => source.snapshotId)) !==
        JSON.stringify(telos.sourceSnapshotIds) ||
      JSON.stringify(selection.artifacts) !== JSON.stringify(telos.artifactRefs)
    )
      return null;
    return telosReview;
  } catch {
    // Invalid retained display data must never enable an approval.
    return null;
  }
}

function WorkReview({ request }: { request: SessionLaunchRecord }) {
  const review = reviewedWorkContext(request);
  if (!request.telos || !review) return null;
  return (
    <>
      <p>
        <Link to={`/todos/${encodeURIComponent(request.telos.itemId)}`}>
          {review.presentation.item.title || 'Selected work'}
        </Link>
        {' · '}
        <span>{request.telos.role === 'lead' ? 'Feature lead' : 'Slice worker'}</span>
      </p>
      <TelosLinkedContext
        context={review.selection}
        presentation={review.presentation}
        presentationRef={review.presentationRef}
        summary="Review work context"
      />
      {!review.selection.sources.length && !review.presentation.artifacts.length && (
        <p>No source discussions or materials selected.</p>
      )}
    </>
  );
}

function ConfigSummary({ configuration }: { configuration: SessionLaunchConfig }) {
  return (
    <span className="session-launch-summary">
      {configuration.runtime.account?.model ?? 'Account required'} ·{' '}
      {configuration.runtime.account?.reasoningEffort ?? 'Model default'} ·{' '}
      {configuration.runtime.execution.location === 'local' ? 'Local Mac' : 'OpenShell'}
      {configuration.runtime.execution.targetId && (
        <> · {configuration.runtime.execution.targetId}</>
      )}
    </span>
  );
}

export function LaunchReview({
  request,
  onClose,
  onUpdate,
  disabled,
  create = false,
  readRevision,
  readError,
}: {
  request: SessionLaunchRecord;
  onClose(): void;
  onUpdate(): void;
  disabled: boolean;
  create?: boolean;
  readRevision?: number;
  readError?: string | null;
}) {
  const [title, setTitle] = useState(request.title);
  const [prompt, setPrompt] = useState(request.prompt);
  const [configuration, setConfiguration] = useState(request.configuration);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [authorityLost, setAuthorityLost] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [checkFrom, setCheckFrom] = useState<{
    request: SessionLaunchRecord;
    readRevision?: number;
  } | null>(null);
  const frozen = useRef<{
    title: string;
    prompt: string;
    configuration: SessionLaunchConfig;
    saveAsDefault: boolean;
  } | null>(null);
  const updateConfiguration = useCallback((next: SessionLaunchConfig) => {
    if (!frozen.current) setConfiguration(next);
  }, []);
  const checking = checkFrom !== null;
  const pending = request.state === 'pending';
  const configurationReason =
    (request.telos && !reviewedWorkContext(request)
      ? 'Reviewed work context is unavailable. Check the original request before approving.'
      : null) ??
    sessionLaunchConfigurationReason(configuration) ??
    invalid;
  useEffect(() => {
    if (!checkFrom || busy) return;
    const observed = create
      ? readRevision !== undefined && readRevision > (checkFrom.readRevision ?? 0)
      : request !== checkFrom.request;
    if (!observed) return;
    setAttempted(false);
    setCheckFrom(null);
  }, [request, checkFrom, busy, create, readRevision]);
  useEffect(() => {
    const lost = () => {
      setAuthorityLost(true);
      onClose();
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, lost);
  }, [onClose]);
  const submit = async (action: 'approve' | 'cancel') => {
    if (disabled || busy || authorityLost || attempted || !pending) return;
    if (create && action === 'cancel') {
      onClose();
      return;
    }
    setAttempted(true);
    setBusy(true);
    setError('');
    try {
      if (create && action === 'approve' && !frozen.current)
        frozen.current = {
          title,
          prompt,
          configuration: structuredClone(configuration),
          saveAsDefault,
        };
      const edits = frozen.current ?? { title, prompt, configuration, saveAsDefault };
      const response = await apiFetch(
        create
          ? '/api/session-launch/requests/start'
          : `/api/session-launch/requests/${encodeURIComponent(request.proposalId)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            action === 'approve'
              ? {
                  ...(create
                    ? { requestId: request.requestId, sourceSessionId: request.sourceSessionId }
                    : { expectedRevision: request.revision }),
                  ...edits,
                }
              : { expectedRevision: request.revision },
          ),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        if (
          !create &&
          action === 'approve' &&
          result.code === 'session_launch_preflight_refused' &&
          result.effectStatus === 'not_started'
        ) {
          // The server checked the same pending revision before any allocation.
          // Lost responses and post-admission failures keep their retry fence.
          setAttempted(false);
        }
        throw new Error(result.error || 'The request could not be updated.');
      }
      onUpdate();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request could not be updated.');
    } finally {
      setBusy(false);
    }
  };
  if (!pending)
    return (
      <HomeDialog title="Session configuration" onClose={onClose} className="session-launch-dialog">
        <div className="session-launch-readonly">
          <h3>{request.title}</h3>
          <p>{launchState(request)}</p>
          <WorkReview request={request} />
          <ConfigSummary configuration={request.configuration} />
          <dl>
            <dt>Account</dt>
            <dd>{configuration.runtime.account?.accountId ?? 'Unavailable'}</dd>
            <dt>Agent</dt>
            <dd>
              {configuration.runtime.agentProfile
                ? `${configuration.runtime.agentProfile.profileId} · r${configuration.runtime.agentProfile.revision}`
                : 'Default agent'}
            </dd>
            <dt>Permissions</dt>
            <dd>
              {configuration.mode} ·{' '}
              {configuration.isolation ? 'Isolated checkout' : 'Shared checkout'}
            </dd>
          </dl>
          <details>
            <summary>Original handoff</summary>
            <p className="session-launch-handoff">{request.prompt}</p>
          </details>
          <details>
            <summary>Context &amp; tools</summary>
            <p>{configuration.extraTools.join(', ') || 'Default tools'}</p>
            <p className="session-launch-handoff">
              {configuration.contextBlocks.join('\n\n') || 'No additional context'}
            </p>
            {configuration.repositoryWorkspaceId && (
              <p>Repository: {configuration.repositoryWorkspaceId}</p>
            )}
          </details>
          {request.error && <p role="alert">{request.error}</p>}
        </div>
      </HomeDialog>
    );
  return (
    <HomeDialog
      title={pending ? 'Review new session' : 'Session configuration'}
      onClose={onClose}
      className="session-launch-dialog"
    >
      <div className="session-launch-form">
        <p>
          {request.telos
            ? 'Review the work and settings before creating its assigned chat. Creation does not start work.'
            : 'Review the handoff before starting.'}
        </p>
        <div className="session-launch-fields">
          <fieldset disabled={busy || attempted || Boolean(frozen.current) || disabled || !pending}>
            <WorkReview request={request} />
            <label>
              Title
              <input
                value={frozen.current?.title ?? title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              Handoff prompt
              <textarea
                value={frozen.current?.prompt ?? prompt}
                maxLength={32000}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <details className="session-launch-settings">
              <summary>
                <span>Session settings</span>
                <ConfigSummary configuration={frozen.current?.configuration ?? configuration} />
              </summary>
              <SessionLaunchConfigEditor
                configuration={frozen.current?.configuration ?? configuration}
                onChange={updateConfiguration}
                disabled={busy || attempted || Boolean(frozen.current) || disabled || !pending}
                onValidityChange={setInvalid}
              />
            </details>
            {pending && (
              <label className="session-launch-check">
                <input
                  type="checkbox"
                  checked={frozen.current?.saveAsDefault ?? saveAsDefault}
                  onChange={(event) => setSaveAsDefault(event.target.checked)}
                />
                Save configuration as default
              </label>
            )}
          </fieldset>
        </div>
        {configurationReason && pending && <p role="status">{configurationReason}</p>}
        {disabled && <p role="status">Confirming conversation settings before approval.</p>}
        {error && <p role="alert">{error}</p>}
        {readError && <p role="alert">{readError}</p>}
        {pending && (
          <footer className="home-inline-actions">
            {attempted ? (
              <button
                type="button"
                className="home-secondary"
                disabled={busy || authorityLost}
                onClick={() => {
                  setCheckFrom({ request, readRevision });
                  onUpdate();
                }}
              >
                {checking && !readError ? 'Checking request…' : 'Check request'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="home-primary home-secondary"
                  disabled={
                    busy ||
                    disabled ||
                    authorityLost ||
                    !!configurationReason ||
                    !title.trim() ||
                    !prompt.trim()
                  }
                  onClick={() => void submit('approve')}
                >
                  {request.telos
                    ? 'Approve & create'
                    : frozen.current
                      ? 'Retry start'
                      : 'Approve & start'}
                </button>
                <button
                  type="button"
                  className="home-secondary"
                  disabled={busy || disabled || authorityLost}
                  onClick={() => void submit('cancel')}
                >
                  Cancel request
                </button>
              </>
            )}
          </footer>
        )}
      </div>
    </HomeDialog>
  );
}

export function SessionLaunchCards({
  requests,
  onUpdate,
  disabled = false,
}: {
  requests: SessionLaunchRecord[];
  onUpdate(): void;
  disabled?: boolean;
}) {
  const [review, setReview] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<{ id: string; message: string } | null>(null);
  const resume = async (request: SessionLaunchRecord) => {
    if (disabled || resuming) return;
    setResuming(request.proposalId);
    setResumeError(null);
    try {
      const response = await apiFetch(
        `/api/session-launch/requests/${encodeURIComponent(request.proposalId)}/resume`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision: request.revision }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw Error(
          result.error ||
            'Startup could not be resumed. Open its chat to inspect the retained request.',
        );
      onUpdate();
    } catch (cause) {
      setResumeError({
        id: request.proposalId,
        message:
          cause instanceof Error ? cause.message : 'Check the original request before resuming.',
      });
      onUpdate();
    } finally {
      setResuming(null);
    }
  };
  const selected = requests.find((request) => request.proposalId === review);
  const close = useCallback(() => setReview(null), []);
  if (!requests.length) return null;
  return (
    <aside className="session-launch-cards" aria-label="Agent session requests">
      {requests.map((request) => (
        <article
          className={`session-launch-card session-launch-card--${request.state}`}
          key={request.proposalId}
        >
          <div className="session-launch-event-label">
            <UiIcon name="chats" size={16} />
            <span>
              {request.state === 'assigned'
                ? 'Created a work chat'
                : request.state === 'running'
                  ? 'Started a chat'
                  : 'New chat request'}
            </span>
            <time dateTime={new Date(request.createdAt).toISOString()}>
              {new Date(request.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </div>
          <strong>{request.title}</strong>
          <ConfigSummary configuration={request.configuration} />
          <div className="session-launch-actions">
            <span role="status">{launchState(request)}</span>
            <span className="file-path-group" role="group" aria-label="Handover">
              <span>Handover.md</span>
              <ShareButton filePath={sessionLaunchHandoverUrl(request.proposalId)} />
            </span>
            {request.childSessionId && (
              <Link to={`/chat/${encodeURIComponent(request.childSessionId)}`}>
                Open chat <UiIcon name="arrowUpRight" size={16} />
              </Link>
            )}
            {request.state !== 'cancelled' && (
              <button
                type="button"
                className="home-secondary"
                onClick={() => setReview(request.proposalId)}
              >
                {request.state === 'pending' ? 'Review new session' : 'View configuration'}
              </button>
            )}
            {(request.state === 'uncertain' || request.state === 'starting') && (
              <button type="button" className="home-secondary" onClick={onUpdate}>
                Check request
              </button>
            )}
            {request.state === 'uncertain' && (
              <button
                type="button"
                className="home-secondary"
                disabled={disabled || resuming !== null}
                onClick={() => void resume(request)}
              >
                {resuming === request.proposalId
                  ? 'Recovering…'
                  : request.telos
                    ? 'Recover creation'
                    : 'Resume startup'}
              </button>
            )}
          </div>
          {request.error && <p role="alert">{request.error}</p>}
          {resumeError?.id === request.proposalId && <p role="alert">{resumeError.message}</p>}
        </article>
      ))}
      {selected && (
        <LaunchReview
          key={`${selected.proposalId}:${selected.revision}`}
          request={selected}
          onClose={close}
          onUpdate={onUpdate}
          disabled={disabled}
        />
      )}
    </aside>
  );
}
