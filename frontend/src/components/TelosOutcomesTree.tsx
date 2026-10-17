import { useMemo, useState, useRef } from 'react';
import type { TelosWorkItem } from '@mitzo/protocol';
import { UiIcon } from './UiIcon';
import { MotionPresence } from './MotionPresence';
import { TelosTreeConversationEntry } from './TelosTreeConversationEntry';
import { telosKindLabel } from '../lib/telos-kind-label';
import './TelosWorkspace.css';

interface NavigationState {
  query: string;
  category: string;
  pins: string[];
  expanded: string[];
  filter: string;
}
const defaults: NavigationState = {
  query: '',
  category: 'All',
  pins: ['Job', 'Personal projects', 'Mitzo'],
  expanded: [],
  filter: 'All outcomes',
};
function restore(key: string): NavigationState {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      value &&
      typeof value.query === 'string' &&
      typeof value.category === 'string' &&
      Array.isArray(value.pins) &&
      value.pins.every((p: unknown) => typeof p === 'string') &&
      Array.isArray(value.expanded) &&
      value.expanded.every((p: unknown) => typeof p === 'string') &&
      ['All outcomes', 'Coordinators'].includes(value.filter)
    )
      return value;
  } catch {
    /* Device preferences are optional. */
  }
  return { ...defaults, pins: [...defaults.pins], expanded: [] };
}
/** Presentation over accepted records. No kind/assignment inference or mutations. */
export function TelosOutcomesTree({
  records,
  onOpen,
  selectedId,
  storageKey = 'telos.outcomes.navigation.v1',
  compact = false,
  loading = false,
  error,
}: {
  records: TelosWorkItem[];
  onOpen(id: string, view?: 'Chat'): void;
  selectedId?: string;
  storageKey?: string;
  compact?: boolean;
  loading?: boolean;
  error?: string;
}) {
  const [state, setState] = useState(() => restore(storageKey));
  const [browse, setBrowse] = useState(false);
  const browseTrigger = useRef<HTMLButtonElement>(null);
  function closeBrowse() {
    setBrowse(false);
    browseTrigger.current?.focus();
  }
  const [storageError, setStorageError] = useState(false);
  function update(patch: Partial<NavigationState>) {
    const next = { ...state, ...patch };
    setState(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }
  const ids = useMemo(() => new Set(records.map((r) => r.itemId)), [records]);
  const categories = [...new Set(records.flatMap((r) => r.categories))].sort();
  const children = (parent: string | null) =>
    records.filter((r) =>
      parent === null ? !r.parentId || !ids.has(r.parentId) : r.parentId === parent,
    );
  const needle = state.query.trim().toLocaleLowerCase();
  function matches(record: TelosWorkItem) {
    return (
      (compact || state.category === 'All' || record.categories.includes(state.category)) &&
      (compact || state.filter !== 'Coordinators' || record.kind === 'coordinator') &&
      (!needle || JSON.stringify(record).toLocaleLowerCase().includes(needle))
    );
  }
  function visible(record: TelosWorkItem, visited = new Set<string>()): boolean {
    if (visited.has(record.itemId)) return false;
    const path = new Set(visited).add(record.itemId);
    return matches(record) || children(record.itemId).some((child) => visible(child, path));
  }
  function tree(parent: string | null, visited = new Set<string>()): React.ReactNode {
    return (
      <ul className="telos-tree">
        {children(parent)
          .filter((r) => !visited.has(r.itemId) && visible(r))
          .map((record) => {
            const kids = children(record.itemId);
            const expanded =
              state.expanded.includes(record.itemId) ||
              Boolean(needle) ||
              state.category !== 'All' ||
              state.filter !== 'All outcomes';
            return (
              <li key={record.itemId}>
                <div
                  className="telos-tree-row"
                  aria-current={selectedId === record.itemId ? 'page' : undefined}
                >
                  {kids.length > 0 ? (
                    <button
                      className="telos-disclosure"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${record.summary}`}
                      onClick={() =>
                        update({
                          expanded: expanded
                            ? state.expanded.filter((id) => id !== record.itemId)
                            : [...state.expanded, record.itemId],
                        })
                      }
                    >
                      <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
                    </button>
                  ) : (
                    <span className="telos-disclosure" />
                  )}
                  <span className="telos-node-icon">
                    <UiIcon
                      name={
                        record.kind === 'coordinator'
                          ? 'agents'
                          : record.kind === 'work_item'
                            ? 'worktree'
                            : 'work'
                      }
                      size={16}
                    />
                  </span>
                  <div className="telos-node-copy">
                    <button className="telos-node-title" onClick={() => onOpen(record.itemId)}>
                      {record.summary}
                    </button>
                    <div className="telos-node-meta">
                      <span>{telosKindLabel(record.kind)}</span>
                      {kids.length > 0 && (
                        <span>
                          {kids.length} {kids.length === 1 ? 'child' : 'children'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="telos-tree-row-end">
                    <span className="telos-node-status">{record.status}</span>
                    <TelosTreeConversationEntry
                      itemId={record.itemId}
                      onOpenChat={() => onOpen(record.itemId, 'Chat')}
                    />
                  </div>
                </div>
                {kids.length > 0 && (
                  <MotionPresence open={expanded} kind="disclosure">
                    {tree(record.itemId, new Set(visited).add(record.itemId))}
                  </MotionPresence>
                )}
              </li>
            );
          })}
      </ul>
    );
  }
  return (
    <section className="telos-outcomes" aria-label={compact ? 'Child work' : 'Outcomes tree'}>
      {!compact && (
        <>
          <nav className="telos-tabs" aria-label="Outcome filters">
            <button
              aria-pressed={state.filter === 'All outcomes'}
              onClick={() => update({ filter: 'All outcomes' })}
            >
              All outcomes
            </button>
            <button disabled title="Attention classification is not available from the work API">
              Needs you
            </button>
            <button
              aria-pressed={state.filter === 'Coordinators'}
              onClick={() => update({ filter: 'Coordinators' })}
            >
              Coordinators
            </button>
          </nav>
          <div className="telos-pins" aria-label="Pinned categories">
            <button
              aria-pressed={state.category === 'All'}
              onClick={() => update({ category: 'All' })}
            >
              All
            </button>
            {state.pins.map((category) => (
              <button
                key={category}
                aria-pressed={state.category === category}
                onClick={() => update({ category })}
              >
                <UiIcon name="pin" size={16} />
                {category}
              </button>
            ))}
            <button ref={browseTrigger} aria-expanded={browse} onClick={() => setBrowse(!browse)}>
              Browse categories
            </button>
          </div>
          <MotionPresence
            open={browse}
            kind="disclosure"
            className="telos-category-browser"
            aria-label="Discover categories"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeBrowse();
              }
            }}
          >
            {categories.length === 0 && <p>No categories available.</p>}
            {[...new Set([...categories, ...state.pins])].map((category) => (
              <div key={category}>
                <button
                  onClick={() => {
                    update({ category });
                    closeBrowse();
                  }}
                >
                  {category}
                </button>
                <button
                  aria-label={`${state.pins.includes(category) ? 'Unpin' : 'Pin'} ${category}`}
                  onClick={() =>
                    update({
                      pins: state.pins.includes(category)
                        ? state.pins.filter((p) => p !== category)
                        : [...state.pins, category],
                    })
                  }
                >
                  {state.pins.includes(category) ? 'Unpin' : 'Pin'}
                </button>
              </div>
            ))}
          </MotionPresence>
        </>
      )}
      <div className="telos-tree-toolbar">
        <label className="telos-search">
          <UiIcon name="search" size={16} />
          <input
            type="search"
            aria-label="Search Telos tree"
            placeholder="Search outcomes, work or categories…"
            value={state.query}
            onChange={(e) => update({ query: e.target.value })}
          />
        </label>
        <button onClick={() => update({ expanded: records.map((r) => r.itemId) })}>
          Expand all
        </button>
        <button onClick={() => update({ expanded: [] })}>Collapse all</button>
      </div>
      {storageError && (
        <p role="alert">Navigation preferences could not be saved on this device.</p>
      )}
      {!compact && (
        <div className="telos-tree-label">
          Telos tree · {state.category === 'All' ? 'all categories' : state.category}
          <span>Coordinator → Outcome → Work item</span>
        </div>
      )}
      {loading ? (
        <p role="status">Loading outcomes…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : records.length === 0 ? (
        <p>No outcomes yet.</p>
      ) : !children(null).some((r) => visible(r)) ? (
        <p role="status">No matching outcomes</p>
      ) : (
        tree(null)
      )}
    </section>
  );
}
