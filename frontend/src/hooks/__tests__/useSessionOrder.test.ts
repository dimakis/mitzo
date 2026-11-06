// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionActivity } from '@mitzo/protocol';
import { useSessionOrder, useSessionOrdering } from '../useSessionOrder';

const sessions = [
  { id: 'recent', summary: 'Recent', lastModified: 300 },
  { id: 'older', summary: 'Older', lastModified: 100 },
];
function activity(state: SessionActivity['state'], time: number, extra = {}): SessionActivity {
  return {
    sessionId: 'older',
    clientId: 'client',
    title: 'Older',
    flags: [],
    state,
    lastEventAt: time,
    ...extra,
  };
}
function setup(initial = [activity('working', 100)]) {
  return renderHook(({ rows, activities, paused }) => useSessionOrder(rows, activities, paused), {
    initialProps: { rows: sessions, activities: initial, paused: false },
  });
}
const tick = (ms = 1000) => act(() => vi.advanceTimersByTime(ms));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(500);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('keeps labels and history live without treating tool activity or idle aging as recency', () => {
  const view = setup();
  view.rerender({
    rows: [...sessions].reverse().map((s) => ({ ...s, summary: 'Updated', lastModified: 9000 })),
    activities: [activity('working', 10000)],
    paused: false,
  });
  tick(10000);
  expect(view.result.current.map((s) => s.id)).toEqual(['recent', 'older']);
  expect(view.result.current[1].summary).toBe('Updated');
  view.rerender({ rows: sessions, activities: [activity('idle', 20000)], paused: false });
  tick(10000);
  expect(view.result.current.map((s) => s.id)).toEqual(['recent', 'older']);
});

it.each(['done', 'waiting'] as const)('promotes %s once after a short batch window', (state) => {
  const view = setup();
  view.rerender({
    rows: sessions,
    activities: [activity(state, 500, { waitReason: 'permission' })],
    paused: false,
  });
  expect(view.result.current.map((s) => s.id)).toEqual(['recent', 'older']);
  tick();
  expect(view.result.current.map((s) => s.id)).toEqual(['older', 'recent']);
});

it('promotes a newly observed permission request even when the activity clock is unchanged', () => {
  const view = setup();
  view.rerender({
    rows: sessions,
    activities: [activity('waiting', 100, { waitReason: 'permission' })],
    paused: false,
  });
  tick();
  expect(view.result.current.map((s) => s.id)).toEqual(['older', 'recent']);
});

it('recognizes new user messages during an already working turn', () => {
  const view = setup([activity('working', 100, { lastUserMessageAt: 90 })]);
  view.rerender({
    rows: sessions,
    activities: [activity('working', 600, { lastUserMessageAt: 500 })],
    paused: false,
  });
  tick();
  expect(view.result.current.map((s) => s.id)).toEqual(['older', 'recent']);
});

it('promotes an assistant message within a running turn without promoting tool signals', () => {
  const view = setup([activity('working', 100, { lastMessageAt: 100 })]);
  view.rerender({
    rows: sessions,
    activities: [activity('working', 600, { lastMessageAt: 500 })],
    paused: false,
  });
  tick();
  expect(view.result.current.map((s) => s.id)).toEqual(['older', 'recent']);
});

it('reconciles saved freshness when the live overview is unavailable', () => {
  const view = setup([]);
  view.rerender({
    rows: sessions.map((s) => (s.id === 'older' ? { ...s, lastModified: 700 } : s)),
    activities: [],
    paused: false,
  });
  tick();
  expect(view.result.current.map((s) => s.id)).toEqual(['older', 'recent']);
});

it('defers promotions while browsing and retains the event through later status changes', () => {
  const view = setup();
  view.rerender({
    rows: sessions,
    activities: [activity('waiting', 500, { waitReason: 'permission' })],
    paused: true,
  });
  tick(10000);
  expect(view.result.current.map((s) => s.id)).toEqual(['recent', 'older']);
  view.rerender({ rows: sessions, activities: [activity('working', 800)], paused: false });
  tick();
  expect(view.result.current.map((s) => s.id)).toEqual(['older', 'recent']);
});

it('coalesces bursts and limits reorder frequency without starving under tool updates', () => {
  const view = setup();
  view.rerender({ rows: sessions, activities: [activity('done', 500)], paused: false });
  tick();
  const recent = { ...activity('waiting', 900), sessionId: 'recent' };
  view.rerender({ rows: sessions, activities: [recent, activity('working', 800)], paused: false });
  tick();
  expect(view.result.current.map((s) => s.id)).toEqual(['older', 'recent']);
  view.rerender({
    rows: sessions,
    activities: [{ ...recent, lastEventAt: 1200 }, activity('working', 1300)],
    paused: false,
  });
  tick(2000);
  expect(view.result.current.map((s) => s.id)).toEqual(['recent', 'older']);
});

it('loads older pages chronologically and defers new-chat insertion during browsing', () => {
  const view = setup();
  const rows = [
    ...sessions,
    { id: 'oldest', summary: '', lastModified: 10 },
    { id: 'new', summary: '', lastModified: 700 },
  ];
  view.rerender({ rows, activities: [], paused: true });
  expect(view.result.current.map((s) => s.id).slice(0, 2)).toEqual(['recent', 'older']);
  tick(5000);
  view.rerender({ rows, activities: [], paused: false });
  tick();
  expect(view.result.current.map((s) => s.id)).toEqual(['new', 'recent', 'older', 'oldest']);
});

it('cancels pending work on unmount', () => {
  const view = setup();
  view.rerender({ rows: sessions, activities: [activity('done', 500)], paused: false });
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('exposes held freshness updates for an explicit show-latest action', () => {
  const view = renderHook(({ activities }) => useSessionOrdering(sessions, activities, true), {
    initialProps: { activities: [activity('working', 100)] },
  });
  view.rerender({ activities: [activity('working', 600, { lastMessageAt: 500 })] });
  expect(view.result.current.pendingCount).toBe(1);
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['recent', 'older']);
  act(() => view.result.current.showLatest());
  expect(view.result.current.pendingCount).toBe(0);
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['older', 'recent']);
});

it('reschedules an initial meaningful snapshot through Strict Mode effect replay', () => {
  const { result } = renderHook(() => useSessionOrder(sessions, [activity('done', 500)], false), {
    wrapper: StrictMode,
  });
  tick();
  expect(result.current.map((s) => s.id)).toEqual(['older', 'recent']);
});
