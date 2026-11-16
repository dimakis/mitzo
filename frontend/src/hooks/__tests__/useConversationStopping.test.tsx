// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApiClient } from '@mitzo/client';
import { useConversationStopping } from '../useConversationStopping';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('stops selected agents independently and recovers the original control after a lost response', async () => {
  const api = new CollaborationApiClient(vi.fn());
  let recover = false;
  const stop = vi.spyOn(api, 'stopAgents').mockImplementation(async (_group, input) => {
    if (!recover) throw Error('Stop acknowledgement lost');
    return {
      requestId: input.requestId,
      recipients: input.targets.map((target) => ({ ...target, status: 'settled' as const })),
    };
  });
  const options = {
    api,
    group: 'group',
    authScope: 'login',
    getVerifiedAuthScope: () => 'login',
    membershipRevision: 1,
    memberIds: ['one', 'two'],
    targets: [
      {
        sessionId: 'one',
        name: 'One',
        messageId: '00000000-0000-4000-8000-000000000001',
        deliveryId: '00000000-0000-4000-8000-000000000002',
        commandId: 'one-command',
      },
    ],
  };
  const first = renderHook(() => useConversationStopping(options));
  await act(async () => {
    await first.result.current.stop();
  });
  const original = stop.mock.calls[0][1];
  expect(original.targets.map((target) => target.sessionId)).toEqual(['one']);
  first.unmount();
  recover = true;
  const second = renderHook(() => useConversationStopping({ ...options, targets: [] }));
  expect(second.result.current.pending).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
  await act(async () => {
    await second.result.current.check();
  });
  expect(stop.mock.calls[1][1]).toEqual(original);
  expect(second.result.current.pending).toBe(false);
});
