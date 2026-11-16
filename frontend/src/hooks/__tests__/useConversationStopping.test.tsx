// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApiClient } from '@mitzo/client';
import { useConversationStopping } from '../useConversationStopping';
import { chatStorage, chatStorageKeys } from '../../lib/large-chat-storage';
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('retains every selected Stop identity before dispatch so reload recovers later targets', async () => {
  const api = new CollaborationApiClient(vi.fn());
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = vi.spyOn(api, 'stopAgents').mockImplementation(async (_group, input) => {
    await barrier;
    return {
      requestId: input.requestId,
      recipients: input.targets.map((target) => ({ ...target, status: 'settled' as const })),
    };
  });
  const options = {
    api,
    group: 'batch-group',
    authScope: 'login',
    getVerifiedAuthScope: () => 'login',
    membershipRevision: 1,
    memberIds: ['one', 'two'],
    targets: ['one', 'two'].map((sessionId, index) => ({
      sessionId,
      name: sessionId,
      messageId: '00000000-0000-4000-8000-000000000001',
      deliveryId: `00000000-0000-4000-8000-00000000000${index + 2}`,
      commandId: sessionId + '-command',
    })),
  };
  const first = renderHook(() => useConversationStopping(options));
  let pending!: Promise<void>;
  act(() => {
    pending = first.result.current.stop();
  });
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  const retained = chatStorageKeys()
    .filter((key) => key.startsWith('mitzo-conversation-stop:batch-group:'))
    .map((key) => JSON.parse(chatStorage.getItem(key)!).input);
  first.unmount();
  release();
  await act(async () => {
    await pending;
  });
  expect(retained).toHaveLength(2);
  const second = renderHook(() => useConversationStopping({ ...options, targets: [] }));
  await act(async () => {
    await second.result.current.check();
  });
  expect(stop.mock.calls.slice(1).map((call) => call[1])).toEqual(retained);
  expect(second.result.current.pending).toBe(false);
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
