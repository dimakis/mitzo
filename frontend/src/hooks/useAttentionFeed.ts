import { useState, useEffect, useMemo } from 'react';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { SessionActivity } from '@mitzo/protocol';
import type { TodoItem } from '../types/todo';
import type { Task, TaskStatus } from '../types/task';

// ─── Attention item model ──────────────────────────────────────────────────

export type AttentionSource = 'telos' | 'atb' | 'session';
export type AttentionTier = 1 | 2;

export interface AttentionItem {
  id: string;
  source: AttentionSource;
  tier: AttentionTier;
  /** Within same tier, lower = higher priority. Sessions sort above Telos. */
  subPriority: number;
  title: string;
  meta: string;
  accentColor: string;
  icon: string;
  /** Navigation target */
  navigateTo: string;
  /** Epoch ms used for recency sort within a tier (higher = more recent) */
  updatedAt: number;
}

// ─── Color constants ───────────────────────────────────────────────────────

const COLOR_AMBER = '#fbbf24';
const COLOR_RED = '#ff6d6d';
const COLOR_PURPLE = '#b48cff';
const COLOR_GREEN = '#4ade80';

// ─── Sub-priority constants ────────────────────────────────────────────────

/** Sessions awaiting user reply — highest priority within any tier */
const SUB_AWAITING_REPLY = 0;
/** Sessions/ATB waiting for input (permission, review, blocked) */
const SUB_WAITING_INPUT = 1;
/** Sessions with uncommitted worktree work */
const SUB_UNCOMMITTED = 2;
/** Telos items — fill remaining slots */
const SUB_TELOS = 3;

// ─── Derive attention items from Telos ─────────────────────────────────────

function telosToAttention(items: TodoItem[]): AttentionItem[] {
  const result: AttentionItem[] = [];
  for (const item of items) {
    // ageDays → approximate epoch (lower ageDays = more recent)
    const updatedAt = Date.now() - item.ageDays * 86_400_000;
    // T1: starred + high urgency = Focus
    if (item.starred && item.urgency >= 0.5) {
      result.push({
        id: `telos-${item.id}`,
        source: 'telos',
        tier: 1,
        subPriority: SUB_TELOS,
        title: item.summary,
        meta: `${item.ageDays === 0 ? 'new' : `${item.ageDays}d`} · ${item.profile}`,
        accentColor: item.urgency >= 0.8 ? COLOR_RED : COLOR_AMBER,
        icon: '\u2605', // ★
        navigateTo: `/todos/${item.id}`,
        updatedAt,
      });
    }
    // T2: starred but lower urgency, or unstarred but high urgency
    else if (item.starred || item.urgency >= 0.8) {
      result.push({
        id: `telos-${item.id}`,
        source: 'telos',
        tier: 2,
        subPriority: SUB_TELOS,
        title: item.summary,
        meta: `${item.ageDays === 0 ? 'new' : `${item.ageDays}d`} · ${item.profile}`,
        accentColor: item.starred ? COLOR_AMBER : COLOR_PURPLE,
        icon: item.starred ? '\u2605' : '\u25CF', // ★ or ●
        navigateTo: `/todos/${item.id}`,
        updatedAt,
      });
    }
  }
  return result;
}

// ─── Derive attention items from ATB ───────────────────────────────────────

const ATB_TIER1_STATUSES: TaskStatus[] = ['pending_review', 'blocked', 'failed'];

function flattenTasks(tasks: Task[]): Task[] {
  const result: Task[] = [];
  for (const t of tasks) {
    result.push(t);
    if (t.children.length > 0) result.push(...flattenTasks(t.children));
  }
  return result;
}

function atbToAttention(tasks: Task[]): AttentionItem[] {
  const flat = flattenTasks(tasks);
  return flat
    .filter((t) => ATB_TIER1_STATUSES.includes(t.status))
    .map((t) => ({
      id: `atb-${t.id}`,
      source: 'atb' as AttentionSource,
      tier: 1 as AttentionTier,
      subPriority: SUB_WAITING_INPUT,
      title: t.title,
      meta:
        t.status === 'pending_review'
          ? 'awaiting approval'
          : t.status === 'blocked'
            ? 'blocked'
            : 'failed',
      accentColor: t.status === 'pending_review' ? COLOR_AMBER : COLOR_RED,
      icon:
        t.status === 'pending_review'
          ? '\u25D4' // ◔
          : t.status === 'blocked'
            ? '\u2298' // ⊘
            : '\u2717', // ✗
      navigateTo: '/tasks',
      updatedAt: t.updatedAt || 0,
    }));
}

// ─── Derive attention items from sessions ──────────────────────────────────

function sessionsToAttention(activities: SessionActivity[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of activities) {
    // Priority 1: awaiting reply (agent responded, user hasn't)
    if (a.awaitingReply && (a.state === 'done' || a.state === 'idle')) {
      items.push({
        id: `session-${a.sessionId}`,
        source: 'session',
        tier: 1,
        subPriority: SUB_AWAITING_REPLY,
        title: a.title,
        meta: 'awaiting reply',
        accentColor: COLOR_PURPLE,
        icon: '\u2709', // ✉
        navigateTo: `/chat/${a.sessionId}`,
        updatedAt: a.lastEventAt || 0,
      });
      continue;
    }
    // Priority 2: waiting for input (permission/review/blocked)
    if (a.state === 'waiting') {
      items.push({
        id: `session-${a.sessionId}`,
        source: 'session',
        tier: 1,
        subPriority: SUB_WAITING_INPUT,
        title: a.title,
        meta:
          a.waitReason === 'permission'
            ? 'permission needed'
            : a.waitReason === 'review'
              ? 'review needed'
              : 'waiting',
        accentColor: COLOR_RED,
        icon: '\u26A0', // ⚠
        navigateTo: `/chat/${a.sessionId}`,
        updatedAt: a.lastEventAt || 0,
      });
      continue;
    }
    // Priority 3: uncommitted worktree work
    if (a.uncommittedWork && (a.state === 'done' || a.state === 'idle')) {
      items.push({
        id: `session-${a.sessionId}`,
        source: 'session',
        tier: 1,
        subPriority: SUB_UNCOMMITTED,
        title: a.title,
        meta: 'uncommitted work',
        accentColor: COLOR_AMBER,
        icon: '\u26A0', // ⚠
        navigateTo: `/chat/${a.sessionId}`,
        updatedAt: a.lastEventAt || 0,
      });
      continue;
    }
    // Tier 2: done sessions (recently finished)
    if (a.state === 'done') {
      items.push({
        id: `session-${a.sessionId}`,
        source: 'session',
        tier: 2,
        subPriority: SUB_TELOS,
        title: a.title,
        meta: 'done',
        accentColor: COLOR_GREEN,
        icon: '\u2713', // ✓
        navigateTo: `/chat/${a.sessionId}`,
        updatedAt: a.lastEventAt || 0,
      });
    }
  }
  return items;
}

// ─── Sort by tier → sub-priority → recency ────────────────────────────────

function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) => a.tier - b.tier || a.subPriority - b.subPriority || b.updatedAt - a.updatedAt,
  );
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export interface UseAttentionFeedReturn {
  items: AttentionItem[];
  tier1Count: number;
  loading: boolean;
}

export function useAttentionFeed(): UseAttentionFeedReturn {
  // Telos data — lightweight fetch (no profile filter = all)
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosLoading, setTodosLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/todos')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((data: { items: TodoItem[] }) => {
        if (!cancelled) {
          setTodos(data.items);
          setTodosLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setTodosLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // SSE-driven refreshes
  useEffect(() => {
    const unsub = eventBus.on('todo_update', () => setRefreshKey((k) => k + 1));
    return unsub;
  }, []);

  // ATB tasks from store
  const tasks = useMitzoStore((s) => s.tasks.tree);
  const loadTasks = useMitzoStore((s) => s.loadTasks);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const unsub = eventBus.on('task_state', () => loadTasks());
    return unsub;
  }, [loadTasks]);

  // Session activities from SSE — validated at runtime
  const [activities, setActivities] = useState<SessionActivity[]>([]);
  useEffect(() => {
    const unsub = eventBus.on('session_activity', (data) => {
      if (!Array.isArray(data)) return;
      const valid = data.filter(
        (d): d is SessionActivity =>
          d != null &&
          typeof d === 'object' &&
          typeof (d as Record<string, unknown>).sessionId === 'string' &&
          typeof (d as Record<string, unknown>).state === 'string',
      );
      setActivities(valid);
    });
    return unsub;
  }, []);

  const feed = useMemo(() => {
    const telosItems = telosToAttention(todos);
    const atbItems = atbToAttention(tasks);
    const sessionItems = sessionsToAttention(activities);
    return sortAttention([...telosItems, ...atbItems, ...sessionItems]);
  }, [todos, tasks, activities]);

  const tier1Count = useMemo(() => feed.filter((i) => i.tier === 1).length, [feed]);

  return {
    items: feed,
    tier1Count,
    loading: todosLoading,
  };
}
