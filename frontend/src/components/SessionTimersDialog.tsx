import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionTimerSchema, type SessionTimer } from '@mitzo/protocol';
import { z } from 'zod';
import { HomeDialog } from './HomeDialog';
import { apiFetch } from '../lib/api-fetch';
import '../styles/session-timers.css';

const Sessions = z.array(z.object({ sessionId: z.string(), title: z.string() }));
type Form = {
  prompt: string;
  sessionId: string;
  interval: string;
  unit: 'minutes' | 'hours';
  first: 'later' | 'now';
  end: 'cancel' | 'count';
  count: string;
  editing: SessionTimer | null;
};
const when = (value: number | null) =>
  value === null
    ? '—'
    : new Date(value).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
const title = (timer: SessionTimer) => timer.prompt.split('\n')[0];
const status = (timer: SessionTimer) =>
  ({
    active:
      timer.nextRunAt !== null && timer.nextRunAt <= Date.now() ? 'Waiting for session' : 'Active',
    paused: 'Paused',
    blocked: 'Needs attention',
    cancelled: 'Cancelled',
    completed: 'Run limit reached',
  })[timer.status];
class TimerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function read(path: string, init?: RequestInit) {
  const response = await apiFetch(path, init);
  const data: unknown = await response.json();
  if (!response.ok)
    throw new TimerHttpError(
      z.object({ error: z.string() }).safeParse(data).data?.error ??
        'Timers are unavailable. Try again.',
      response.status,
    );
  return data;
}
export function SessionTimersDialog({
  sessionId,
  initialPrompt = '',
  initiallyCreating = false,
  onClose,
}: {
  sessionId?: string;
  initialPrompt?: string;
  initiallyCreating?: boolean;
  onClose(): void;
}) {
  const [timers, setTimers] = useState<SessionTimer[]>([]);
  const [sessions, setSessions] = useState<z.infer<typeof Sessions>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('all');
  const [form, setForm] = useState<Form | null>(initiallyCreating ? newForm() : null);
  const retry = useRef<{ fingerprint: string; requestId: string } | null>(null);
  function newForm(timer?: SessionTimer): Form {
    return {
      prompt: timer?.prompt ?? initialPrompt,
      sessionId: timer?.sessionId ?? sessionId ?? '',
      interval: String(timer?.intervalMinutes ?? 10),
      unit: 'minutes',
      first: 'later',
      end: timer?.maxRuns ? 'count' : 'cancel',
      count: String(timer?.maxRuns ?? 6),
      editing: timer ?? null,
    };
  }
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [saved, choices] = await Promise.all([
        read('/api/session-timers', { signal }),
        read('/api/session-timers/sessions', { signal }),
      ]);
      if (signal?.aborted) return;
      const nextSessions = Sessions.parse(choices);
      setTimers(z.array(SessionTimerSchema).parse(saved));
      setSessions(nextSessions);
      setError(null);
      setForm((current) =>
        current && !current.sessionId && nextSessions.length
          ? { ...current, sessionId: nextSessions[0].sessionId }
          : current,
      );
    } catch (failure) {
      if (!signal?.aborted)
        setError(failure instanceof Error ? failure.message : 'Unable to load timers.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(controller.signal);
    }, 15_000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [load]);
  const timer = timers.find((t) => t.id === selected);
  const sessionTitle = (id: string) => sessions.find((s) => s.sessionId === id)?.title ?? id;
  function requestId(input: unknown) {
    const fingerprint = JSON.stringify(input);
    if (retry.current && retry.current.fingerprint !== fingerprint)
      throw Error(
        'A previous save may have succeeded. Retry the unchanged save, or go back to Timers and check before creating different work.',
      );
    retry.current ??= { fingerprint, requestId: crypto.randomUUID() };
    return retry.current.requestId;
  }
  async function mutate(path: string, input: object) {
    setSaving(true);
    setError(null);
    setNotice('');
    try {
      const result = SessionTimerSchema.parse(
        await read(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, requestId: requestId([path, input]) }),
        }),
      );
      retry.current = null;
      setTimers((previous) => [result, ...previous.filter((t) => t.id !== result.id)]);
      setSelected(result.id);
      setForm(null);
      setNotice('Timer saved.');
    } catch (failure) {
      if (
        failure instanceof TimerHttpError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 409
      )
        retry.current = null;
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to confirm the change. Retry uses the same request.',
      );
    } finally {
      setSaving(false);
    }
  }
  function action(action: 'pause' | 'resume' | 'cancel' | 'run') {
    if (timer)
      void mutate(`/api/session-timers/${encodeURIComponent(timer.id)}`, {
        expectedRevision: timer.revision,
        action,
      });
  }
  function save() {
    if (!form) return;
    const intervalMinutes = Number(form.interval) * (form.unit === 'hours' ? 60 : 1);
    const maxRuns = form.end === 'count' ? Number(form.count) : null;
    if (!form.prompt.trim() || !form.sessionId) {
      setError('Choose a session and write the prompt to send.');
      return;
    }
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 1 ||
      intervalMinutes > 10080 ||
      (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000))
    ) {
      setError('Choose an interval from 1 minute to 7 days, and a run limit from 1 to 1,000.');
      return;
    }
    const fields = { prompt: form.prompt.trim(), intervalMinutes, maxRuns };
    if (form.editing)
      void mutate(`/api/session-timers/${encodeURIComponent(form.editing.id)}`, {
        ...fields,
        action: 'update',
        expectedRevision: form.editing.revision,
      });
    else
      void mutate('/api/session-timers', {
        ...fields,
        sessionId: form.sessionId,
        startImmediately: form.first === 'now',
      });
  }
  function back() {
    setForm(null);
    setSelected(null);
    setError(null);
    retry.current = null;
    void load();
  }
  const heading = form
    ? form.editing
      ? 'Edit timer'
      : 'Schedule a prompt'
    : timer
      ? 'Timer details'
      : 'Timers';
  const patch = (values: Partial<Form>) =>
    setForm((current) => current && { ...current, ...values });
  return (
    <HomeDialog
      title={heading}
      onClose={onClose}
      onBack={form || timer ? back : undefined}
      className="session-timers-dialog"
    >
      <div className="session-timers-body">
        {error && (
          <div role="alert" className="session-timer-error">
            <p>{error}</p>
            <button
              type="button"
              className="home-secondary"
              disabled={saving}
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="session-timer-notice">
            {notice}
          </p>
        )}
        {form ? (
          <div className="session-timer-form">
            <label>
              Prompt
              <textarea
                aria-label="Prompt"
                value={form.prompt}
                maxLength={16000}
                onChange={(event) => patch({ prompt: event.target.value })}
                rows={5}
              />
            </label>
            <label>
              Send to session
              <select
                aria-label="Send to session"
                value={form.sessionId}
                disabled={!!form.editing || loading}
                onChange={(event) => patch({ sessionId: event.target.value })}
              >
                {!form.sessionId && <option value="">Choose a session</option>}
                {form.sessionId && !sessions.some((s) => s.sessionId === form.sessionId) && (
                  <option value={form.sessionId}>
                    {form.sessionId === sessionId ? 'This session' : form.sessionId}
                  </option>
                )}
                {sessions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.title}
                  </option>
                ))}
              </select>
              <span className="session-timer-help">
                Uses that session’s existing account, tools, and permissions.
              </span>
            </label>
            <div className="session-timer-fields">
              <label>
                Every
                <input
                  aria-label="Every"
                  type="number"
                  min={1}
                  max={10080}
                  value={form.interval}
                  onChange={(event) => patch({ interval: event.target.value })}
                />
              </label>
              <label>
                Unit
                <select
                  aria-label="Interval unit"
                  value={form.unit}
                  onChange={(event) => patch({ unit: event.target.value as Form['unit'] })}
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                </select>
              </label>
            </div>
            <div className="session-timer-fields">
              {!form.editing && (
                <label>
                  First check
                  <select
                    value={form.first}
                    onChange={(event) => patch({ first: event.target.value as Form['first'] })}
                  >
                    <option value="later">After one interval</option>
                    <option value="now">Immediately</option>
                  </select>
                </label>
              )}
              <label>
                Ends
                <select
                  value={form.end}
                  onChange={(event) => patch({ end: event.target.value as Form['end'] })}
                >
                  <option value="cancel">When cancelled</option>
                  <option value="count">After a run limit</option>
                </select>
              </label>
            </div>
            {form.end === 'count' && (
              <label>
                Total checks
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={form.count}
                  onChange={(event) => patch({ count: event.target.value })}
                />
              </label>
            )}
            <p className="session-timer-help">
              Each check sends an ordinary prompt and may use paid tokens. Busy sessions keep one
              pending check. You can pause or cancel any timer. Expired authorization requires you
              to sign in and resume.
            </p>
          </div>
        ) : timer ? (
          <>
            <p className="session-timer-status" data-status={timer.status}>
              {status(timer)} · Every {timer.intervalMinutes} minutes
            </p>
            <p className="session-timer-prompt">{timer.prompt}</p>
            <dl className="session-timer-metadata">
              <div>
                <dt>Session</dt>
                <dd>{sessionTitle(timer.sessionId)}</dd>
              </div>
              <div>
                <dt>Next check</dt>
                <dd>{when(timer.nextRunAt)}</dd>
              </div>
              <div>
                <dt>Origin</dt>
                <dd>{timer.createdBy === 'agent' ? 'Created by agent' : 'Created by you'}</dd>
              </div>
              <div>
                <dt>Prompts sent</dt>
                <dd>
                  {timer.runCount}
                  {timer.maxRuns !== null ? ` of ${timer.maxRuns}` : ''}
                </dd>
              </div>
              <div>
                <dt>Last prompt sent</dt>
                <dd>{when(timer.lastRunAt)}</dd>
              </div>
              <div>
                <dt>Ends</dt>
                <dd>{timer.maxRuns ? `After ${timer.maxRuns} prompts` : 'When cancelled'}</dd>
              </div>
            </dl>
            {timer.lastError && <p className="session-timer-error">{timer.lastError}</p>}
            <a href={`/chat/${encodeURIComponent(timer.sessionId)}`} className="session-timer-link">
              Open session
            </a>
            {!['cancelled', 'completed'].includes(timer.status) && (
              <div className="home-inline-actions session-timer-actions">
                <button
                  type="button"
                  className="home-secondary"
                  disabled={saving}
                  onClick={() => action(timer.status === 'active' ? 'pause' : 'resume')}
                >
                  {timer.status === 'active' ? 'Pause timer' : 'Resume timer'}
                </button>
                <button
                  type="button"
                  className="home-secondary"
                  disabled={saving || timer.status === 'blocked'}
                  onClick={() => action('run')}
                >
                  Run now
                </button>
                <button
                  type="button"
                  className="home-secondary"
                  disabled={saving}
                  onClick={() => {
                    setForm(newForm(timer));
                    setNotice('');
                  }}
                >
                  Edit
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="session-timer-help">
              Scheduled prompts across your sessions. You control timers created by agents too.
            </p>
            <label className="session-timer-filter">
              Show
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option value="all">All timers</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="blocked">Needs attention</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            {loading ? (
              <p role="status">Loading timers…</p>
            ) : !error && !timers.length ? (
              <p>No timers yet. Schedule a prompt to check in on a session.</p>
            ) : null}
            <ul className="session-timer-list">
              {timers
                .filter((t) => filter === 'all' || t.status === filter)
                .map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      aria-label={title(t)}
                      onClick={() => {
                        setSelected(t.id);
                        setNotice('');
                      }}
                    >
                      <strong>{title(t)}</strong>
                      <span>
                        {sessionTitle(t.sessionId)} · Every {t.intervalMinutes} minutes
                      </span>
                      <span>
                        {status(t)}
                        {t.nextRunAt ? ` · Next ${when(t.nextRunAt)}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
      <footer>
        {form ? (
          <button
            type="button"
            className="home-primary"
            disabled={saving || loading}
            onClick={save}
          >
            {saving ? 'Saving…' : form.editing ? 'Save changes' : 'Create timer'}
          </button>
        ) : timer && !['cancelled', 'completed'].includes(timer.status) ? (
          <button
            type="button"
            className="home-secondary home-danger"
            disabled={saving}
            onClick={() => action('cancel')}
          >
            Cancel timer
          </button>
        ) : (
          !timer && (
            <button
              type="button"
              className="home-primary"
              disabled={loading}
              onClick={() => {
                setForm(newForm());
                setNotice('');
              }}
            >
              New timer
            </button>
          )
        )}
      </footer>
    </HomeDialog>
  );
}
