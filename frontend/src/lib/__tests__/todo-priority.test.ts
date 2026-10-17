import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../api-fetch', () => ({ apiFetch: vi.fn(), invalidateTodoReads: vi.fn() }));
import { apiFetch } from '../api-fetch';
import { setTodoPriority, subscribeTodoPriorityUpdates } from '../todo-priority';

const unsubscribe: (() => void)[] = [];
beforeEach(() => vi.resetAllMocks());
afterEach(() => unsubscribe.splice(0).forEach((off) => off()));

it.each(Array.from({ length: 10 }, (_, index) => index + 1))(
  'acknowledges priority %s without changing its scale',
  async (priority) => {
    const listener = vi.fn();
    unsubscribe.push(subscribeTodoPriorityUpdates(listener));
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
    await setTodoPriority('item', priority);
    expect(listener).toHaveBeenCalledWith({ id: 'item', priority });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/todos/item/action',
      expect.objectContaining({ body: JSON.stringify({ action: 'priority', priority }) }),
    );
  },
);

it('publishes the acknowledged value to legacy and canonical owners before resolving', async () => {
  const legacy = vi.fn(),
    canonical = vi.fn();
  unsubscribe.push(subscribeTodoPriorityUpdates(legacy), subscribeTodoPriorityUpdates(canonical));
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const save = setTodoPriority('item/child', 7);
  expect(canonical).not.toHaveBeenCalled();
  finish(Response.json({ ok: true }));
  await save;
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/todos/item%2Fchild/action',
    expect.objectContaining({ body: JSON.stringify({ action: 'priority', priority: 7 }) }),
  );
  expect(legacy).toHaveBeenCalledExactlyOnceWith({ id: 'item/child', priority: 7 });
  expect(canonical).toHaveBeenCalledExactlyOnceWith({ id: 'item/child', priority: 7 });
});

it.each([0, 11, 1.5, NaN])(
  'rejects invalid priority %s before a write or notification',
  async (priority) => {
    const listener = vi.fn();
    unsubscribe.push(subscribeTodoPriorityUpdates(listener));
    await expect(setTodoPriority('item', priority)).rejects.toThrow();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  },
);

it.each(['http', 'rejected', 'network'])(
  'never publishes an unconfirmed %s save',
  async (failure) => {
    const listener = vi.fn();
    unsubscribe.push(subscribeTodoPriorityUpdates(listener));
    if (failure === 'network') vi.mocked(apiFetch).mockRejectedValueOnce(Error('offline'));
    else
      vi.mocked(apiFetch).mockResolvedValueOnce(
        Response.json({ ok: false }, { status: failure === 'http' ? 503 : 200 }),
      );
    await expect(setTodoPriority('item', 7)).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
  },
);

it('serializes independent owners and removes unsubscribed observers', async () => {
  const listener = vi.fn();
  const off = subscribeTodoPriorityUpdates(listener);
  unsubscribe.push(off);
  let first!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        first = resolve;
      }),
  );
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
  const older = setTodoPriority('item', 7),
    newer = setTodoPriority('item', 9);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  first(Response.json({ ok: true }));
  await Promise.all([older, newer]);
  expect(listener.mock.calls.map(([change]) => change.priority)).toEqual([7, 9]);
  off();
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
  await setTodoPriority('item', 4);
  expect(listener).toHaveBeenCalledTimes(2);
});

it('does not misreport an acknowledged write if a view observer fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const healthy = vi.fn();
  unsubscribe.push(
    subscribeTodoPriorityUpdates(() => {
      throw Error('view failed');
    }),
  );
  unsubscribe.push(subscribeTodoPriorityUpdates(healthy));
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true }));
  await expect(setTodoPriority('item', 7)).resolves.toBeUndefined();
  expect(healthy).toHaveBeenCalledWith({ id: 'item', priority: 7 });
  expect(log).toHaveBeenCalledOnce();
  log.mockRestore();
});
