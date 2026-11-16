// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useConversationSteering } from '../useConversationSteering';
import { chatStorage } from '../../lib/large-chat-storage';
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
it('steers selected exact commands, preserves partial outcomes and checks the original correction after remount', async () => {
  const requests: { id: string; body: { requestId: string; targetCommandId: string } }[] = [];
  let recover = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests.push({ id: url, body });
      if (url.includes('/bob/') && !recover) throw Error('Lost acknowledgement');
      return Response.json({ requestId: body.requestId, status: 'accepted' });
    }),
  );
  const options = {
    group: 'group',
    authScope: 'login',
    getVerifiedAuthScope: () => 'login',
    memberIds: ['lead', 'bob'],
    targets: [
      { sessionId: 'lead', name: 'Mitzo', commandId: 'lead-command' },
      { sessionId: 'bob', name: 'Bob', commandId: 'bob-command' },
    ],
  };
  const first = renderHook(() => useConversationSteering(options));
  await act(async () => {
    expect(await first.result.current.steer('Check the UI')).toBe(false);
  });
  expect(requests.map((r) => r.body.targetCommandId)).toEqual(['lead-command', 'bob-command']);
  expect(first.result.current.outcomes.map((r) => r.status)).toEqual(['accepted', 'uncertain']);
  expect(first.result.current.pending).toBe(true);
  const original = requests[1].body;
  first.unmount();
  recover = true;
  const second = renderHook(() => useConversationSteering(options));
  await act(async () => {
    expect(await second.result.current.check()).toBe(true);
  });
  expect(requests).toHaveLength(3);
  expect(requests[2].body).toEqual(original);
  expect(second.result.current.pending).toBe(false);
});
it('renews login and selected membership after durable persistence and before each target', async () => {
  let auth: string | undefined = 'login';
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const flush = vi.spyOn(chatStorage, 'flush').mockImplementation(async () => {
    auth = undefined;
  });
  const h = renderHook(() =>
    useConversationSteering({
      group: 'group',
      authScope: 'login',
      getVerifiedAuthScope: () => auth,
      memberIds: ['lead'],
      targets: [{ sessionId: 'lead', name: 'Mitzo', commandId: 'exact' }],
    }),
  );
  await act(async () => {
    expect(await h.result.current.steer('Do not dispatch after logout')).toBe(false);
  });
  expect(fetch).not.toHaveBeenCalled();
  flush.mockRestore();
});
it('allows steering another agent while retaining an uncertain original correction', async () => {
  const requests: { url: string; requestId: string }[] = [];
  let recover = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests.push({ url, requestId: body.requestId });
      if (url.includes('/lead/') && !recover) throw Error('Lost acknowledgement');
      return Response.json({ requestId: body.requestId, status: 'accepted' });
    }),
  );
  const common = {
    group: 'group',
    authScope: 'login',
    getVerifiedAuthScope: () => 'login',
    memberIds: ['lead', 'bob'],
  };
  const h = renderHook(
    ({ id }) =>
      useConversationSteering({
        ...common,
        targets: [{ sessionId: id, name: id, commandId: id + '-command' }],
      }),
    { initialProps: { id: 'lead' } },
  );
  await act(async () => {
    expect(await h.result.current.steer('Original correction')).toBe(false);
  });
  const original = requests[0];
  h.rerender({ id: 'bob' });
  await act(async () => {
    expect(await h.result.current.steer('Review independently')).toBe(true);
  });
  expect(requests).toHaveLength(2);
  expect(requests[1].url).toContain('/bob/');
  expect(h.result.current.pending).toBe(true);
  recover = true;
  await act(async () => {
    expect(await h.result.current.check()).toBe(true);
  });
  expect(requests[2]).toEqual(original);
  expect(h.result.current.pending).toBe(false);
});
