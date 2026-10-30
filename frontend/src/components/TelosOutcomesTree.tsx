import {
  knownCreationTime,
  sortTelosSiblings,
  telosSortOptions,
  type TelosOutcomeSort,
} from '../lib/telos-outcome-sort';
import { todoPriority } from '../lib/todo-utils';
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
  collapsed: string[];
  sort: TelosOutcomeSort;
  filter: string;
}
const defaults: NavigationState = {
  query: '',
  category: 'All',
  pins: ['Job', 'Personal projects', 'Mitzo'],
  expanded: [],
  collapsed: [],
  sort: 'default',
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
      return {
        ...value,
        sort: telosSortOptions.some(([sort]) => sort === value.sort) ? value.sort : 'default',
        collapsed:
          Array.isArray(value.collapsed) &&
          value.collapsed.every((id: unknown) => typeof id === 'string')
            ? value.collapsed
            : [],
      };
  } catch {
    /* Device preferences are optional. */
  }
  return { ...defaults, pins: [...defaults.pins], expanded: [], collapsed: [] };
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
  refreshKey,
}: {
  records: TelosWorkItem[];
  onOpen(id: string, view?: 'Chat'): void;
  selectedId?: string;
  storageKey?: string;
  compact?: boolean;
  loading?: boolean;
  error?: string;
  refreshKey: string | number;
}) {
  const [state, setState] = useState(() => restore(storageKey));
  // Canonical parents can arrive after the selected record. Reveal each newly
  // discovered ancestor once; ordinary refreshes must not undo a user's collapse.
  const byId = new Map(records.map((record) => [record.itemId, record]));
  const ancestors: string[] = [];
  const visited = new Set(selectedId ? [selectedId] : []);
  let parentId = selectedId ? byId.get(selectedId)?.parentId : null;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.push(parentId);
    parentId = parent.parentId;
  }
  const [revealed, setRevealed] = useState({ selectedId, storageKey, ancestors: [] as string[] });
  const newSelection = revealed.selectedId !== selectedId || revealed.storageKey !== storageKey;
  const added = newSelection
    ? ancestors
    : ancestors.filter((id) => !revealed.ancestors.includes(id));
  if (newSelection || added.length > 0) {
    setRevealed({
      selectedId,
      storageKey,
      // A temporary collection gap must not forget a manually collapsed parent.
      ancestors: newSelection ? ancestors : [...revealed.ancestors, ...added],
    });
    if (added.length || revealed.storageKey !== storageKey) {
      const current = revealed.storageKey === storageKey ? state : restore(storageKey);
      setState({
        ...current,
        expanded: [...new Set([...current.expanded, ...added])],
        collapsed: current.collapsed.filter((id) => !added.includes(id)),
      });
    }
  }
  const [browse, setBrowse] = useState(false);
  const browseTrigger = useRef<HTMLButtonElement>(null);
  function closeBrowse() {
    setBrowse(false);
    browseTrigger.current?.focus();
  }
  const [storageError, setStorageError] = useState(false);
  function update(patch: Partial<NavigationState>) {
    const changesContext = ['query', 'category', 'filter'].some(
      (key) =>
        key in patch && patch[key as keyof NavigationState] !== state[key as keyof NavigationState],
    );
    const next = { ...state, ...(changesContext ? { collapsed: [] } : {}), ...patch };
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
    sortTelosSiblings(
      records.filter((r) =>
        parent === null ? !r.parentId || !ids.has(r.parentId) : r.parentId === parent,
      ),
      state.sort,
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
              !state.collapsed.includes(record.itemId) &&
              (state.expanded.includes(record.itemId) ||
                Boolean(needle) ||
                state.category !== 'All' ||
                state.filter !== 'All outcomes');
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
                          collapsed: expanded
                            ? [...state.collapsed, record.itemId]
                            : state.collapsed.filter((id) => id !== record.itemId),
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
                      {['newest', 'oldest'].includes(state.sort) &&
                        knownCreationTime(record) === null && <span>Creation date unknown</span>}
                      {kids.length > 0 && (
                        <span>
                          {kids.length} {kids.length === 1 ? 'child' : 'children'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="telos-tree-row-end">
                    <span
                      className="todo-priority-badge"
                      aria-label={`Priority ${todoPriority(record)} out of 10`}
                    >
                      P{todoPriority(record)}
                    </span>
                    <span className="telos-node-status">{record.status}</span>
                    <TelosTreeConversationEntry
                      itemId={record.itemId}
                      kind={record.kind}
                      refreshKey={refreshKey}
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
            className="telos-category-presence"
            aria-label="Discover categories"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeBrowse();
              }
            }}
          >
            <div className="telos-category-browser">
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
            </div>
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
        <select
          className="telos-sort"
          aria-label="Sort outcomes"
          value={state.sort}
          onChange={(event) => update({ sort: event.target.value as TelosOutcomeSort })}
        >
          {telosSortOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button onClick={() => update({ expanded: records.map((r) => r.itemId), collapsed: [] })}>
          Expand all
        </button>
        <button onClick={() => update({ expanded: [], collapsed: records.map((r) => r.itemId) })}>
          Collapse all
        </button>
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
      {loading && <p role="status">Loading outcomes…</p>}
      {error ? (
        <p role="alert">{error}</p>
      ) : records.length === 0 ? (
        !loading && <p>No outcomes yet.</p>
      ) : !children(null).some((r) => visible(r)) ? (
        <p role="status">No matching outcomes</p>
      ) : (
        tree(null)
      )}
    </section>
  );
}
