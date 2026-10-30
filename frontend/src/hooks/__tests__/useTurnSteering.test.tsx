// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTurnSteering } from '../useTurnSteering';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(apiFetch).mockReset();
  vi.useRealTimers();
});
it('retains and explicitly retries the same correction after response loss, even after the active turn changes', async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(Error('lost'));
  const delivery = vi.fn();
  const hook = renderHook(({ target }) => useTurnSteering('chat', target, true), {
    initialProps: { target: 'a' },
  });
  await act(async () => {
    hook.result.current.submit('Correction', delivery);
  });
  const first = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
  expect(first).toMatchObject({ targetCommandId: 'a', text: 'Correction' });
  expect(localStorage.getItem('mitzo-turn-steering:chat')).toContain(first.requestId);
  expect(delivery).toHaveBeenCalledWith('uncertain');
  hook.rerender({ target: 'b' });
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ requestId: first.requestId, status: 'accepted' }),
  );
  await act(async () => {
    hook.result.current.retry!();
  });
  const second = JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]!.body as string);
  expect(second).toEqual(first);
  expect(delivery).toHaveBeenLastCalledWith('accepted');
  expect(localStorage.getItem('mitzo-turn-steering:chat')).toBeNull();
});
it('restores pending identity on reload without automatically sending it', async () => {
  localStorage.setItem(
    'mitzo-turn-steering:chat',
    JSON.stringify({ requestId: 'original', targetCommandId: 'a', text: 'Correction' }),
  );
  vi.mocked(apiFetch).mockReset();
  const hook = renderHook(() => useTurnSteering('chat', 'b', true));
  expect(hook.result.current.error).toMatch(/not confirmed/);
  expect(apiFetch).not.toHaveBeenCalled();
});
it('refuses storage failure without sending and retains the composer', async () => {
  vi.mocked(apiFetch).mockReset();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('quota');
  });
  const hook = renderHook(() => useTurnSteering('chat', 'a', true));
  const delivery = vi.fn();
  await act(async () => hook.result.current.submit('Correction', delivery));
  expect(delivery).toHaveBeenCalledWith('failed');
  expect(apiFetch).not.toHaveBeenCalled();
});

it('bounds a stalled correction response body and retains its identity', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: () => new Promise(() => {}),
  } as Response);
  const delivery = vi.fn();
  const hook = renderHook(() => useTurnSteering('chat', 'a', true));
  await act(async () => {
    hook.result.current.submit('Correction', delivery);
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.error).toMatch(/not confirmed/);
  expect(delivery).toHaveBeenCalledWith('uncertain');
  expect(localStorage.getItem('mitzo-turn-steering:chat')).toContain('Correction');
});

it('a late original receipt cannot remove a newer correction saved after returning to the chat', async () => {
  let original!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        original = resolve;
      }),
  );
  const hook = renderHook(({ id }) => useTurnSteering(id, 'a', true), {
    initialProps: { id: 'chat' },
  });
  await act(async () => {
    hook.result.current.submit('R1');
  });
  const first = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
  hook.rerender({ id: 'other' });
  hook.rerender({ id: 'chat' });
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ requestId: first.requestId, status: 'accepted' }),
  );
  await act(async () => {
    hook.result.current.retry!();
  });
  vi.mocked(apiFetch).mockRejectedValueOnce(Error('lost'));
  await act(async () => {
    hook.result.current.submit('R2');
  });
  const second = localStorage.getItem('mitzo-turn-steering:chat');
  expect(second).toContain('R2');
  await act(async () => {
    original(Response.json({ requestId: first.requestId, status: 'accepted' }));
  });
  expect(localStorage.getItem('mitzo-turn-steering:chat')).toBe(second);
});
it('shows sending progress while a first correction is pending', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => useTurnSteering('chat', 'a', true));
  await act(async () => {
    hook.result.current.submit('Correction');
  });
  expect(hook.result.current.busy).toBe(true);
  expect(hook.result.current.error).toBe('');
});

it('retains the exact reply on correction retry and rejects a changed reference with identical text', async () => {
  vi.mocked(apiFetch).mockRejectedValue(Error('lost'));
  const hook = renderHook(() => useTurnSteering('reply-chat', 'turn', true));
  await act(async () => hook.result.current.submit('Correction', undefined, 'source-one'));
  const first = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
  expect(first.replyToMessageId).toBe('source-one');
  const delivery = vi.fn();
  await act(async () => hook.result.current.submit('Correction', delivery, 'source-two'));
  expect(apiFetch).toHaveBeenCalledOnce();
  expect(delivery).toHaveBeenCalledWith('failed');
  await act(async () => hook.result.current.retry!());
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]!.body as string)).toEqual(first);
});
it('checks an explicitly retained correction against its captured target after the active turn changes', async () => {
  vi.mocked(apiFetch).mockImplementationOnce(async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    return Response.json({ requestId: body.requestId, status: 'stale_target' }, { status: 409 });
  });
  const delivery = vi.fn();
  const hook = renderHook(() => useTurnSteering('cold-chat', 'successor-turn', true));
  await act(async () =>
    hook.result.current.submit(
      'Original correction',
      delivery,
      undefined,
      'correction-id',
      'original-turn',
    ),
  );
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toMatchObject({
    requestId: 'correction-id',
    targetCommandId: 'original-turn',
  });
  expect(delivery).toHaveBeenCalledWith('failed');
});
