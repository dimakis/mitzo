// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { markAuthLost } from '../../lib/api-fetch';
import { useTodoData } from '../useTodoData';
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  localStorage.clear();
  markAuthLost();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['refresh', 'create', 'outcome'] as const)(
  '%s reads current Telos data even if an earlier HTTP request is still pending',
  async (operation) => {
    let finishOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishOld = resolve;
        }),
    );
    const hook = renderHook(() => useTodoData());
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      Response.json(
        init?.method === 'POST'
          ? { item: { id: 'created' } }
          : { profiles: [], items: [{ id: 'created' }] },
      ),
    );
    await act(async () => {
      if (operation === 'refresh') hook.result.current.refresh();
      else if (operation === 'create') await hook.result.current.create('Created', 'work');
      else
        await hook.result.current.createOutcome({
          summary: 'Created',
          profile: 'work',
          intent: 'Ship change',
          rationale: 'Reduce delay',
          acceptanceCriteria: [],
          milestones: [],
          idempotencyKey: 'fixture',
        });
    });
    await waitFor(() =>
      expect(hook.result.current.items.map((item) => item.id)).toEqual(['created']),
    );
    await act(async () => finishOld(Response.json({ profiles: [], items: [] })));
    expect(hook.result.current.items.map((item) => item.id)).toEqual(['created']);
    expect(hook.result.current.loading).toBe(false);
  },
);
