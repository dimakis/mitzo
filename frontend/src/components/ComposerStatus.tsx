import {
  useCallback,
  useEffect,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import './ComposerStatus.css';
import { useSessionOverview } from '../hooks/useSessionOverview';
import {
  ActivityBars,
  SessionActivityStatus,
  SessionTurnElapsed,
  SessionActivityDetails,
} from './SessionActivityStatus';
import { sessionActivityLabel } from '../lib/session-activity';
import {
  ActiveContext,
  SinkContext,
  ViewContext,
  useComposerStatusSink,
  type ComposerNotice as Notice,
} from '../lib/composer-status-context';

/** Separate the write and view contexts: reporting a notice never rerenders its owner. */
export function ComposerStatusProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState(new Map<string, Notice>());
  const [rails, setRails] = useState(0);
  const [open, setOpen] = useState(false);
  const report = useCallback((id: string, notice: Notice | null) => {
    setNotices((previous) => {
      if (notice === null && !previous.has(id)) return previous;
      const next = new Map(previous);
      if (notice) next.set(id, notice);
      else next.delete(id);
      return next;
    });
  }, []);
  const mountRail = useCallback(() => {
    setRails((count) => count + 1);
    return () => setRails((count) => count - 1);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const sink = useMemo(() => ({ report, mountRail, close }), [report, mountRail, close]);
  const view = useMemo(() => ({ notices, open, setOpen }), [notices, open]);
  return (
    <SinkContext.Provider value={sink}>
      <ActiveContext.Provider value={rails > 0}>
        <ViewContext.Provider value={view}>{children}</ViewContext.Provider>
      </ActiveContext.Provider>
    </SinkContext.Provider>
  );
}

/** Keep existing controls and their owners; only their presentation moves into details. */
export function ComposerStatusNotice({
  message,
  tone = 'normal',
  busy,
  queued,
  action,
  children,
}: Notice) {
  const sink = useComposerStatusSink();
  const active = useContext(ActiveContext);
  const id = useId();
  useLayoutEffect(() => {
    if (!sink) return;
    sink.report(id, { message, tone, busy, queued, action, children });
    return () => sink.report(id, null);
  }, [sink, id, message, tone, busy, queued, action, children]);
  if (sink && active) return null;
  return children ?? <p role={tone === 'danger' ? 'alert' : 'status'}>{message}</p>;
}

export function ComposerStatusRail({
  running = false,
  scope,
  awaitingApproval = false,
  sessionId,
}: {
  running?: boolean;
  scope?: number;
  awaitingApproval?: boolean;
  sessionId?: string;
}) {
  const { activities, connected } = useSessionOverview();
  const activity = activities.find((a) => a.sessionId === sessionId);
  const workingLabel = activity?.state === 'working' ? sessionActivityLabel(activity) : 'Working';
  const sink = useComposerStatusSink();
  const view = useContext(ViewContext);
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    if (view?.open) setVisited(true);
  }, [view?.open]);
  useLayoutEffect(() => {
    sink?.close();
    setVisited(false);
  }, [sink, scope]);
  useLayoutEffect(() => sink?.mountRail(), [sink]);
  if (!view) return null;
  const notices: Notice[] = [...view.notices.values()];
  if (awaitingApproval) notices.unshift({ message: 'Needs your approval', tone: 'warning' });
  const issues = [
    ...new Map(
      notices
        .filter((notice) => notice.tone !== 'normal')
        .map((notice) => [notice.message, notice]),
    ).values(),
  ];
  const score = (notice: Notice) =>
    notice.tone === 'danger'
      ? 100
      : notice.tone === 'warning'
        ? 80
        : notice.queued && !notice.busy
          ? -1
          : 10;
  const primary = notices.reduce<Notice | undefined>(
    (best, notice) => (!best || score(notice) > score(best) ? notice : best),
    undefined,
  );
  const queued = notices.reduce((count, notice) => count + (notice.queued ?? 0), 0);
  const actions = notices.flatMap((notice) => (notice.action ? [notice.action] : []));
  const action = actions.length === 1 ? actions[0] : undefined;
  const message =
    issues.length > 1
      ? `Needs attention · ${issues.length} issues`
      : running && primary?.busy && primary.tone === 'normal'
        ? workingLabel
        : primary && score(primary) >= 0
          ? primary.message
          : running
            ? workingLabel
            : 'Ready';
  const tone = issues.some((notice) => notice.tone === 'danger')
    ? 'danger'
    : issues.length
      ? 'warning'
      : 'normal';
  return (
    <>
      <div
        className="composer-status"
        role="region"
        aria-label="Conversation status"
        data-tone={tone}
      >
        {running && tone === 'normal' ? (
          <ActivityBars />
        ) : (
          <span className="composer-status-dot" aria-hidden="true" />
        )}
        <span
          className="composer-status-summary"
          role={issues.length ? 'alert' : 'status'}
          title={message}
        >
          {message}
        </span>
        {running && tone === 'normal' && activity?.turnStartedAt !== undefined && (
          <SessionTurnElapsed startedAt={activity.turnStartedAt} />
        )}
        {queued > 0 && (
          <button
            type="button"
            className="composer-status-count"
            aria-label={`${queued} queued ${queued === 1 ? 'message' : 'messages'}`}
            onClick={() => view.setOpen(true)}
          >
            {queued} queued
          </button>
        )}
        {action ? (
          <button
            type="button"
            className="composer-status-action"
            title={action.label}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : (
          issues.length > 0 && (
            <button
              type="button"
              className="composer-status-review"
              onClick={() => view.setOpen(true)}
            >
              Review
            </button>
          )
        )}
        <button
          type="button"
          className="composer-status-details"
          aria-label="Conversation status details"
          aria-haspopup="dialog"
          aria-expanded={view.open}
          onClick={() => view.setOpen(true)}
        >
          <UiIcon name="info" size={16} />
        </button>
      </div>
      {(view.open || visited) && (
        <SinkContext.Provider value={null}>
          <HomeDialog
            title="Conversation status"
            open={view.open}
            onClose={() => view.setOpen(false)}
            className="composer-status-dialog"
          >
            <p className="composer-status-baseline">
              {running ? 'Agent working' : 'Ready for your next message'}
            </p>
            {activity && (
              <SessionActivityStatus
                activity={activity}
                modifiedAt={activity.lastEventAt}
                connected={connected}
              />
            )}
            {activity && <SessionActivityDetails activity={activity} connected={connected} />}
            {awaitingApproval && (
              <p>
                A permission request is waiting in this conversation. Review the existing approval
                request to continue.
              </p>
            )}
            {[...view.notices].map(([id, notice]) => (
              <section key={id} className="composer-status-detail" data-tone={notice.tone}>
                {notice.children ?? <p>{notice.message}</p>}
              </section>
            ))}
          </HomeDialog>
        </SinkContext.Provider>
      )}
    </>
  );
}
