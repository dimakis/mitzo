import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import { ProposalDetail } from '../components/ProposalDetail';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { apiFetch } from '../lib/api-fetch';
import { buildInboxContext, buildInboxPrompt } from '../lib/inbox-utils';

import type { InboxItem } from '../lib/inbox-utils';

function InboxCard({
  item,
  onApprove,
  onDiscard,
  onStartSession,
}: {
  item: InboxItem;
  onApprove: (filename: string) => void;
  onDiscard: (filename: string) => void;
  onStartSession: (item: InboxItem, body: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);

  async function toggleExpand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!fullContent) {
      try {
        const res = await apiFetch(`/api/inbox/${encodeURIComponent(item.filename)}`);
        if (res.ok) {
          const data = await res.json();
          setFullContent(data.content);
        }
      } catch {
        // Ignore fetch errors
      }
    }
    setExpanded(true);
  }

  function handleTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0].clientX;
    currentX.current = startX.current;
    swiping.current = true;
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!swiping.current || !ref.current) return;
    currentX.current = e.touches[0].clientX;
    const dx = currentX.current - startX.current;

    // Allow both directions
    ref.current.style.transform = `translateX(${dx}px)`;
    ref.current.style.opacity = `${Math.max(0, 1 - Math.abs(dx) / 200)}`;
  }

  function handleTouchEnd() {
    if (!swiping.current || !ref.current) return;
    swiping.current = false;
    const dx = currentX.current - startX.current;

    if (dx > 100) {
      // Swipe right → approve
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(100%)';
      ref.current.style.opacity = '0';
      setTimeout(() => onApprove(item.filename), 200);
    } else if (dx < -100) {
      // Swipe left → discard
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(-100%)';
      ref.current.style.opacity = '0';
      setTimeout(() => onDiscard(item.filename), 200);
    } else {
      // Snap back
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(0)';
      ref.current.style.opacity = '1';
      setTimeout(() => {
        if (ref.current) ref.current.style.transition = '';
      }, 200);
    }
  }

  // Strip frontmatter for display
  function bodyContent(): string {
    if (!fullContent) return '';
    const match = fullContent.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return match ? match[1].trim() : fullContent;
  }

  return (
    <div className="inbox-card-wrapper">
      <div className="inbox-card-actions-bg">
        <span className="inbox-action-label inbox-action-approve">Archive</span>
        <span className="inbox-action-label inbox-action-discard">Discard</span>
      </div>
      <div
        ref={ref}
        className="inbox-card"
        onClick={toggleExpand}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="inbox-card-header">
          <span className="inbox-card-agent">{item.agent}</span>
          <span className="inbox-card-time">
            {item.timestamp ? new Date(item.timestamp).toLocaleDateString() : ''}
          </span>
        </div>
        <div className="inbox-card-title">{item.title}</div>
        {item.tags.length > 0 && (
          <div className="inbox-card-tags">
            {item.tags.map((tag) => (
              <span key={tag} className="inbox-card-tag">
                {tag}
              </span>
            ))}
          </div>
        )}
        {!expanded && <div className="inbox-card-preview">{item.preview}</div>}
        {expanded && (
          <div className="inbox-card-body">
            <pre className="inbox-card-body-text">{bodyContent()}</pre>
            <div className="inbox-card-buttons">
              <button
                className="inbox-btn inbox-btn-approve"
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove(item.filename);
                }}
              >
                Archive
              </button>
              <button
                className="inbox-btn inbox-btn-discard"
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard(item.filename);
                }}
              >
                Discard
              </button>
              <button
                className="inbox-btn inbox-btn-session"
                onClick={(e) => {
                  e.stopPropagation();
                  onStartSession(item, fullContent ?? item.preview);
                }}
              >
                Review in session
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function InboxView({ desktop = false }: { desktop?: boolean } = {}) {
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
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
    setActionError(null);
    setPendingRemovals((prev) => new Set(prev).add(filename));
    try {
      const res = await apiFetch(
        `/api/inbox/${encodeURIComponent(filename)}${archive ? '/approve' : ''}`,
        { method: archive ? 'POST' : 'DELETE' },
      );
      if (!res.ok) throw new Error('Request failed');
      await loadInbox();
      // Keep the optimistic removal until the store confirms the file is absent.
      // The synchronization effect prunes confirmed removals.
    } catch {
      setPendingRemovals((prev) => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
      setActionError(`${archive ? 'Archive' : 'Discard'} failed. Refresh and try again.`);
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
  const filtered = activeFilter ? items.filter((i) => i.agent === activeFilter) : items;

  const selected = filtered.find((item) => item.filename === selectedFilename);

  return (
    <div className={`inbox-page${desktop ? ' collection-page proposals-desktop' : ''}`}>
      {desktop && (
        <div className="collection-heading">
          <p className="workspace-muted">PROPOSALS</p>
          <h1>Ideas worth a closer look</h1>
          <p className="workspace-muted">
            Review suggestions from your agents and decide what comes next.
          </p>
        </div>
      )}
      <PageHeader title="Proposals" badge={items.length || undefined} />

      {actionError && <p role="alert">{actionError}</p>}
      {loading && <p className="inbox-empty">Loading...</p>}

      {!loading && items.length === 0 && <EmptyState icon={'\u2713'} title="No pending items" />}

      {sources.length > 1 && (
        <div className="inbox-filters">
          <button
            className={`inbox-filter-pill${activeFilter === null ? ' inbox-filter-pill--active' : ''}`}
            onClick={() => setActiveFilter(null)}
          >
            All
          </button>
          {sources.map((src) => (
            <button
              key={src}
              className={`inbox-filter-pill${activeFilter === src ? ' inbox-filter-pill--active' : ''}`}
              onClick={() => setActiveFilter(activeFilter === src ? null : src)}
            >
              {src}
              <span className="inbox-filter-count">
                {items.filter((i) => i.agent === src).length}
              </span>
            </button>
          ))}
        </div>
      )}

      {!desktop && (
        <div className="inbox-hint">
          {filtered.length > 0 && <span>Swipe right to archive, left to discard</span>}
        </div>
      )}
      <div className={desktop ? 'collection-panels' : 'collection-mobile-body'}>
        <div className="inbox-scroll">
          {filtered.map((item) =>
            desktop ? (
              <button
                key={item.filename}
                className="collection-record"
                aria-current={selected?.filename === item.filename ? 'true' : undefined}
                aria-label={item.title}
                onClick={() => setSelectedFilename(item.filename)}
              >
                <small>{item.agent}</small>
                <strong>{item.title}</strong>
                <p>{item.preview}</p>
                {item.tags.length > 0 && <small>{item.tags.join(' · ')}</small>}
              </button>
            ) : (
              <InboxCard
                key={item.filename}
                item={item}
                onApprove={handleApprove}
                onDiscard={handleDiscard}
                onStartSession={handleStartSession}
              />
            ),
          )}
        </div>
        {desktop && (
          <section className="collection-inspector" aria-label="Proposal details">
            {selected ? (
              <ProposalDetail
                key={selected.filename}
                item={selected}
                onArchive={handleApprove}
                onDiscard={handleDiscard}
                onReview={handleStartSession}
              />
            ) : (
              <div className="collection-placeholder">
                <h2>Select a proposal</h2>
                <p>Read its full context and review it in a session.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
