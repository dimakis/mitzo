// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { readApiJson } from '../../lib/api-json-read';
import { useCompactionHistory } from '../useCompactionHistory';
vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const record = {
  id: 'c',
  seq: 3,
  observedAt: 1000,
  phase: 'completed',
  afterMessageId: 'm',
  turnIndex: 2,
  beforeTokens: 100,
  afterTokens: 40,
  condensedRange: null,
  summary: null,
  retainedProviderMessageIds: [],
};

it('refreshes on lifecycle changes, retains evidence on failure and clears it across conversations', async () => {
  vi.mocked(readApiJson).mockResolvedValue({ records: [record], truncated: false });
  const { result, rerender } = renderHook(({ id, key }) => useCompactionHistory(id, key), {
    initialProps: { id: 's', key: 'completed:1' },
  });
  await waitFor(() => expect(result.current.records).toEqual([record]));
  rerender({ id: 's', key: 'completed:1' });
  expect(readApiJson).toHaveBeenCalledTimes(1);
  vi.mocked(readApiJson).mockRejectedValueOnce(new Error('offline'));
  rerender({ id: 's', key: 'completed:2' });
  await waitFor(() => expect(result.current.error).toBeDefined());
  expect(result.current.records).toEqual([record]);
  vi.mocked(readApiJson).mockImplementationOnce(() => new Promise(() => {}));
  rerender({ id: 'other', key: 'completed:2' });
  expect(result.current.records).toEqual([]);
  expect(vi.mocked(readApiJson).mock.calls.at(-1)?.[0]).toBe('/api/sessions/other/compactions');
});

it('rejects incomplete lifecycle evidence instead of rendering missing fields', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    records: [{ id: 'bad', seq: 1, phase: 'completed' }],
    truncated: false,
  });
  const { result } = renderHook(() => useCompactionHistory('s', 'done'));
  await waitFor(() => expect(result.current.error).toBeDefined());
  expect(result.current.records).toEqual([]);
});

it.each(['interrupted', 'unknown'])(
  'refreshes an active compaction to %s at the same position',
  async (phase) => {
    const active = { ...record, phase: 'compacting', afterTokens: null };
    const terminal = { ...active, phase };
    vi.mocked(readApiJson).mockResolvedValueOnce({ records: [active], truncated: false });
    const { result, rerender } = renderHook(({ key }) => useCompactionHistory('s', key), {
      initialProps: { key: 'compacting:0' },
    });
    await waitFor(() => expect(result.current.records).toEqual([active]));
    vi.mocked(readApiJson).mockResolvedValueOnce({ records: [terminal], truncated: false });
    rerender({ key: `${phase}:0` });
    await waitFor(() => expect(result.current.records).toEqual([terminal]));
    expect(result.current.error).toBeUndefined();
  },
);

it('refreshes for fresh context only until a completed compaction has an after observation', async () => {
  const pending = {
    ...record,
    startedAt: 500,
    endedAt: 1000,
    afterTokens: null,
    usageBefore: { tokens: 100, observedAt: 400, model: 'fixture-model', contextCeiling: 1000 },
    usageAfter: null,
  };
  const ready = {
    ...pending,
    usageAfter: { tokens: 40, observedAt: 1100, model: 'fixture-model', contextCeiling: 1000 },
  };
  vi.mocked(readApiJson).mockResolvedValue({ records: [pending], truncated: false });
  const { result, rerender } = renderHook(
    ({ context }) => useCompactionHistory('s', 'completed:1', context),
    { initialProps: { context: 100 } },
  );
  await waitFor(() => expect(result.current.records).toEqual([pending]));
  const callsBefore = vi.mocked(readApiJson).mock.calls.length;
  vi.mocked(readApiJson).mockResolvedValue({ records: [ready], truncated: false });
  rerender({ context: 40 });
  await waitFor(() => expect(result.current.records).toEqual([ready]));
  expect(vi.mocked(readApiJson).mock.calls.length).toBeGreaterThan(callsBefore);
  const callsAfter = vi.mocked(readApiJson).mock.calls.length;
  rerender({ context: 60 });
  expect(readApiJson).toHaveBeenCalledTimes(callsAfter);
});

it('rejects malformed optional timing and observation fields', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    records: [{ ...record, startedAt: -1, usageBefore: { tokens: 'bad' } }],
    truncated: false,
  });
  const { result } = renderHook(() => useCompactionHistory('s', 'done'));
  await waitFor(() => expect(result.current.error).toBeDefined());
  expect(result.current.records).toEqual([]);
});

it('does not keep refreshing an older unresolved compaction during a different turn', async () => {
  const pending = {
    ...record,
    startedAt: 500,
    endedAt: 1000,
    afterTokens: null,
    usageBefore: { tokens: 100, observedAt: 400, model: 'fixture-model', contextCeiling: 1000 },
    usageAfter: null,
  };
  vi.mocked(readApiJson).mockResolvedValue({ records: [pending], truncated: false });
  const { result, rerender } = renderHook(
    ({ context }) => useCompactionHistory('s', 'completed:1', context, 3),
    { initialProps: { context: 100 } },
  );
  await waitFor(() => expect(result.current.records).toEqual([pending]));
  rerender({ context: 80 });
  expect(readApiJson).toHaveBeenCalledTimes(1);
});

it('does not refresh usage indefinitely when the bounded history has no before observation', async () => {
  const pending = {
    ...record,
    startedAt: 500,
    endedAt: 1000,
    afterTokens: null,
    usageBefore: null,
    usageAfter: null,
  };
  vi.mocked(readApiJson).mockResolvedValue({ records: [pending], truncated: false });
  const { result, rerender } = renderHook(
    ({ context }) => useCompactionHistory('s', 'completed:1', context, 2),
    { initialProps: { context: 100 } },
  );
  await waitFor(() => expect(result.current.records).toEqual([pending]));
  rerender({ context: 80 });
  expect(readApiJson).toHaveBeenCalledTimes(1);
});

it.each([null, undefined])('keeps a new chat without a session ID empty (%s)', (id) => {
  const { result } = renderHook(() => useCompactionHistory(id, ''));
  expect(result.current.records).toEqual([]);
  expect(readApiJson).not.toHaveBeenCalled();
});
