import { useState, useCallback } from 'react';
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

export function AttentionFeed() {
  const { items, tier1Count, loading } = useAttentionFeed();
  const navigate = useNavigate();

  const hasUrgent = tier1Count > 0;
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const isOpen = manualOpen ?? true; // always open by default

  const toggleOpen = useCallback(() => {
    setManualOpen((prev) => !(prev ?? true));
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
          {items.map((item) => (
            <AttentionCard key={item.id} item={item} onTap={handleTap} />
          ))}
        </div>
      )}
    </div>
  );
}
