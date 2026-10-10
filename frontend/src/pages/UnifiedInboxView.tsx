import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { InboxFeed, MitzoNotification } from '@mitzo/protocol';
import { useMitzoStore } from '@mitzo/client/hooks';
import { useNotifications } from '../components/NotificationProvider';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { UiIcon } from '../components/UiIcon';
import { RequestDetail } from './NotificationsView';
import { apiFetch, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { buildInboxContext, buildInboxPrompt, stripFrontmatter } from '../lib/inbox-utils';
import {
  inboxNeedsYou,
  inboxSource,
  inboxTitle,
  inboxType,
  inboxSummary,
} from '../lib/unified-inbox';
import '../styles/unified-inbox.css';

const views = [
  ['needs', 'Needs you'],
  ['briefings', 'Briefings'],
  ['proposals', 'Proposals'],
  ['all', 'All'],
  ['archive', 'Archive'],
] as const;
export function InboxRedirect() {
  const [params] = useSearchParams();
  const target = new URLSearchParams(params);
  const id = target.get('item');
  if (id) {
    target.delete('item');
    target.set('notice', id);
  }
  return <Navigate replace to={`/inbox${target.size ? `?${target}` : ''}`} />;
}
export function UnifiedInboxView({ desktop = false }: { desktop?: boolean } = {}) {
  const notifications = useNotifications();
  const mutate = notifications?.mutate;
  const navigate = useNavigate();
  const setPendingSession = useMitzoStore((s) => s.setPendingSession);
  const [params, setParams] = useSearchParams();
  const view = views.some(([v]) => v === params.get('view')) ? params.get('view')! : 'needs';
  const selectedId =
    params.get('notice') || (params.get('item') ? `inbox:${params.get('item')}` : null);
  const options = new URLSearchParams({
    view,
    query: params.get('q') || '',
    source: params.get('source') || '',
    type: params.get('type') || '',
    status: params.get('status') || '',
    age: params.get('age') || 'any',
    offset: String(Math.max(0, Number(params.get('offset')) || 0)),
    limit: '50',
  }).toString();
  const [feed, setFeed] = useState<InboxFeed | null>(null);
  const [selected, setSelected] = useState<MitzoNotification | null>(null);
  const [filters, setFilters] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  const sequence = useRef(0);
  const authGeneration = useRef(0);
  const blocked = useRef(false);
  const read = useRef(new Set<string>());
  const back = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const pageScrollTop = useRef(0);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const lastRow = useRef<string | null>(null);
  const scrollTop = useRef(0);
  const activeId = useRef(selectedId);
  activeId.current = selectedId;
  function update(key: string, value: string) {
    setParams((old) => {
      const next = new URLSearchParams(old);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== 'offset') next.delete('offset');
      return next;
    });
  }
  const refresh = useCallback(async () => {
    if (blocked.current) return;
    const seq = ++sequence.current;
    const generation = authGeneration.current;
    const controller = new AbortController();
    try {
      const response = await apiFetch(`/api/inbox/feed?${options}`, { signal: controller.signal });
      if (!response.ok) throw new Error('Could not load Inbox.');
      const next = (await response.json()) as InboxFeed;
      if (seq !== sequence.current || generation !== authGeneration.current || blocked.current)
        return;
      const pageOffset = Number(new URLSearchParams(options).get('offset')) || 0;
      if (pageOffset > 0 && pageOffset >= next.total) {
        const lastOffset = Math.floor(Math.max(0, next.total - 1) / 50) * 50;
        setParams(
          (old) => {
            const value = new URLSearchParams(old);
            if (lastOffset) value.set('offset', String(lastOffset));
            else value.delete('offset');
            return value;
          },
          { replace: true },
        );
        return;
      }
      setFeed(next);
      setDetailRevision((value) => value + 1);
      setError('');
      setLoading(false);
    } catch {
      if (seq === sequence.current) {
        setError('Could not load Inbox. Try again.');
        setLoading(false);
      }
    }
  }, [options, setParams]);
  const invalidate = useCallback(() => {
    sequence.current++;
  }, []);
  useEffect(() => {
    const lost = () => {
      authGeneration.current++;
      blocked.current = true;
      invalidate();
      setFeed(null);
      setSelected(null);
      read.current.clear();
      setLoading(false);
    };
    const restored = () => {
      blocked.current = false;
      setRevision((n) => n + 1);
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    return () => {
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
    };
  }, [invalidate]);
  useEffect(() => {
    setLoading(true);
    void refresh();
    const unsubscribe = eventBus.on('inbox_updated', () => void refresh());
    const changes = eventBus.on('notifications_changed', () => void refresh());
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(visible, 30000);
    return () => {
      invalidate();
      clearInterval(timer);
      unsubscribe();
      changes();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh, revision, invalidate]);
  useEffect(() => {
    const controller = new AbortController();
    const generation = authGeneration.current;
    setSelected((previous) => (previous?.id === selectedId ? previous : null));
    setDetailError('');
    if (!selectedId || blocked.current) return;
    apiFetch(`/api/inbox/records/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((item: MitzoNotification) => {
        if (controller.signal.aborted || generation !== authGeneration.current || blocked.current)
          return;
        setSelected(item);
        if (item.readAt === null && !read.current.has(item.id) && mutate) {
          read.current.add(item.id);
          void mutate(`/${encodeURIComponent(item.id)}/read`)
            .catch(() => undefined)
            .finally(() => read.current.delete(item.id));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetailError('This item could not be loaded.');
      });
    return () => controller.abort();
  }, [selectedId, revision, detailRevision, mutate]);
  useEffect(() => {
    if (desktop) return;
    if (selectedId) back.current?.focus();
    else if (lastRow.current) {
      if (list.current) list.current.scrollTop = scrollTop.current;
      if (page.current) page.current.scrollTop = pageScrollTop.current;
      rows.current.get(lastRow.current)?.focus({ preventScroll: true });
      lastRow.current = null;
    }
  }, [selectedId, desktop]);
  function close() {
    setParams(
      (old) => {
        const next = new URLSearchParams(old);
        next.delete('notice');
        next.delete('item');
        return next;
      },
      { replace: true },
    );
  }
  function open(item: MitzoNotification) {
    lastRow.current = item.id;
    scrollTop.current = list.current?.scrollTop || 0;
    pageScrollTop.current = page.current?.scrollTop || 0;
    setParams((old) => {
      const next = new URLSearchParams(old);
      next.delete('item');
      next.set('notice', item.id);
      return next;
    });
  }
  async function act(path: string, body?: unknown, resolution = false) {
    if (!notifications || busy) return;
    const id = activeId.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (resolution) {
        const response = await apiFetch(`/api/inbox/records/${encodeURIComponent(id!)}/resolve`, {
          method: 'POST',
        });
        if (!response.ok) throw new Error('Could not resolve this item.');
        await notifications.refresh();
      } else if (body === undefined) await notifications.mutate(path);
      else await notifications.mutate(path, body);
      if (path.endsWith('/archive')) {
        setUndo(decodeURIComponent(path.split('/')[1]));
        setNotice('Archived. You can find it in Archive.');
        if (activeId.current === id) close();
      } else {
        setUndo(null);
        setNotice(path.endsWith('/restore') ? 'Restored to Inbox.' : 'Saved.');
      }
      setRevision((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this change.');
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  function review(item: MitzoNotification) {
    if (!item.inbox || !item.inboxFilename || !item.inbox.content) return;
    const summary = {
      filename: item.inboxFilename,
      agent: item.inbox.agent,
      title: item.title,
      tags: item.inbox.tags,
      timestamp: new Date(item.createdAt).toISOString(),
      preview: item.body,
    };
    setPendingSession({
      prompt: buildInboxPrompt(summary, item.inbox.content),
      context: buildInboxContext(summary, item.inbox.content),
    });
    navigate('/chat');
  }
  const hideList = !desktop && !!selectedId;
  const offset = Number(params.get('offset')) || 0;
  const needsCount = feed?.needsYou ?? notifications?.feed?.needsYou;
  const canArchive = selected && !inboxNeedsYou(selected);
  const detail = selected ? (
    <>
      {selected.inbox ? (
        <>
          <p className="workspace-muted">
            {inboxType(selected)} · {new Date(selected.createdAt).toLocaleDateString()}
          </p>
          <h2>{inboxTitle(selected)}</h2>
          <div className="collection-actions">
            <button className="collection-primary" disabled={busy} onClick={() => review(selected)}>
              Review in session
            </button>
            {inboxNeedsYou(selected) && (
              <button disabled={busy} onClick={() => void act('', undefined, true)}>
                Mark resolved
              </button>
            )}
          </div>
          <div className="proposal-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {stripFrontmatter(selected.inbox.content || selected.body)}
            </ReactMarkdown>
          </div>
          <details className="inbox-provenance">
            <summary>Source &amp; technical details</summary>
            <p>
              {inboxSource(selected.inbox.agent)} · {selected.inbox.agent}
            </p>
            <p>{selected.title}</p>
            <p>{selected.inbox.tags.join(' · ')}</p>
          </details>
        </>
      ) : (
        <RequestDetail
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
      <div className="collection-actions">
        {(canArchive || selected.archivedAt != null) && (
          <button
            disabled={busy}
            onClick={() =>
              void act(
                `/${encodeURIComponent(selected.id)}/${selected.archivedAt != null ? 'restore' : 'archive'}`,
              )
            }
          >
            {selected.archivedAt != null ? 'Restore' : 'Archive'}
          </button>
        )}
      </div>
    </>
  ) : (
    <div className="collection-placeholder">
      <h2>{selectedId ? detailError || 'Loading item…' : 'Select an item'}</h2>
      <p>Read the context and choose what comes next.</p>
      {detailError && <button onClick={() => setRevision((n) => n + 1)}>Retry</button>}
    </div>
  );
  return (
    <div
      ref={page}
      className={`inbox-page unified-inbox ${desktop ? 'collection-page proposals-desktop' : 'proposals-mobile'}`}
    >
      <WorkspacePageHeading
        title="Inbox"
        badge={needsCount || undefined}
        description="Requests, briefings, and suggestions in one place."
        actions={
          <Link className="workspace-text-link" to="/settings/notifications">
            <UiIcon name="settings" />
            Preferences
          </Link>
        }
      />
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
          <button onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {notice && (
        <div role="status" className="inbox-result">
          {notice}
          {undo && (
            <button
              disabled={busy}
              onClick={() => void act(`/${encodeURIComponent(undo)}/restore`)}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {hideList ? (
        <button ref={back} className="proposal-back" onClick={close}>
          <UiIcon name="back" size={16} /> Back to Inbox
        </button>
      ) : (
        <>
          <div className="proposal-search">
            <input
              type="search"
              aria-label="Search your entire inbox"
              placeholder="Search your entire inbox"
              value={params.get('q') || ''}
              onChange={(e) => update('q', e.target.value)}
            />
          </div>
          <div className="inbox-views">
            {views.map(([key, label]) => (
              <button key={key} aria-pressed={key === view} onClick={() => update('view', key)}>
                {label}
                {key === 'needs' && !!needsCount && (
                  <span className="notification-badge">{needsCount}</span>
                )}
              </button>
            ))}
            <button aria-expanded={filters} onClick={() => setFilters((v) => !v)}>
              <UiIcon name="settings" />
              Filters
            </button>
          </div>
          {filters && (
            <div className="inbox-refinements">
              <label>
                Source
                <select
                  aria-label="Source"
                  value={params.get('source') || ''}
                  onChange={(e) => update('source', e.target.value)}
                >
                  <option value="">All sources</option>
                  {feed?.sources.map((source) => (
                    <option key={source} value={source}>
                      {inboxSource(source)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Type
                <select
                  aria-label="Type"
                  value={params.get('type') || ''}
                  onChange={(e) => update('type', e.target.value)}
                >
                  {[
                    ['', 'All types'],
                    ['sessions', 'Session activity'],
                    ['updates', 'Updates'],
                    ['approval', 'Approvals'],
                    ['question', 'Questions'],
                    ['alert', 'Alerts'],
                    ['maintenance', 'Maintenance'],
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Status
                <select
                  aria-label="Status"
                  value={params.get('status') || ''}
                  onChange={(e) => update('status', e.target.value)}
                >
                  <option value="">Any status</option>
                  <option value="unread">Unread</option>
                  <option value="resolved">Resolved</option>
                </select>
              </label>
              <label>
                Date
                <select
                  aria-label="Date"
                  value={params.get('age') || 'any'}
                  onChange={(e) => update('age', e.target.value)}
                >
                  <option value="any">Any time</option>
                  <option value="today">Today</option>
                  <option value="week">Last week</option>
                  <option value="month">Last month</option>
                </select>
              </label>
            </div>
          )}
          <div className="inbox-applied-filters">
            {['source', 'type', 'status', 'age']
              .filter((key) => params.has(key) && params.get(key) !== 'any')
              .map((key) => (
                <button key={key} onClick={() => update(key, '')}>
                  {key === 'source' ? inboxSource(params.get(key)!) : params.get(key)}{' '}
                  <UiIcon name="close" size={16} />
                </button>
              ))}
          </div>
        </>
      )}
      <div className={desktop ? 'collection-panels' : 'collection-mobile-body'}>
        {!hideList && (
          <div className="inbox-scroll" ref={list}>
            <div className="inbox-list-tools">
              <span className="workspace-muted">
                {params.get('q')
                  ? `${feed?.total ?? 0} matches across all views`
                  : `${feed?.total ?? 0} items`}
              </span>
              <button
                disabled={busy}
                className="workspace-text-link"
                onClick={() => void act('/read-updates')}
              >
                Mark updates read
              </button>
            </div>
            {loading && !feed && <p role="status">Loading Inbox…</p>}
            {!loading && !feed?.items.length && (
              <div className="notification-empty">
                <UiIcon name="check" />
                <h2>
                  {params.get('q')
                    ? 'No matches'
                    : view === 'needs'
                      ? 'You’re all caught up'
                      : 'No items here'}
                </h2>
                <p className="workspace-muted">
                  {view === 'needs'
                    ? 'Briefings and optional suggestions stay in their own views.'
                    : 'Try another view or adjust your filters.'}
                </p>
              </div>
            )}
            {feed?.items.map((item) => (
              <button
                className="collection-record proposal-record"
                key={item.id}
                aria-label={inboxTitle(item)}
                aria-current={selectedId === item.id ? 'true' : undefined}
                ref={(node) => {
                  if (node) rows.current.set(item.id, node);
                  else rows.current.delete(item.id);
                }}
                onClick={() => open(item)}
              >
                <span className="proposal-record-meta">
                  <small>
                    {inboxType(item)}
                    {item.resolvedAt !== null ? ' · Resolved' : ''}
                    {item.archivedAt != null ? ' · Archived' : ''}
                  </small>
                  <time dateTime={new Date(item.createdAt).toISOString()}>
                    {new Date(item.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                </span>
                <strong>{inboxTitle(item)}</strong>
                <p>{inboxSummary(item)}</p>
                <span className="proposal-record-footer">
                  <small>
                    {item.inbox
                      ? inboxSource(item.inbox.agent)
                      : item.readAt === null
                        ? 'Unread'
                        : ''}
                  </small>
                  <span className="proposal-record-open">
                    {inboxNeedsYou(item)
                      ? 'Review request'
                      : item.inbox?.category === 'briefing'
                        ? 'Read briefing'
                        : 'Open'}{' '}
                    <UiIcon name="forward" size={16} />
                  </span>
                </span>
              </button>
            ))}
            {feed && feed.total > 50 && (
              <div className="inbox-pagination">
                <button
                  disabled={offset === 0}
                  onClick={() => update('offset', String(Math.max(0, offset - 50)))}
                >
                  Previous
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 50, feed.total)} of {feed.total}
                </span>
                <button
                  disabled={offset + 50 >= feed.total}
                  onClick={() => update('offset', String(offset + 50))}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
        {(desktop || hideList) && (
          <section className="collection-inspector" aria-label="Inbox details">
            {detail}
          </section>
        )}
      </div>
    </div>
  );
}
