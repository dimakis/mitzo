import { expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { CollaborationApiClient } from '../collaboration-api.js';

it('reads actual source setup with cancellation and transport correlation only', async () => {
  const body = { state: 'unstarted', sourceConversationId: 'ordinary-source' };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
  const controller = new AbortController();
  await expect(
    new CollaborationApiClient(fetch).sourceSetup(
      'ordinary-source',
      'live-client',
      controller.signal,
    ),
  ).resolves.toEqual(body);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/session-collaborations/source-setup?sourceConversationId=ordinary-source&clientId=live-client',
    {
      credentials: 'include',
      signal: controller.signal,
    },
  );
});
it.each([
  { state: 'unstarted', sourceConversationId: 'foreign' },
  {
    state: 'selected',
    sourceConversationId: 'ordinary-source',
    collaboration: {
      version: 1,
      collaborationId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      participantSessionIds: ['foreign'],
    },
  },
  { state: 'unstarted', sourceConversationId: 'ordinary-source', ready: true },
])('rejects foreign or invented source-setup state', async (body) => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
  await expect(
    new CollaborationApiClient(fetch).sourceSetup('ordinary-source', 'live-client'),
  ).rejects.toBeInstanceOf(ZodError);
});
