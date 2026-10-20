import { expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '../telos-work-api.js';

const receipt = {
  version: 1,
  controlId: 'control',
  coordinatorItemId: 'coordinator',
  coordinatorConversationId: 'coordinator-chat',
  priorityItemId: 'priority',
  scope: 'new_worker_dispatch',
  stage: 'requested',
  publicationRevalidation: 'not_applicable',
  targets: [],
  history: [],
};
const request = {
  operation: 'request' as const,
  requestId: 'original-request',
  coordinatorItemId: 'coordinator',
  priorityItemId: 'priority',
  targetItemIds: ['other'],
  scope: 'new_worker_dispatch' as const,
};
it('sends the exact operator request through signed browser transport without a forged native actor', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(receipt)));
  const api = new TelosWorkApiClient(fetch);
  expect(await api.control(request)).toEqual(receipt);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/telos/work/controls',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
});
it('reads retained inbox state and the exact control without manufacturing acknowledgement or application', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify([receipt])))
    .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
  const api = new TelosWorkApiClient(fetch);
  expect(await api.control({ operation: 'inbox', itemId: 'coordinator' })).toEqual([receipt]);
  expect(await api.control({ operation: 'read', controlId: 'control' })).toEqual(receipt);
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).operation)).toEqual([
    'inbox',
    'read',
  ]);
});
it.each([
  {
    operation: 'acknowledge',
    requestId: 'forged',
    controlId: 'control',
    itemId: 'other',
    assignmentRevision: 1,
  },
  { operation: 'applied', controlId: 'control' },
  { operation: 'revalidate', controlId: 'control' },
])('does not expose recipient or host writes through the operator client (%s)', async (command) => {
  const fetch = vi.fn();
  const api = new TelosWorkApiClient(fetch);
  await expect(api.control(command as never)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  [{ operation: 'inbox', itemId: 'coordinator' }, receipt],
  [{ operation: 'read', controlId: 'control' }, [receipt]],
  [{ operation: 'read', controlId: 'elsewhere' }, receipt],
  [request, { ...receipt, coordinatorItemId: 'elsewhere' }],
  [request, { ...receipt, priorityItemId: 'elsewhere' }],
  [request, { ...receipt, scope: 'safe_point' }],
])(
  'rejects a shape or identity mismatch without accepting a different receipt',
  async (command, result) => {
    const api = new TelosWorkApiClient(vi.fn(async () => new Response(JSON.stringify(result))));
    await expect(api.control(command as never)).rejects.toThrow();
  },
);
it.each([403, 409])(
  'preserves definitive refusal status %s and never retries automatically',
  async (status) => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: 'unauthorized', error: 'Current coordinator authority required' }),
          { status },
        ),
    );
    await expect(new TelosWorkApiClient(fetch).control(request)).rejects.toMatchObject({
      status,
      message: 'Current coordinator authority required',
    });
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it('leaves uncertain delivery to exact-id caller recovery and preserves an explicit retry body', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Connection lost'))
    .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
  const api = new TelosWorkApiClient(fetch);
  await expect(api.control(request)).rejects.toThrow('Connection lost');
  expect(fetch).toHaveBeenCalledOnce();
  expect(await api.control(request)).toEqual(receipt);
  expect(fetch.mock.calls.map(([, init]) => init.body)).toEqual([
    JSON.stringify(request),
    JSON.stringify(request),
  ]);
});
