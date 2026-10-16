import { describe, expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '../telos-work-api.js';
import { TelosWorkViewSchema } from '@mitzo/protocol';
const view = TelosWorkViewSchema.parse({
  itemId: 'item',
  kind: null,
  parentId: null,
  revision: 'a'.repeat(64),
  links: [],
  assignments: [],
  sources: [],
  attempts: [],
});
describe('typed Telos work client', () => {
  it('uses ordinary authenticated API calls without allocation or hidden retries', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(view)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ commandId: 'command', actorId: 'operator:verified', work: view }),
        ),
      )
      .mockResolvedValueOnce(new Response('[]'));
    const api = new TelosWorkApiClient(fetch);
    expect(await api.read('item')).toEqual(view);
    const command = {
      operation: 'classify' as const,
      itemId: 'item',
      kind: 'outcome' as const,
      requestId: 'explicit',
      expectedRevision: view.revision,
    };
    expect((await api.execute(command)).work).toEqual(view);
    expect(await api.links({ namespace: 'mitzo', conversationId: 'chat' })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]).toMatchObject([
      '/api/telos/work/items/item',
      { credentials: 'include' },
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(command);
  });
  it('rejects malformed data and exposes conflicts without generating a replacement request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Stale work', code: 'conflict' }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response('{}'));
    const api = new TelosWorkApiClient(fetch);
    await expect(api.read('item')).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(api.read('item')).rejects.toThrow();
    await expect(api.read('../secrets')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
