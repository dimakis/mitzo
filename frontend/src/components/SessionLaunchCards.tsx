import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionLaunchConfig, SessionLaunchRecord } from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import { SessionLaunchConfigEditor } from './SessionLaunchConfigEditor';
import './SessionLaunchCards.css';
import '../styles/chat-sheets.css';
import type { SessionLaunchOriginData } from '../hooks/useSessionLaunch';

export function SessionLaunchOrigin({ origin }: { origin?: SessionLaunchOriginData }) {
  if (!origin) return null;
  return (
    <p className="session-launch-origin">
      Started from{' '}
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
};

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
}: {
  request: SessionLaunchRecord;
  onClose(): void;
  onUpdate(): void;
  disabled: boolean;
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
  const [checkFrom, setCheckFrom] = useState<SessionLaunchRecord | null>(null);
  const checking = checkFrom !== null;
  const pending = request.state === 'pending';
  useEffect(() => {
    if (!checkFrom || request === checkFrom || busy || request.state !== 'pending') return;
    setAttempted(false);
    setCheckFrom(null);
  }, [request, checkFrom, busy]);
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
    setAttempted(true);
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/session-launch/requests/${encodeURIComponent(request.proposalId)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            action === 'approve'
              ? { expectedRevision: request.revision, title, prompt, configuration, saveAsDefault }
              : { expectedRevision: request.revision },
          ),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The request could not be updated.');
      onUpdate();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request could not be updated.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <HomeDialog
      title={pending ? 'Review new session' : 'Session configuration'}
      onClose={onClose}
      className="session-launch-dialog"
    >
      <div className="session-launch-form">
        <p>Review the handoff before starting.</p>
        <fieldset disabled={busy || attempted || disabled || !pending}>
          <label>
            Title
            <input
              value={title}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Handoff prompt
            <textarea
              value={prompt}
              maxLength={32000}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <details className="session-launch-settings">
            <summary>
              <span>Session settings</span>
              <ConfigSummary configuration={configuration} />
            </summary>
            <SessionLaunchConfigEditor
              configuration={configuration}
              onChange={setConfiguration}
              disabled={busy || attempted || disabled || !pending}
              onValidityChange={setInvalid}
            />
          </details>
          {pending && (
            <label className="session-launch-check">
              <input
                type="checkbox"
                checked={saveAsDefault}
                onChange={(event) => setSaveAsDefault(event.target.checked)}
              />
              Save configuration as default
            </label>
          )}
        </fieldset>
        {invalid && pending && <p role="status">{invalid}</p>}
        {disabled && <p role="status">Confirming conversation settings before approval.</p>}
        {error && <p role="alert">{error}</p>}
        {pending && (
          <footer className="home-inline-actions">
            {attempted ? (
              <button
                type="button"
                className="home-secondary"
                disabled={busy || disabled || authorityLost}
                onClick={() => {
                  setCheckFrom(request);
                  onUpdate();
                }}
              >
                {checking ? 'Checking request…' : 'Check request'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="home-primary"
                  disabled={
                    busy ||
                    disabled ||
                    authorityLost ||
                    !!invalid ||
                    !title.trim() ||
                    !prompt.trim()
                  }
                  onClick={() => void submit('approve')}
                >
                  Approve & start
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
            <span>{request.state === 'running' ? 'Started a chat' : 'New chat request'}</span>
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
            <span role="status">{states[request.state]}</span>
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
                {resuming === request.proposalId ? 'Resuming…' : 'Resume startup'}
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
