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
