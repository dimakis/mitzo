import { useState, useEffect, useMemo } from 'react';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { SessionActivity } from '@mitzo/protocol';
import type { TodoItem } from '../types/todo';
import type { Task, TaskStatus } from '../types/task';

// ─── Attention item model ──────────────────────────────────────────────────

export type AttentionSource = 'telos' | 'atb' | 'session';
export type AttentionTier = 1 | 2 | 3;

export interface AttentionItem {
  id: string;
  source: AttentionSource;
  tier: AttentionTier;
  title: string;
  meta: string;
  accentColor: string;
  icon: string;
  /** Navigation target */
  navigateTo: string;
}

// ─── Color constants ───────────────────────────────────────────────────────

const COLOR_AMBER = '#fbbf24';
const COLOR_RED = '#ff6d6d';
const COLOR_PURPLE = '#b48cff';
const COLOR_GREEN = '#4ade80';
const COLOR_BLUE = '#60a5fa';

// ─── Derive attention items from Telos ─────────────────────────────────────

function telosToAttention(items: TodoItem[]): AttentionItem[] {
  const result: AttentionItem[] = [];
  for (const item of items) {
    // T1: starred + high urgency = Focus
    if (item.starred && item.urgency >= 0.5) {
      result.push({
        id: `telos-${item.id}`,
        source: 'telos',
        tier: 1,
        title: item.summary,
        meta: `${item.ageDays === 0 ? 'new' : `${item.ageDays}d`} · ${item.profile}`,
        accentColor: item.urgency >= 0.8 ? COLOR_RED : COLOR_AMBER,
        icon: '\u2605', // ★
        navigateTo: `/todos/${item.id}`,
      });
    }
    // T2: starred but lower urgency, or unstarred but high urgency
    else if (item.starred || item.urgency >= 0.8) {
      result.push({
        id: `telos-${item.id}`,
        source: 'telos',
        tier: 2,
        title: item.summary,
        meta: `${item.ageDays === 0 ? 'new' : `${item.ageDays}d`} · ${item.profile}`,
        accentColor: item.starred ? COLOR_AMBER : COLOR_PURPLE,
        icon: item.starred ? '\u2605' : '\u25CF', // ★ or ●
        navigateTo: `/todos/${item.id}`,
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
      title: t.title,
      meta:
        t.status === 'pending_review'
          ? 'awaiting approval'
          : t.status === 'blocked'
            ? 'blocked'
            : 'failed',
      accentColor:
        t.status === 'pending_review' ? COLOR_AMBER : COLOR_RED,
      icon:
        t.status === 'pending_review'
          ? '\u25D4' // ◔
          : t.status === 'blocked'
            ? '\u2298' // ⊘
            : '\u2717', // ✗
      navigateTo: '/tasks',
    }));
}

// ─── Derive attention items from sessions ──────────────────────────────────

function sessionsToAttention(activities: SessionActivity[]): AttentionItem[] {
  return activities
    .filter((a) => a.state === 'waiting' || a.state === 'done')
    .map((a) => ({
      id: `session-${a.sessionId}`,
      source: 'session' as AttentionSource,
      tier: (a.state === 'waiting' ? 1 : 2) as AttentionTier,
      title: a.title,
      meta:
        a.state === 'waiting'
          ? a.waitReason === 'permission'
            ? 'permission needed'
            : a.waitReason === 'review'
              ? 'review needed'
              : 'waiting'
          : 'done',
      accentColor: a.state === 'waiting' ? COLOR_RED : COLOR_GREEN,
      icon: a.state === 'waiting' ? '\u26A0' : '\u2713', // ⚠ or ✓
      navigateTo: `/chat/${a.sessionId}`,
    }));
}

// ─── Sort by tier then recency ─────────────────────────────────────────────

function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => a.tier - b.tier);
}

// ─── Hook ──────────────────────────────────────────────────────────────────

const MAX_ITEMS = 5;

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

  // Session activities from SSE
  const [activities, setActivities] = useState<SessionActivity[]>([]);
  useEffect(() => {
    const unsub = eventBus.on('session_activity', (data) => {
      setActivities(data as SessionActivity[]);
    });
    return unsub;
  }, []);

  const feed = useMemo(() => {
    const telosItems = telosToAttention(todos);
    const atbItems = atbToAttention(tasks);
    const sessionItems = sessionsToAttention(activities);
    const all = sortAttention([...telosItems, ...atbItems, ...sessionItems]);
    return all.slice(0, MAX_ITEMS);
  }, [todos, tasks, activities]);

  const tier1Count = useMemo(() => feed.filter((i) => i.tier === 1).length, [feed]);

  return {
    items: feed,
    tier1Count,
    loading: todosLoading,
  };
}
