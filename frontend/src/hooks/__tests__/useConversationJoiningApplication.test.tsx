// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationJoiningApplication } from '../useConversationJoiningApplication';
import { useConversationJoiningReview } from '../useConversationJoiningReview';
import * as auth from '../../lib/api-fetch';
import { joiningApplicationHarness as harness } from '../../test-utils/conversation-joining-application-harness';

const originalBase = import.meta.env.VITE_API_BASE_URL;
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'target-owner-login' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  cleanup();
  import.meta.env.VITE_API_BASE_URL = originalBase;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Full private frontend composition with strict HTTP boundary recordings.
 * Neither cookie/transport/EventStore authority nor native capacity is faked as qualified. */

const props = {
  sourceConversationId: 'source-chat' as string | null,
  clientId: 'live-client' as string | null,
  routeKey: 'route-a',
};
function mount() {
  return renderHook(
    (input) => {
      const app = useConversationJoiningApplication(input);
      const flow = useConversationJoiningReview(app.owner);
      return { app, flow };
    },
    { initialProps: props },
  );
}
const effectPaths = (h: ReturnType<typeof harness>) =>
  h.transport.mock.calls.filter(([url]) =>
    /\/(begin|preview|prepare|reviews|joins)$/.test(
      new URL(url, 'https://offline.invalid').pathname,
    ),
  );

it('mounts only real observational readers and begins no relationship, workspace, review or model operation', async () => {
  const h = harness();
  const hook = mount();
  await waitFor(() => expect(hook.result.current.app.catalog.catalog).not.toBeNull());
  expect(hook.result.current.app.owner).toBeUndefined();
  expect(effectPaths(h)).toHaveLength(0);
  expect(h.journal.read()).toBeNull();
  expect(h.journal.readBegin()).toBeNull();
});

it('composes explicit first Add, ordinary target staging and typed unverified Review with original identity retained', async () => {
  const h = harness();
  const hook = mount();
  await waitFor(() => expect(hook.result.current.app.catalog.catalog).not.toBeNull());
  await act(() => hook.result.current.app.add());
  await waitFor(() => expect(hook.result.current.app.owner).toBeDefined());
  await waitFor(() => expect(hook.result.current.flow.locked).toBe(false));
  const begin = h.journal.readBegin()!;
  expect(begin.collaborationId).toBe(h.group());
  expect(h.journal.read()).toBeNull();
  expect(effectPaths(h).map(([url]) => new URL(url, 'https://offline.invalid').pathname)).toEqual([
    `/api/session-collaborations/${begin.collaborationId}/begin`,
  ]);
  await act(() =>
    hook.result.current.flow.prepare(
      { ...h.request.setup, sourceRepository: 'dimakis/mitzo' },
      h.request.joiningBrief,
    ),
  );
  expect(hook.result.current.flow.error).toBeNull();
  expect(hook.result.current.flow.review?.snapshot.capacity.status).toBe('unverified');
  expect(hook.result.current.flow.canConfirm).toBe(false);
  expect(h.journal.readTarget()?.phase).toBe('resolved');
  const count = h.transport.mock.calls.length;
  await act(() => hook.result.current.flow.confirm());
  expect(h.transport).toHaveBeenCalledTimes(count);
});

it('recovers a committed lost begin on explicit retry without another UUID or POST', async () => {
  const h = harness();
  h.loseBegin();
  const hook = mount();
  await act(() => hook.result.current.app.add());
  await waitFor(() => expect(hook.result.current.app.canRetry).toBe(true));
  const original = h.journal.readBegin();
  act(() => hook.result.current.app.retry());
  await waitFor(() => expect(hook.result.current.app.owner).toBeDefined());
  expect(h.journal.readBegin()).toEqual(original);
  expect(h.transport.mock.calls.filter(([url]) => url.endsWith('/begin'))).toHaveLength(1);
});

it('retires a pending Add through route A-B-A and recovers only its original canonical group on a new action', async () => {
  const h = harness();
  const old = deferred();
  h.beginWait(old.promise);
  const hook = mount();
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.app.add();
  });
  await waitFor(() => expect(h.group()).not.toBeNull());
  const original = h.journal.readBegin()!;
  hook.rerender({ ...props, routeKey: 'route-b' });
  hook.rerender({ ...props, routeKey: 'route-a-again' });
  await act(async () => {
    old.resolve(
      Response.json({
        version: 1,
        collaborationId: original.collaborationId,
        revision: 1,
        participantSessionIds: ['source-chat'],
      }),
    );
    await pending;
  });
  expect(hook.result.current.app.owner).toBeUndefined();
  await act(() => hook.result.current.app.add());
  await waitFor(() => expect(hook.result.current.app.owner).toBeDefined());
  expect(h.journal.readBegin()).toEqual(original);
  expect(h.transport.mock.calls.filter(([url]) => url.endsWith('/begin'))).toHaveLength(1);
});

it('keeps genuine canonical multiple-member groups unavailable for ordinary Send, including client loss', async () => {
  const h = harness('00000000-0000-4000-8000-000000000010', ['source-chat', 'peer']);
  const hook = mount();
  await waitFor(() => expect(hook.result.current.app.sendUnavailable).toBeTruthy());
  hook.rerender({ ...props, clientId: null });
  expect(hook.result.current.app.sendUnavailable).toBeTruthy();
  expect(effectPaths(h)).toHaveLength(0);
});

it('retire-and-restores same-ID auth without permitting the old Review action to prepare or publish', async () => {
  const h = harness('00000000-0000-4000-8000-000000000010');
  let release!: () => void;
  const old = new Promise<void>((done) => {
    release = done;
  });
  h.after((path) => (path === '/api/chat/runtime/capabilities' ? old : undefined));
  const hook = mount();
  await waitFor(() => expect(hook.result.current.app.owner).toBeDefined());
  await waitFor(() => expect(hook.result.current.flow.locked).toBe(false));
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.flow.prepare(
      { ...h.request.setup, sourceRepository: 'dimakis/mitzo' },
      h.request.joiningBrief,
    );
  });
  await waitFor(() =>
    expect(h.transport.mock.calls.some(([url]) => url.endsWith('/capabilities'))).toBe(true),
  );
  await act(async () => {
    auth.markAuthLost();
    await auth.restoreCookieAuthentication();
  });
  await act(async () => {
    release();
    await pending;
  });
  expect(h.journal.readTarget()).toBeNull();
  expect(hook.result.current.flow.review).toBeNull();
  expect(effectPaths(h)).toHaveLength(0);
});
