import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  MitzoNotification,
  NotificationFilter,
  NotificationPreferences,
  QuestionAnswers,
} from '@mitzo/protocol';
import { useNotifications } from '../components/NotificationProvider';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { UiIcon } from '../components/UiIcon';
import { apiFetch } from '../lib/api-fetch';
import '../styles/notifications.css';
const filters: [NotificationFilter, string][] = [
  ['all', 'All'],
  ['needs', 'Needs you'],
  ['sessions', 'Sessions'],
  ['updates', 'Updates'],
  ['history', 'History'],
];
const labels = {
  approval: 'Session approval',
  question: 'Session question',
  session: 'Session update',
  update: 'Mitzo Inbox',
  test: 'Test notification',
};
function timestamp(at: number) {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function actionable(item: MitzoNotification) {
  return (
    !!item.permId &&
    !item.resolution &&
    (item.expiresAt === undefined || item.expiresAt > Date.now())
  );
}
function RequestDetail({
  item,
  onRespond,
  busy,
}: {
  item: MitzoNotification;
  onRespond: (decision: 'once' | 'deny', answers?: QuestionAnswers) => void;
  busy: boolean;
}) {
  const [selections, setSelections] = useState<QuestionAnswers>({});
  const [written, setWritten] = useState<Record<string, string>>({});
  const request = item.request;
  const answers = Object.fromEntries(
    (request?.questions ?? []).map((q) => [
      q.id,
      [...(selections[q.id] ?? []), ...(written[q.id]?.trim() ? [written[q.id].trim()] : [])],
    ]),
  );
  const complete = request?.questions?.every((q) => answers[q.id].length > 0);
  const live = actionable(item);
  return (
    <section className="notification-detail" aria-label="Notification details">
      <div className="notification-meta">
        <span>{labels[item.kind]}</span>
        <span>{timestamp(item.createdAt)}</span>
      </div>
      <h2>{item.title}</h2>
      <p className="workspace-muted">{item.body}</p>
      {item.sessionId && (
        <Link to={`/chat/${encodeURIComponent(item.sessionId)}`}>Open session</Link>
      )}
      {item.inboxFilename && (
        <Link to={`/inbox?item=${encodeURIComponent(item.inboxFilename)}`}>Open in Inbox</Link>
      )}
      {request?.questions?.map((q) => (
        <fieldset key={q.id} className="notification-question">
          <legend>{q.question}</legend>
          {q.options.map((option) => (
            <label key={option.label}>
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={q.id}
                checked={(selections[q.id] ?? []).includes(option.label)}
                disabled={!live || busy}
                onChange={(e) => {
                  setWritten((old) => ({ ...old, [q.id]: '' }));
                  setSelections((old) => ({
                    ...old,
                    [q.id]: q.multiSelect
                      ? e.target.checked
                        ? [...(old[q.id] ?? []), option.label]
                        : (old[q.id] ?? []).filter((v) => v !== option.label)
                      : [option.label],
                  }));
                }}
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          {q.allowFreeform !== false && (
            <label>
              Your answer
              <input
                type={q.isSecret ? 'password' : 'text'}
                autoComplete="off"
                maxLength={4000}
                value={written[q.id] ?? ''}
                disabled={!live || busy}
                onChange={(e) => {
                  setWritten((old) => ({ ...old, [q.id]: e.target.value }));
                  if (!q.multiSelect) setSelections((old) => ({ ...old, [q.id]: [] }));
                }}
              />
            </label>
          )}
        </fieldset>
      ))}
      {request && !request.questions && (
        <>
          <p>{request.description}</p>
          <pre className="notification-command">{request.toolInput}</pre>
          <p className="workspace-muted">
            Allow once covers only this request. The existing session policy still applies.
          </p>
        </>
      )}
      {item.permId &&
        (live ? (
          <>
            <p className="workspace-muted">
              {item.expiresAt ? `Expires ${timestamp(item.expiresAt)}` : 'Waiting for a decision'}
            </p>
            <div className="notification-actions">
              <button
                className="notification-button notification-primary"
                disabled={busy || (!!request?.questions && !complete)}
                onClick={() => onRespond('once', request?.questions ? answers : undefined)}
              >
                {request?.questions ? 'Send answer' : 'Allow once'}
              </button>
              <button
                className="notification-button"
                disabled={busy}
                onClick={() => onRespond('deny')}
              >
                Deny
              </button>
            </div>
          </>
        ) : (
          <p className="notification-result">
            <span>
              {item.resolution === 'expired' || !item.resolution
                ? 'Request expired'
                : 'Decision recorded'}
            </span>
            {item.resolution === 'allowed'
              ? ' · allowed'
              : item.resolution === 'denied'
                ? ' · denied'
                : ''}
          </p>
        ))}
    </section>
  );
}
function Preferences({
  value,
  delivery,
  onSave,
  onTest,
  busy,
}: {
  value: NotificationPreferences;
  delivery: { configured: boolean; registeredDevices: number };
  onSave: (v: NotificationPreferences) => void;
  onTest: () => void;
  busy: boolean;
}) {
  const [prefs, setPrefs] = useState(value);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(prefs);
      }}
    >
      <section className="notification-detail">
        <h2>What reaches you</h2>
        <p className="workspace-muted">Requests and updates stay in Mitzo when push is off.</p>
        {(
          [
            ['approvals', 'Session approvals', 'When a session needs permission'],
            ['questions', 'Questions & blocked work', 'When your answer is needed'],
            ['updates', 'Inbox updates', 'Immediate alerts are reserved for trusted producers'],
          ] as const
        ).map(([key, title, description]) => (
          <label className="notification-setting" key={key}>
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <input
              type="checkbox"
              aria-label={title}
              checked={prefs[key]}
              onChange={(e) => setPrefs({ ...prefs, [key]: e.target.checked })}
            />
          </label>
        ))}
        <label className="notification-setting">
          <span>
            <strong>Turn completion</strong>
            <small>Which sessions can interrupt you</small>
          </span>
          <select
            value={prefs.completion}
            onChange={(e) =>
              setPrefs({
                ...prefs,
                completion: e.target.value as NotificationPreferences['completion'],
              })
            }
          >
            <option value="unattended">When I’m away</option>
            <option value="all">All sessions</option>
            <option value="off">Off</option>
          </select>
        </label>
      </section>
      <section className="notification-detail">
        <h2>Delivery & privacy</h2>
        <label className="notification-setting">
          <span>
            <strong>Quiet hours</strong>
            <small>Push waits; the session remains paused. Requests may expire.</small>
          </span>
          <input
            type="checkbox"
            checked={prefs.quietHours}
            onChange={(e) => setPrefs({ ...prefs, quietHours: e.target.checked })}
          />
        </label>
        {prefs.quietHours && (
          <div className="notification-time">
            <label>
              From
              <input
                type="time"
                value={prefs.quietStart}
                onChange={(e) => setPrefs({ ...prefs, quietStart: e.target.value })}
              />
            </label>
            <label>
              Until
              <input
                type="time"
                value={prefs.quietEnd}
                onChange={(e) => setPrefs({ ...prefs, quietEnd: e.target.value })}
              />
            </label>
            <label>
              Timezone
              <input
                value={prefs.timezone}
                onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value })}
              />
            </label>
          </div>
        )}
        <label className="notification-setting">
          <span>
            <strong>Show sensitive details</strong>
            <small>Session names and content in lock-screen previews</small>
          </span>
          <input
            type="checkbox"
            checked={prefs.sensitivePreviews}
            onChange={(e) => setPrefs({ ...prefs, sensitivePreviews: e.target.checked })}
          />
        </label>
        <div className="notification-setting">
          <span>
            <strong>iPhone & Apple Watch</strong>
            <small>
              {!delivery.configured
                ? 'Push is not configured on this server.'
                : delivery.registeredDevices === 0
                  ? 'No devices registered. Open Mitzo on your iPhone and allow notifications.'
                  : `${delivery.registeredDevices} registered device${delivery.registeredDevices === 1 ? '' : 's'}. Watch delivery follows your iPhone settings.`}
            </small>
          </span>
        </div>
        <button
          type="button"
          className="notification-button"
          disabled={busy || !delivery.configured || !delivery.registeredDevices}
          onClick={onTest}
        >
          Send test alert
        </button>
        <p className="workspace-muted">
          Sends a real test alert. Quiet hours apply. APNs acceptance does not confirm Watch
          delivery.
        </p>
      </section>
      <button className="notification-button notification-primary" disabled={busy} type="submit">
        Save preferences
      </button>
    </form>
  );
}
export function NotificationsView() {
  const notifications = useNotifications();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<MitzoNotification | null>(null);
  const [preferences, setPreferences] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = params.get('item');
  const feed = notifications?.feed;
  const fromFeed = feed?.items.find((item) => item.id === id);
  useEffect(() => {
    let cancelled = false;
    if (!id) {
      setSelected(null);
      return;
    }
    if (fromFeed) {
      setSelected(fromFeed);
      return;
    }
    apiFetch(`/api/notifications/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((item) => {
        if (!cancelled) setSelected(item);
      })
      .catch(() => {
        if (!cancelled) setActionError('This notification is unavailable. Return to the list.');
      });
    return () => {
      cancelled = true;
    };
  }, [id, fromFeed]);
  if (!notifications) return null;
  async function act(path: string, body?: unknown, method?: string) {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await notifications!.mutate(path, body, method);
      setNotice(path === '/test' ? 'Test alert queued. Check your iPhone and Watch.' : 'Saved.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Cannot save this change.');
      await notifications!.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="workspace-page notifications-page">
      <div className="notifications-heading">
        <WorkspacePageHeading
          eyebrow="Your workspace"
          title={preferences ? 'Notification preferences' : 'Notifications'}
          description={
            preferences
              ? 'Choose when Mitzo should interrupt you.'
              : feed
                ? `${feed.needsYou} ${feed.needsYou === 1 ? 'item needs' : 'items need'} your attention.`
                : 'A clear view of what needs you, and what’s changed.'
          }
        />
        <button
          className="notification-button"
          onClick={() => {
            setPreferences((v) => !v);
            setActionError('');
            setNotice('');
          }}
        >
          <UiIcon name={preferences ? 'back' : 'settings'} />
          {preferences ? 'Notifications' : 'Preferences'}
        </button>
      </div>
      {notifications.error && (
        <div role="alert" className="workspace-load-error">
          {notifications.error}
          <button onClick={() => void notifications.refresh()}>Retry</button>
        </div>
      )}
      {actionError && (
        <p role="alert" className="notification-error">
          {actionError}
        </p>
      )}
      {notice && (
        <p role="status" className="notification-result">
          {notice}
        </p>
      )}
      {notifications.loading && !feed && <p className="workspace-muted">Loading notifications…</p>}
      {preferences && feed ? (
        <Preferences
          value={feed.preferences}
          delivery={feed.delivery}
          onSave={(value) => void act('/preferences', value, 'PUT')}
          onTest={() => void act('/test')}
          busy={busy}
        />
      ) : id ? (
        <>
          <button
            className="workspace-text-link"
            onClick={() => {
              setParams({});
              setActionError('');
            }}
          >
            ← All notifications
          </button>
          {selected && (
            <RequestDetail
              key={selected.id}
              item={selected}
              busy={busy}
              onRespond={(decision, answers) =>
                void act(`/${encodeURIComponent(selected.id)}/respond`, {
                  sessionId: selected.sessionId,
                  decision,
                  ...(answers ? { answers } : {}),
                })
              }
            />
          )}
        </>
      ) : (
        feed && (
          <>
            <div className="notification-filters" aria-label="Notification filters">
              {filters.map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={notifications.filter === key}
                  onClick={() => notifications.setFilter(key)}
                >
                  {label}
                  {key === 'needs' && feed.needsYou > 0 && (
                    <span className="notification-badge">{feed.needsYou}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="notification-list-heading">
              <span className="workspace-muted">Recent activity</span>
              <button
                className="workspace-text-link"
                disabled={busy}
                onClick={() => void act('/read-updates')}
              >
                Mark updates read
              </button>
            </div>
            <div className="notification-list">
              {feed.items.map((item) => (
                <article
                  className={`notification-card${actionable(item) ? ' notification-needs' : ''}${item.readAt ? ' notification-read' : ''}`}
                  key={item.id}
                >
                  <div className="notification-symbol">
                    <UiIcon
                      name={
                        item.kind === 'approval'
                          ? 'shield'
                          : item.kind === 'question'
                            ? 'chats'
                            : item.kind === 'session'
                              ? 'check'
                              : 'bell'
                      }
                    />
                  </div>
                  <div>
                    <div className="notification-meta">
                      <span>{labels[item.kind]}</span>
                      <span>{timestamp(item.createdAt)}</span>
                      {actionable(item) && <span className="notification-state">Needs you</span>}
                      {item.resolution && (
                        <span className="notification-state">
                          {item.resolution === 'expired' ? 'Expired' : 'Resolved'}
                        </span>
                      )}
                    </div>
                    <h2>{item.title}</h2>
                    <p className="workspace-muted">{item.body}</p>
                    <div className="notification-actions">
                      <button
                        className={`notification-button${actionable(item) ? ' notification-primary' : ''}`}
                        onClick={() => {
                          setSelected(item);
                          setParams({ item: item.id });
                          setActionError('');
                          if (!item.readAt) void act(`/${encodeURIComponent(item.id)}/read`);
                        }}
                      >
                        {actionable(item)
                          ? item.kind === 'question'
                            ? 'Answer question'
                            : 'Review request'
                          : item.resolution
                            ? 'View history'
                            : 'View update'}
                      </button>
                      {!item.permId && !item.readAt && (
                        <button
                          className="workspace-text-link"
                          disabled={busy}
                          onClick={() => void act(`/${encodeURIComponent(item.id)}/read`)}
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {!feed.items.length && (
              <section className="notification-empty">
                <UiIcon name="check" />
                <h2>
                  {notifications.filter === 'needs'
                    ? 'You’re all caught up'
                    : 'No notifications here yet'}
                </h2>
                <p className="workspace-muted">
                  {notifications.filter === 'needs'
                    ? 'No requests need your attention.'
                    : 'New session activity will appear here.'}
                </p>
              </section>
            )}
            {feed.total > 50 && (
              <div className="notification-pagination">
                <button
                  className="notification-button"
                  disabled={notifications.offset === 0}
                  onClick={() => notifications.setOffset(Math.max(0, notifications.offset - 50))}
                >
                  Previous
                </button>
                <span className="workspace-muted">
                  {notifications.offset + 1}–{Math.min(feed.total, notifications.offset + 50)} of{' '}
                  {feed.total}
                </span>
                <button
                  className="notification-button"
                  disabled={notifications.offset + 50 >= feed.total}
                  onClick={() => notifications.setOffset(notifications.offset + 50)}
                >
                  Next
                </button>
              </div>
            )}
            <p className="notification-footnote">
              The badge counts requests that need you. Reading an update does not resolve an
              approval.
            </p>
          </>
        )
      )}
    </main>
  );
}
