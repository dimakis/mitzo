import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

interface InboxItem {
  filename: string;
  agent: string;
  title: string;
  tags: string[];
  timestamp: string;
  preview: string;
}

function InboxCard({
  item,
  onApprove,
  onDiscard,
}: {
  item: InboxItem;
  onApprove: (filename: string) => void;
  onDiscard: (filename: string) => void;
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
        const res = await fetch(`/api/inbox/${encodeURIComponent(item.filename)}`);
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
        <span className="inbox-action-label inbox-action-approve">Approve</span>
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
                Approve
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function InboxView() {
  const navigate = useNavigate();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadItems = useCallback(() => {
    fetch('/api/inbox')
      .then((r) => r.json())
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadItems();

    const onVisible = () => {
      if (document.visibilityState === 'visible') loadItems();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadItems]);

  function handleApprove(filename: string) {
    setItems((prev) => prev.filter((i) => i.filename !== filename));
    fetch(`/api/inbox/${encodeURIComponent(filename)}/approve`, { method: 'POST' }).catch(() => {});
  }

  function handleDiscard(filename: string) {
    setItems((prev) => prev.filter((i) => i.filename !== filename));
    fetch(`/api/inbox/${encodeURIComponent(filename)}`, { method: 'DELETE' }).catch(() => {});
  }

  return (
    <div className="inbox-page">
      <header className="inbox-header">
        <button className="inbox-back" onClick={() => navigate('/')}>
          &lsaquo;
        </button>
        <h1>Inbox {items.length > 0 && <span className="inbox-count">{items.length}</span>}</h1>
      </header>

      {loading && <p className="inbox-empty">Loading...</p>}

      {!loading && items.length === 0 && (
        <div className="inbox-empty">
          <div className="inbox-empty-icon">&#10003;</div>
          <p>No pending items</p>
        </div>
      )}

      <div className="inbox-hint">
        {items.length > 0 && <span>Swipe right to approve, left to discard</span>}
      </div>

      <div className="inbox-list">
        {items.map((item) => (
          <InboxCard
            key={item.filename}
            item={item}
            onApprove={handleApprove}
            onDiscard={handleDiscard}
          />
        ))}
      </div>
    </div>
  );
}
