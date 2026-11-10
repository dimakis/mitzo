// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApiClient } from '@mitzo/client';
import type { CollaborationProgress } from '@mitzo/protocol';
import {
  sharedConversationView,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../../lib/api-fetch';
import { useConversationProgress } from '../useConversationProgress';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  refreshTranscript.mockClear();
});
const refreshTranscript = vi.fn(async () => {});
const fixture = () => {
  const view = sharedConversationView();
  const progress: CollaborationProgress = {
    collaborationId: view.collaborationId,
    membershipRevision: view.membershipRevision,
    replies: [
      {
        projectionId: uuid(93),
        sourceMessageId: 'partial',
        sessionId: 'reviewer',
        deliveryId: uuid(5),
        text: 'Authorized live text',
      },
    ],
    refusals: [],
  };
  const api = new CollaborationApiClient(vi.fn());
  return { view, progress, api };
};

it('clears live private text on auth loss and ignores a late read response', async () => {
  const { view, progress, api } = fixture();
  let verified: string | undefined = 'login';
  const proof = () => verified;
  let resolve!: (value: CollaborationProgress) => void;
  const read = vi.spyOn(api, 'progress').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const hook = renderHook(() =>
    useConversationProgress({
      api,
      view,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      refreshTranscript,
    }),
  );
  expect(read).toHaveBeenCalledOnce();
  // Auth event can precede the scope owner's React publication. Sticky loss
  // must still fence a response already resolving with the former proof.
  act(() => {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  });
  await act(async () => {
    resolve(progress);
  });
  expect(hook.result.current.progress).toBeUndefined();
  expect(read.mock.calls[0][1]?.aborted).toBe(true);
  expect(read).toHaveBeenCalledOnce();
  verified = undefined;
  expect(refreshTranscript).not.toHaveBeenCalled();
});

it.each([true, false])(
  'refreshes finalized discussion without a local send, including a turn entirely between samples (live=%s)',
  async (live) => {
    vi.useFakeTimers();
    const { view, progress, api } = fixture();
    const proof = () => 'login';
    vi.spyOn(api, 'progress')
      .mockResolvedValueOnce({ ...progress, replies: live ? progress.replies : [] })
      .mockResolvedValue({ ...progress, replies: [] });
    renderHook(() =>
      useConversationProgress({
        api,
        view,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        refreshTranscript,
      }),
    );
    await act(async () => {});
    expect(refreshTranscript).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(refreshTranscript).toHaveBeenCalledTimes(2);
    expect(api.progress).toHaveBeenCalledTimes(2);
  },
);

it('renews reads after verified same-login restoration and rejects pre-loss responses', async () => {
  const { view, progress, api } = fixture();
  let verified: string | undefined = 'login';
  const proof = () => verified;
  let old!: (value: CollaborationProgress) => void;
  vi.spyOn(api, 'progress')
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          old = r;
        }),
    )
    .mockResolvedValue({
      ...progress,
      replies: [{ ...progress.replies[0], text: 'Renewed live text' }],
    });
  const hook = renderHook(() =>
    useConversationProgress({
      api,
      view,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      refreshTranscript,
    }),
  );
  act(() => {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    verified = undefined;
  });
  await act(async () => {
    window.dispatchEvent(new Event(AUTH_RESTORED_EVENT));
    verified = 'login';
  });
  await waitFor(() =>
    expect(hook.result.current.progress?.replies[0].text).toBe('Renewed live text'),
  );
  await act(async () => {
    old(progress);
  });
  expect(hook.result.current.progress?.replies[0].text).toBe('Renewed live text');
  expect(api.progress).toHaveBeenCalledTimes(2);
});

it('lets a newer auth loss win over an already queued restoration callback', async () => {
  vi.useFakeTimers();
  const { view, progress, api } = fixture();
  const proof = () => 'login'; // The auth owner has not published its new scope yet.
  vi.spyOn(api, 'progress').mockResolvedValue(progress);
  const hook = renderHook(() =>
    useConversationProgress({
      api,
      view,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      refreshTranscript,
    }),
  );
  await act(async () => {});
  expect(hook.result.current.progress?.replies).toHaveLength(1);
  await act(async () => {
    window.dispatchEvent(new Event(AUTH_RESTORED_EVENT));
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(hook.result.current.progress).toBeUndefined();
  expect(api.progress).toHaveBeenCalledOnce();
  await act(async () => {
    window.dispatchEvent(new Event(AUTH_RESTORED_EVENT));
  });
  expect(api.progress).toHaveBeenCalledTimes(2);
  expect(hook.result.current.progress?.replies).toHaveLength(1);
});

it('cannot restore an old audience response after membership changes', async () => {
  const { view, progress, api } = fixture();
  const proof = () => 'login';
  let resolve!: (value: CollaborationProgress) => void;
  const next = {
    ...view,
    membershipRevision: view.membershipRevision + 1,
    participantSessionIds: ['architect'],
    unavailableParticipantSessionIds: [],
  };
  vi.spyOn(api, 'progress')
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({ ...progress, membershipRevision: next.membershipRevision, replies: [] });
  const hook = renderHook(
    ({ current }) =>
      useConversationProgress({
        api,
        view: current,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        refreshTranscript,
      }),
    { initialProps: { current: view } },
  );
  hook.rerender({ current: next });
  await waitFor(() => expect(hook.result.current.progress?.replies).toEqual([]));
  await act(async () => {
    resolve(progress);
  });
  expect(hook.result.current.progress?.replies).toEqual([]);
});

it('discards mismatched live material but renews the authorized view after remote membership drift', async () => {
  const { view, progress, api } = fixture();
  const next = { ...view, membershipRevision: view.membershipRevision + 1 };
  const proof = () => 'login';
  vi.spyOn(api, 'progress').mockResolvedValue({
    ...progress,
    membershipRevision: next.membershipRevision,
  });
  const hook = renderHook(
    ({ current }) =>
      useConversationProgress({
        api,
        view: current,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        refreshTranscript,
      }),
    { initialProps: { current: view } },
  );
  await waitFor(() => expect(refreshTranscript).toHaveBeenCalledOnce());
  expect(hook.result.current.progress).toBeUndefined();
  expect(hook.result.current.error).toContain('conversation changed');
  hook.rerender({ current: next });
  await waitFor(() =>
    expect(hook.result.current.progress?.membershipRevision).toBe(next.membershipRevision),
  );
  expect(refreshTranscript).toHaveBeenCalledTimes(2);
});

it('removes stale live text after an unavailable refresh and exposes failure', async () => {
  vi.useFakeTimers();
  const { view, progress, api } = fixture();
  const proof = () => 'login';
  vi.spyOn(api, 'progress')
    .mockResolvedValueOnce(progress)
    .mockRejectedValue(Error('Live source unavailable'));
  const hook = renderHook(() =>
    useConversationProgress({
      api,
      view,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      refreshTranscript,
    }),
  );
  await act(async () => {});
  expect(hook.result.current.progress?.replies[0].text).toBe('Authorized live text');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(hook.result.current.progress).toBeUndefined();
  expect(hook.result.current.error).toBe('Live source unavailable');
});
