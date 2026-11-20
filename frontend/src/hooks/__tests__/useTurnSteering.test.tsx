// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTurnSteering } from '../useTurnSteering';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));

it('shows a sanitized server reference while retaining an unconfirmed correction for the same-identity check', async () => {
  const diagnosticId = '84b57f38-264c-4d56-aed1-cb5a9c381e92';
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json(
      {
        code: 'turn_steering_unconfirmed',
        diagnosticId,
        error: 'private upstream error',
      },
      { status: 409 },
    ),
  );
  const delivery = vi.fn();
  const hook = renderHook(() => useTurnSteering('diagnostic-chat', 'original', true));
  await act(async () => hook.result.current.submit('Keep the draft', delivery));
  expect(hook.result.current.error).toContain(diagnosticId);
  expect(hook.result.current.error).not.toContain('private upstream error');
  expect(delivery).toHaveBeenLastCalledWith('uncertain');
  const original = vi.mocked(apiFetch).mock.calls.at(-1)![1]!.body;
  vi.mocked(apiFetch).mockRejectedValueOnce(Error('lost'));
  await act(async () => hook.result.current.retry!());
  expect(vi.mocked(apiFetch).mock.calls.at(-1)![1]!.body).toBe(original);
  expect(localStorage.getItem('mitzo-turn-steering:diagnostic-chat')).toContain('Keep the draft');
});

it('refuses invalid screenshot data without dispatching or losing the draft receipt', async () => {
  const delivery = vi.fn();
  const hook = renderHook(() => useTurnSteering('invalid-image', 'first', true));
  await act(async () =>
    hook.result.current.submit(
      'Keep this draft',
      delivery,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ data: 'bad!', mediaType: 'image/png' }],
    ),
  );
  expect(delivery).toHaveBeenCalledExactlyOnceWith('failed');
  expect(apiFetch).not.toHaveBeenCalled();
  expect(hook.result.current.error).toContain('draft');
});

it('retains screenshot bytes across uncertainty, reload and a changed target without replacing them', async () => {
  const images = [{ data: 'aGk=', mediaType: 'image/png' as const }];
  vi.mocked(apiFetch).mockRejectedValueOnce(Error('lost'));
  const hook = renderHook(() => useTurnSteering('image-chat', 'first', true));
  await act(async () =>
    hook.result.current.submit(
      'Use this screenshot',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      images,
    ),
  );
  const first = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
  expect(first).toMatchObject({ targetCommandId: 'first', text: 'Use this screenshot', images });
  hook.unmount();
  const restored = renderHook(() => useTurnSteering('image-chat', 'successor', true));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(async () =>
    restored.result.current.submit(
      'Use this screenshot',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ ...images[0], data: 'YQ==' }],
    ),
  );
  expect(apiFetch).toHaveBeenCalledTimes(1);
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ requestId: first.requestId, status: 'accepted' }),
  );
  await act(async () => restored.result.current.retry!());
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]!.body as string)).toEqual(first);
});
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
it('retains an uncertain correction across a generic auth denial and emits refusal proof only for its matching receipt', async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(Error('lost'));
  const delivery = vi.fn(),
    proof = vi.fn();
  const hook = renderHook(() => useTurnSteering('auth-recovery', 'original-turn', true));
  await act(async () =>
    hook.result.current.submit(
      'Correction',
      delivery,
      undefined,
      'original-id',
      'original-turn',
      proof,
    ),
  );
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ error: 'Expired sign-in' }, { status: 403 }),
  );
  await act(async () => hook.result.current.retry!());
  expect(proof).not.toHaveBeenCalled();
  expect(delivery).toHaveBeenLastCalledWith('uncertain');
  expect(localStorage.getItem('mitzo-turn-steering:auth-recovery')).toContain('original-id');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ requestId: 'original-id', status: 'rejected' }, { status: 409 }),
  );
  await act(async () => hook.result.current.retry!());
  expect(proof).toHaveBeenCalledOnce();
  expect(delivery).toHaveBeenLastCalledWith('failed');
});
it('re-checks a server-retained uncertain screenshot correction until its receipt is accepted', async () => {
  vi.useFakeTimers();
  const images = [{ data: 'aGk=', mediaType: 'image/png' as const }];
  const bodies: string[] = [];
  let checks = 0;
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    bodies.push(options!.body as string);
    const { requestId } = JSON.parse(options!.body as string);
    checks += 1;
    return Response.json(
      { requestId, status: checks === 1 ? 'uncertain' : 'accepted' },
      { status: checks === 1 ? 202 : 200 },
    );
  });
  const delivery = vi.fn();
  const hook = renderHook(() => useTurnSteering('recheck-chat', 'turn', true));
  await act(async () => {
    hook.result.current.submit(
      'Screenshot',
      delivery,
      undefined,
      undefined,
      undefined,
      undefined,
      images,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(hook.result.current.busy).toBe(true);
  expect(hook.result.current.error).toBe('');
  expect(delivery).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(delivery).toHaveBeenCalledExactlyOnceWith('accepted');
  expect(hook.result.current.error).toBe('');
  expect(hook.result.current.retry).toBeUndefined();
  expect(localStorage.getItem('mitzo-turn-steering:recheck-chat')).toBeNull();
});
it('reports an unconfirmed correction only after bounded re-checks of a still-uncertain receipt', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(apiFetch).mockImplementation(async (_url, options) =>
    Response.json(
      { requestId: JSON.parse(options!.body as string).requestId, status: 'uncertain' },
      { status: 202 },
    ),
  );
  const delivery = vi.fn();
  const hook = renderHook(() => useTurnSteering('pending-chat', 'turn', true));
  await act(async () => {
    hook.result.current.submit('Correction', delivery);
    await vi.advanceTimersByTimeAsync(2999);
  });
  expect(hook.result.current.busy).toBe(true);
  expect(apiFetch).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(apiFetch).toHaveBeenCalledTimes(4);
  expect(hook.result.current.busy).toBe(false);
  expect(delivery).toHaveBeenCalledExactlyOnceWith('uncertain');
  expect(hook.result.current.error).toMatch(/not confirmed/);
  expect(hook.result.current.retry).toBeDefined();
  expect(warn).toHaveBeenCalledWith(
    '[mitzo] Turn correction receipt still pending',
    expect.objectContaining({ code: 'turn_steering_receipt_pending', sessionId: 'pending-chat' }),
  );
  expect(localStorage.getItem('mitzo-turn-steering:pending-chat')).toContain('Correction');
});
it('does not automatically re-send after a lost response', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockRejectedValue(Error('lost'));
  const hook = renderHook(() => useTurnSteering('lost-chat', 'turn', true));
  await act(async () => {
    hook.result.current.submit('Correction');
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(apiFetch).toHaveBeenCalledOnce();
  expect(hook.result.current.error).toMatch(/not confirmed/);
});
it('retires an unconfirmed correction as terminal, returns the text and never replays it', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ code: 'x' }, { status: 503 }));
  const delivery = vi.fn(),
    release = vi.fn();
  const hook = renderHook(() => useTurnSteering('unconfirmed-chat', 'original-turn', true));
  await act(async () =>
    hook.result.current.submit('Correction', delivery, undefined, 'req-1', undefined, release),
  );
  expect(delivery).toHaveBeenLastCalledWith('uncertain');
  expect(hook.result.current.retry).toBeDefined();
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ requestId: 'req-1', status: 'unconfirmed' }, { status: 409 }),
  );
  await act(async () => hook.result.current.retry!());
  expect(delivery).toHaveBeenLastCalledWith('failed');
  expect(release).toHaveBeenCalledOnce();
  expect(hook.result.current.retry).toBeUndefined();
  expect(hook.result.current.error).toContain('may or may not have been applied');
  expect(localStorage.getItem('mitzo-turn-steering:unconfirmed-chat')).toBeNull();
});
