import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import { ProposalDetail } from '../components/ProposalDetail';
import { EmptyState } from '../components/EmptyState';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { apiFetch } from '../lib/api-fetch';
import { buildInboxContext, buildInboxPrompt } from '../lib/inbox-utils';

import type { InboxItem } from '../lib/inbox-utils';

export function InboxView({ desktop = false }: { desktop?: boolean } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedFilename = searchParams.get('item');
  const [selectedFilename, setSelectedFilename] = useState<string | null>(linkedFilename);
  const activeProposal = useRef<string | null>(linkedFilename);
  const mounted = useRef(true);
  const removalRequests = useRef(new Set<string>());
  const [removingFiles, setRemovingFiles] = useState(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    activeProposal.current = linkedFilename;
    setSelectedFilename(linkedFilename);
  }, [linkedFilename]);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const backButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const lastOpened = useRef<string | null>(null);
  const listPosition = useRef(0);
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
  const setPendingSession = useMitzoStore((s) => s.setPendingSession);

  // Sync from the store's inbox (updated via v2 WS inbox_updated events)
  const storeInbox = useMitzoStore((s) => s.inbox.items);
  const loadInbox = useMitzoStore((s) => s.loadInbox);

  useEffect(() => {
    loadInbox().then(() => setLoading(false));

    const onVisible = () => {
      if (document.visibilityState === 'visible') loadInbox();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadInbox]);

  // When the store's inbox updates (via WS), sync to local state — but
  // filter out items that were optimistically removed to prevent flicker.
  // Prune pendingRemovals to items still present server-side so the set
  // doesn't grow monotonically and hide legitimately re-added items.
  useEffect(() => {
    const serverFilenames = new Set((storeInbox as InboxItem[]).map((i) => i.filename));
    setPendingRemovals((prev) => {
      const pruned = new Set<string>();
      for (const f of prev) {
        if (serverFilenames.has(f)) pruned.add(f);
      }
      return pruned.size === prev.size ? prev : pruned;
    });
    const filtered = (storeInbox as InboxItem[]).filter(
      (item) => !pendingRemovals.has(item.filename),
    );
    setItems(filtered);
  }, [storeInbox, pendingRemovals]);

  async function handleRemove(filename: string, archive: boolean) {
    if (removalRequests.current.has(filename)) return;
    removalRequests.current.add(filename);
    setRemovingFiles(new Set(removalRequests.current));
    setActionError(null);
    setPendingRemovals((prev) => new Set(prev).add(filename));
    try {
      const res = await apiFetch(
        `/api/inbox/${encodeURIComponent(filename)}${archive ? '/approve' : ''}`,
        { method: archive ? 'POST' : 'DELETE' },
      );
      if (!res.ok) throw new Error('Request failed');
      await loadInbox();
      if (mounted.current && activeProposal.current === filename) {
        activeProposal.current = null;
        setSelectedFilename(null);
        setSearchParams((params) => {
          params.delete('item');
          return params;
        });
      }
      // Keep the optimistic removal until the store confirms the file is absent.
      // The synchronization effect prunes confirmed removals.
    } catch {
      if (!mounted.current) return;
      setPendingRemovals((prev) => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
      setActionError(`${archive ? 'Archive' : 'Discard'} failed. Refresh and try again.`);
    } finally {
      removalRequests.current.delete(filename);
      if (mounted.current) setRemovingFiles(new Set(removalRequests.current));
    }
  }

  function handleApprove(filename: string) {
    void handleRemove(filename, true);
  }
  function handleDiscard(filename: string) {
    void handleRemove(filename, false);
  }

  function handleStartSession(item: InboxItem, body: string) {
    setPendingSession({
      prompt: buildInboxPrompt(item, body),
      context: buildInboxContext(item, body),
    });
    navigate('/chat');
  }

  const sources = [...new Set(items.map((i) => i.agent))].sort();
  const search = query.trim().toLocaleLowerCase();
  const filtered = items.filter(
    (item) =>
      (!activeFilter || item.agent === activeFilter) &&
      (!search ||
        [item.title, item.preview, item.agent, ...item.tags]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search)),
  );
  const selected = (storeInbox as InboxItem[]).find((item) => item.filename === selectedFilename);
  const showMobileDetail = !desktop && !!selectedFilename;

  useEffect(() => {
    if (desktop) return;
    if (showMobileDetail) {
      lastOpened.current = selectedFilename;
      backButton.current?.focus();
    } else if (lastOpened.current) {
      rows.current.get(lastOpened.current)?.focus({ preventScroll: true });
      if (list.current) list.current.scrollTop = listPosition.current;
      lastOpened.current = null;
    }
  }, [desktop, showMobileDetail, selectedFilename]);

  function openProposal(filename: string) {
    activeProposal.current = filename;
    listPosition.current = list.current?.scrollTop ?? 0;
    setSelectedFilename(filename);
    if (!desktop)
      setSearchParams((params) => {
        params.set('item', filename);
        return params;
      });
  }
  function closeProposal() {
    activeProposal.current = null;
    setSelectedFilename(null);
    setSearchParams((params) => {
      params.delete('item');
      return params;
    });
  }

  return (
    <div
      className={`inbox-page${desktop ? ' collection-page proposals-desktop' : ' proposals-mobile'}`}
    >
      {desktop && (
        <WorkspacePageHeading
          className="collection-heading"
          eyebrow="Proposals"
          title="Ideas worth a closer look"
          description="Review suggestions from your agents and decide what comes next."
        />
      )}
      {!desktop && (
        <WorkspacePageHeading
          title="Proposals"
          badge={items.length}
          description="Suggestions from your agents. You decide what comes next."
        />
      )}
      {showMobileDetail && (
        <button
          ref={backButton}
          className="proposal-back"
          aria-label="Back to proposals"
          onClick={closeProposal}
        >
          ← Back to proposals
        </button>
      )}
      {!showMobileDetail && (
        <div className="proposal-search">
          <input
            type="search"
            aria-label="Search proposals"
            placeholder="Search proposals…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}

      {actionError && <p role="alert">{actionError}</p>}
      {loading && <p className="inbox-empty">Loading...</p>}

      {!loading && items.length === 0 && <EmptyState icon={'\u2713'} title="No pending items" />}

      {!showMobileDetail && sources.length > 1 && (
        <div className="inbox-filters">
          <button
            className={`inbox-filter-pill${activeFilter === null ? ' inbox-filter-pill--active' : ''}`}
            aria-pressed={activeFilter === null}
            onClick={() => setActiveFilter(null)}
          >
            All
          </button>
          {sources.map((src) => (
            <button
              key={src}
              className={`inbox-filter-pill${activeFilter === src ? ' inbox-filter-pill--active' : ''}`}
              aria-pressed={activeFilter === src}
              onClick={() => setActiveFilter(activeFilter === src ? null : src)}
            >
              {src.replaceAll('_', ' ')}
              <span className="inbox-filter-count">
                {items.filter((i) => i.agent === src).length}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className={desktop ? 'collection-panels' : 'collection-mobile-body'}>
        {!showMobileDetail && (
          <div className="inbox-scroll" ref={list}>
            {!loading && filtered.length === 0 && items.length > 0 && (
              <p className="inbox-empty">No matching proposals</p>
            )}
            {filtered.map((item) => (
              <button
                key={item.filename}
                ref={(node) => {
                  if (node) rows.current.set(item.filename, node);
                  else rows.current.delete(item.filename);
                }}
                className="collection-record proposal-record"
                aria-current={selected?.filename === item.filename ? 'true' : undefined}
                aria-label={item.title}
                onClick={() => openProposal(item.filename)}
              >
                <span className="proposal-record-meta">
                  <small>{item.agent.replaceAll('_', ' ')}</small>
                  {item.timestamp && (
                    <time dateTime={item.timestamp}>
                      {new Date(item.timestamp).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </time>
                  )}
                </span>
                <strong>{item.title}</strong>
                <p>{item.preview}</p>
                <span className="proposal-record-footer">
                  <small>
                    {item.tags.slice(0, 2).join(' · ')}
                    {item.tags.length > 2 && ` · +${item.tags.length - 2}`}
                  </small>
                  <span className="proposal-record-open" aria-hidden="true">
                    Review →
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {(desktop || showMobileDetail) && (
          <section className="collection-inspector" aria-label="Proposal details">
            {selected ? (
              <ProposalDetail
                key={selected.filename}
                item={selected}
                pending={removingFiles.has(selected.filename)}
                onArchive={handleApprove}
                onDiscard={handleDiscard}
                onReview={handleStartSession}
              />
            ) : (
              <div className="collection-placeholder">
                <h2>{showMobileDetail ? 'Proposal unavailable' : 'Select a proposal'}</h2>
                <p>Read its full context and review it in a session.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
