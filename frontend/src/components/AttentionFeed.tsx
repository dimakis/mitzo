import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAttentionFeed, type AttentionItem } from '../hooks/useAttentionFeed';
import { selectionChanged } from '../lib/haptics';

// ─── Source labels ─────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  telos: 'telos',
  atb: 'task',
  session: 'session',
};

// ─── Card ──────────────────────────────────────────────────────────────────

function AttentionCard({
  item,
  onTap,
}: {
  item: AttentionItem;
  onTap: (item: AttentionItem) => void;
}) {
  return (
    <button
      className="attention-card"
      onClick={() => onTap(item)}
      style={{ '--card-accent': item.accentColor } as React.CSSProperties}
    >
      <span className="attention-card-icon" style={{ color: item.accentColor }}>
        {item.icon}
      </span>
      <div className="attention-card-content">
        <div className="attention-card-title">{item.title}</div>
        <div className="attention-card-meta">
          <span className="attention-card-source">{SOURCE_LABEL[item.source]}</span>
          {' \u00B7 '}
          {item.meta}
        </div>
      </div>
    </button>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

const DEFAULT_VISIBLE_COUNT = 5;

export function AttentionFeed() {
  const { items, tier1Count, loading } = useAttentionFeed();
  const navigate = useNavigate();

  const hasUrgent = tier1Count > 0;
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const isOpen = manualOpen ?? true; // always open by default

  const toggleOpen = useCallback(() => {
    setManualOpen((prev) => {
      const wasOpen = prev ?? true;
      if (wasOpen) setShowAll(false); // reset on collapse
      return !wasOpen;
    });
  }, []);

  const toggleShowAll = useCallback(() => {
    setShowAll((prev) => !prev);
  }, []);

  const handleTap = useCallback(
    (item: AttentionItem) => {
      selectionChanged();
      navigate(item.navigateTo);
    },
    [navigate],
  );

  // Show section even when empty — gives "all clear" signal
  const summaryParts: string[] = [];
  if (tier1Count > 0) summaryParts.push(`${tier1Count} needs you`);
  const t2Count = items.filter((i) => i.tier === 2).length;
  if (t2Count > 0) summaryParts.push(`${t2Count} in focus`);

  // Auto-reset showAll when items shrink below threshold
  useEffect(() => {
    if (items.length <= DEFAULT_VISIBLE_COUNT) setShowAll(false);
  }, [items.length]);

  const visibleItems = showAll ? items : items.slice(0, DEFAULT_VISIBLE_COUNT);
  const hasMore = items.length > DEFAULT_VISIBLE_COUNT;

  return (
    <div className="attention-section">
      <button className="overview-header" onClick={toggleOpen}>
        <span className="overview-header-title">What&apos;s Next</span>
        <span className="overview-header-summary">
          {loading ? 'loading...' : summaryParts.join(' \u00B7 ') || 'all clear'}
        </span>
        {hasUrgent && <span className="overview-badge">{tier1Count}</span>}
        <span className={`overview-chevron${isOpen ? ' overview-chevron--open' : ''}`}>
          &rsaquo;
        </span>
      </button>
      {isOpen && (
        <div className="attention-cards">
          {!loading && items.length === 0 && (
            <div className="attention-empty">Nothing needs your attention right now.</div>
          )}
          {visibleItems.map((item) => (
            <AttentionCard key={item.id} item={item} onTap={handleTap} />
          ))}
          {!loading && hasMore && (
            <button className="attention-show-more" onClick={toggleShowAll}>
              {showAll ? 'Show less' : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
