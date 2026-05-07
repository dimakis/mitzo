import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTodoData } from '../hooks/useTodoData';
import { sourceIcon } from '../lib/todo-utils';
import { CollapsibleSection } from './CollapsibleSection';
import type { TodoItem } from '../types/todo';

const STATUS_ICONS: Record<string, string> = {
  active: '\u25CF', // ●
  acknowledged: '\u25D0', // ◐
  snoozed: '\u25CB', // ○
  completed: '\u2713', // ✓
};

const STATUS_COLORS: Record<string, string> = {
  active: '#b48cff',
  acknowledged: '#60a5fa',
  snoozed: '#888',
  completed: '#4ade80',
};

function urgencyClass(urgency: number): string {
  if (urgency >= 0.8) return 'cc-card--urgency-high';
  if (urgency >= 0.5) return 'cc-card--urgency-med';
  return '';
}

function TelosCard({
  item,
  onTap,
  onDone,
  onAck,
}: {
  item: TodoItem;
  onTap: (item: TodoItem) => void;
  onDone: (id: string) => void;
  onAck: (id: string) => void;
}) {
  const icon = item.starred ? '\u2605' : (STATUS_ICONS[item.status] ?? '\u25CF');
  const color = item.starred ? '#fbbf24' : (STATUS_COLORS[item.status] ?? '#888');
  const ageLabel = item.ageDays === 0 ? 'new' : `${item.ageDays}d`;
  const source = item.sources[0];
  const hasChildren = (item.children?.length ?? 0) > 0;

  return (
    <div
      className={`cc-card cc-card--telos ${urgencyClass(item.urgency)}`}
      onClick={() => onTap(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        // Right-click context menu will be wired later
      }}
    >
      <span className="cc-card-icon" style={{ color }}>
        {icon}
      </span>
      <div className="cc-card-content">
        <div className="cc-card-title">{item.summary}</div>
        <div className="cc-card-meta">
          {source && <span>{sourceIcon(source.type)}</span>}
          <span>{ageLabel}</span>
          {item.profile && <span>{item.profile}</span>}
          {hasChildren && (
            <span>
              {item.completedChildCount ?? 0}/{item.childCount ?? item.children.length}
            </span>
          )}
        </div>
      </div>
      <div className="cc-card-actions" onClick={(e) => e.stopPropagation()}>
        {item.status === 'active' && (
          <button className="cc-btn cc-btn--subtle" onClick={() => onAck(item.id)} title="Seen">
            &#x25D0;
          </button>
        )}
        <button className="cc-btn cc-btn--subtle" onClick={() => onDone(item.id)} title="Done">
          &#x2713;
        </button>
      </div>
    </div>
  );
}

export function TelosSection() {
  const navigate = useNavigate();
  const [activeProfile, setActiveProfile] = useState<string | undefined>(undefined);
  const { loading, items, profiles, ack, done, create, refresh } = useTodoData(activeProfile);
  const [creating, setCreating] = useState(false);
  const [newSummary, setNewSummary] = useState('');

  const handleTap = useCallback(
    (item: TodoItem) => {
      navigate(`/todos/${item.id}`, { state: { item, activeProfile } });
    },
    [navigate, activeProfile],
  );

  // Group by tier: starred active (focus) > active > acknowledged > rest
  const focus = items.filter((i) => i.status === 'active' && i.starred);
  const active = items.filter((i) => i.status === 'active' && !i.starred);
  const seen = items.filter((i) => i.status === 'acknowledged');

  const totalActive = focus.length + active.length;

  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = newSummary.trim();
      if (!text) return;
      await create(text, activeProfile || profiles[0] || 'work');
      setNewSummary('');
      setCreating(false);
    },
    [newSummary, create, activeProfile, profiles],
  );

  return (
    <CollapsibleSection
      title="Telos"
      badge={totalActive || undefined}
      storageKey="cc-telos"
      actions={
        <>
          <button
            className="cc-section-action-btn"
            onClick={() => setCreating(!creating)}
            title="Add item"
          >
            +
          </button>
          <button className="cc-section-action-btn" onClick={refresh} title="Refresh">
            &#x21bb;
          </button>
        </>
      }
    >
      {profiles.length > 1 && (
        <div className="cc-filter-pills">
          <button
            className={`cc-filter-pill${activeProfile === undefined ? ' cc-filter-pill--active' : ''}`}
            onClick={() => setActiveProfile(undefined)}
          >
            All
          </button>
          {profiles.map((p) => (
            <button
              key={p}
              className={`cc-filter-pill${activeProfile === p ? ' cc-filter-pill--active' : ''}`}
              onClick={() => setActiveProfile(activeProfile === p ? undefined : p)}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {creating && (
        <form className="cc-inline-create" onSubmit={handleCreate}>
          <input
            className="cc-inline-input"
            value={newSummary}
            onChange={(e) => setNewSummary(e.target.value)}
            placeholder="New item..."
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCreating(false);
            }}
          />
          <button className="cc-btn cc-btn--approve" type="submit" disabled={!newSummary.trim()}>
            Add
          </button>
        </form>
      )}

      {loading && <p className="cc-empty">Loading...</p>}

      {!loading && items.length === 0 && <p className="cc-empty">No active items</p>}

      {focus.length > 0 && (
        <div className="cc-tier">
          <div className="cc-tier-header">Focus ({focus.length})</div>
          {focus.map((item) => (
            <TelosCard key={item.id} item={item} onTap={handleTap} onDone={done} onAck={ack} />
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className="cc-tier">
          <div className="cc-tier-header">Active ({active.length})</div>
          {active.map((item) => (
            <TelosCard key={item.id} item={item} onTap={handleTap} onDone={done} onAck={ack} />
          ))}
        </div>
      )}

      {seen.length > 0 && (
        <div className="cc-tier">
          <div className="cc-tier-header cc-tier-header--dim">Seen ({seen.length})</div>
          {seen.map((item) => (
            <TelosCard key={item.id} item={item} onTap={handleTap} onDone={done} onAck={ack} />
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
