import { expect, it, vi } from 'vitest';
import { TelosWorkApiClient, TelosWorkApiError } from '../telos-work-api.js';
const revision = 'a'.repeat(64);
const lifecycle = {
  itemId: 'selected',
  revision,
  disposition: 'active',
  effectiveDisposition: 'active',
  inheritedFrom: null,
  pause: { stage: 'running', controls: [] },
  history: [],
};
const command = {
  requestId: 'exact-request',
  itemId: 'selected',
  expectedRevision: revision,
  operation: 'pause' as const,
};
it('reads identity-bound current lifecycle and operator list views through existing browser transport', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(lifecycle))
    .mockResolvedValueOnce(Response.json([lifecycle]));
  const api = new TelosWorkApiClient(fetch);
  expect(await api.readLifecycle('selected')).toEqual(lifecycle);
  expect(await api.listLifecycle('active')).toEqual([lifecycle]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/telos/work/items/selected/lifecycle',
    '/api/telos/work/lifecycle?view=active',
  ]);
  expect(fetch.mock.calls.every(([, init]) => init.credentials === 'include' && !init.body)).toBe(
    true,
  );
});
it('sends only the exact revision/request/operation envelope and validates the historical receipt identity', async () => {
  const receipt = {
    requestId: command.requestId,
    itemId: command.itemId,
    operation: command.operation,
    lifecycle: { ...lifecycle, pause: { stage: 'requested', controls: [] } },
  };
  const fetch = vi.fn().mockResolvedValue(Response.json(receipt));
  const api = new TelosWorkApiClient(fetch);
  expect(await api.executeLifecycle(command)).toEqual(receipt);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/telos/work/lifecycle',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    }),
  );
});
it.each([
  { ...command, operation: 'delete_permanently' },
  {
    ...command,
    operation: 'delete_permanently',
    confirmation: { itemId: 'another', phrase: 'DELETE PERMANENTLY' },
  },
  { ...command, actorId: 'invented' },
])(
  'rejects unconfirmed/identity-mismatched destructive commands or caller authority before HTTP',
  async (input) => {
    const fetch = vi.fn();
    await expect(new TelosWorkApiClient(fetch).executeLifecycle(input as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([
  { requestId: 'another', itemId: 'selected', operation: 'pause', lifecycle },
  { requestId: command.requestId, itemId: 'another', operation: 'pause', lifecycle },
  { requestId: command.requestId, itemId: 'selected', operation: 'resume', lifecycle },
  { requestId: command.requestId, itemId: 'selected', operation: 'pause', lifecycle: null },
])(
  'rejects a successful HTTP response for a different command or absent non-delete lifecycle',
  async (receipt) => {
    await expect(
      new TelosWorkApiClient(vi.fn(async () => Response.json(receipt))).executeLifecycle(command),
    ).rejects.toThrow();
  },
);
it('preserves a guarded permanent-delete refusal instead of manufacturing availability or success', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ code: 'unavailable', error: 'Quiescence proof unavailable' }, { status: 503 }),
  );
  const input = {
    ...command,
    operation: 'delete_permanently' as const,
    confirmation: { itemId: 'selected', phrase: 'DELETE PERMANENTLY' as const },
  };
  await expect(new TelosWorkApiClient(fetch).executeLifecycle(input)).rejects.toMatchObject({
    status: 503,
    code: 'unavailable',
    message: 'Quiescence proof unavailable',
  });
  expect(TelosWorkApiError).toBeDefined();
});

it('does not accept a non-deletion lifecycle body as proof that permanent deletion succeeded', async () => {
  const input = {
    ...command,
    operation: 'delete_permanently' as const,
    confirmation: { itemId: 'selected', phrase: 'DELETE PERMANENTLY' as const },
  };
  const fetch = vi.fn(async () =>
    Response.json({
      requestId: input.requestId,
      itemId: input.itemId,
      operation: input.operation,
      lifecycle,
    }),
  );
  await expect(new TelosWorkApiClient(fetch).executeLifecycle(input)).rejects.toThrow();
});
