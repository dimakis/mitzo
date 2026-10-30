// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ContextCompaction } from '@mitzo/protocol';
import { CompactionDetails } from '../CompactionMarker';

const record: ContextCompaction = {
  id: 'c',
  seq: 3,
  observedAt: 394669,
  phase: 'completed',
  afterMessageId: null,
  turnIndex: 15,
  beforeTokens: null,
  afterTokens: null,
  condensedRange: null,
  summary: null,
  retainedProviderMessageIds: [],
  startedAt: 2000,
  endedAt: 394669,
  usageBefore: { tokens: 189054, observedAt: 1996, model: 'fixture-model', contextCeiling: 258400 },
  usageAfter: { tokens: 28549, observedAt: 403152, model: 'fixture-model', contextCeiling: 258400 },
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('shows measured duration and labelled usage observations without pretending they are exact sizes', () => {
  render(<CompactionDetails record={record} />);
  expect(screen.getByText('6m 33s')).toBeTruthy();
  expect(screen.getByText('fixture-model')).toBeTruthy();
  expect(screen.getByText('189,054')).toBeTruthy();
  expect(screen.getByText('28,549')).toBeTruthy();
  expect(screen.getByText('258,400')).toBeTruthy();
  expect(screen.getByText('Last observed before')).toBeTruthy();
  expect(screen.getByText('First observed after')).toBeTruthy();
  expect(screen.getByText(/not exact compaction sizes/)).toBeTruthy();
  expect(screen.queryByText('Retained summary')).toBeNull();
});
it('ticks elapsed time locally and stops at completion without declaring a long wait failed', () => {
  vi.useFakeTimers();
  vi.setSystemTime(302000);
  const { rerender } = render(
    <CompactionDetails
      record={{ ...record, observedAt: 2000, phase: 'compacting', endedAt: null, usageAfter: null }}
    />,
  );
  expect(screen.getByText('5m 0s')).toBeTruthy();
  expect(screen.getByText(/Waiting for the runtime to report completion/)).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByText('5m 1s')).toBeTruthy();
  rerender(<CompactionDetails record={record} />);
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  expect(screen.getByText('6m 33s')).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});
it('does not show invented duration or reduced context for an interrupted or legacy record', () => {
  render(
    <CompactionDetails
      record={{
        ...record,
        phase: 'interrupted',
        startedAt: null,
        usageBefore: null,
        usageAfter: null,
      }}
    />,
  );
  expect(screen.queryByText('6m 33s')).toBeNull();
  expect(screen.queryByText('First observed after')).toBeNull();
  expect(screen.getByText(/context reduction are unconfirmed/)).toBeTruthy();
});
