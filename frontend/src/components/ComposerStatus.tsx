import {
  createContext,
  useCallback,
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

type Notice = {
  message: string;
  tone?: 'normal' | 'warning' | 'danger';
  busy?: boolean;
  queued?: number;
  children?: ReactNode;
};
type Sink = {
  report(id: string, notice: Notice | null): void;
  mountRail(): () => void;
  close(): void;
};
const SinkContext = createContext<Sink | null>(null);
const ActiveContext = createContext(false);
const ViewContext = createContext<{
  notices: Map<string, Notice>;
  open: boolean;
  setOpen(open: boolean): void;
} | null>(null);

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

export function useComposerStatusSink() {
  return useContext(SinkContext);
}

/** Keep existing controls and their owners; only their presentation moves into details. */
export function ComposerStatusNotice({ message, tone = 'normal', busy, queued, children }: Notice) {
  const sink = useComposerStatusSink();
  const active = useContext(ActiveContext);
  const id = useId();
  useLayoutEffect(() => {
    if (!sink) return;
    sink.report(id, { message, tone, busy, queued, children });
    return () => sink.report(id, null);
  }, [sink, id, message, tone, busy, queued, children]);
  if (sink && active) return null;
  return children ?? <p role={tone === 'danger' ? 'alert' : 'status'}>{message}</p>;
}

export function ComposerStatusRail({ running = false }: { running?: boolean }) {
  const sink = useComposerStatusSink();
  const view = useContext(ViewContext);
  useLayoutEffect(() => sink?.mountRail(), [sink]);
  if (!view) return null;
  const notices = [...view.notices.values()];
  const issues = notices.filter((notice) => notice.tone !== 'normal');
  const score = (notice: Notice) =>
    notice.tone === 'danger' ? 100 : notice.tone === 'warning' ? 80 : notice.queued ? -1 : 10;
  const primary = notices.reduce<Notice | undefined>(
    (best, notice) => (!best || score(notice) > score(best) ? notice : best),
    undefined,
  );
  const queued = notices.reduce((count, notice) => count + (notice.queued ?? 0), 0);
  const message =
    issues.length > 1
      ? `Needs attention · ${issues.length} issues`
      : primary && score(primary) >= 0
        ? primary.message
        : running
          ? 'Working'
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
        <span className="composer-status-dot" aria-hidden="true" />
        <span
          className="composer-status-summary"
          role={issues.length ? 'alert' : 'status'}
          title={message}
        >
          {message}
        </span>
        {queued > 0 && (
          <button
            type="button"
            className="composer-status-count"
            aria-label={`${queued} queued messages`}
            onClick={() => view.setOpen(true)}
          >
            {queued} queued
          </button>
        )}
        {issues.length > 0 && (
          <button
            type="button"
            className="composer-status-review"
            onClick={() => view.setOpen(true)}
          >
            Review
          </button>
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
          {[...view.notices].map(([id, notice]) => (
            <section key={id} className="composer-status-detail" data-tone={notice.tone}>
              {notice.children ?? <p>{notice.message}</p>}
            </section>
          ))}
        </HomeDialog>
      </SinkContext.Provider>
    </>
  );
}
