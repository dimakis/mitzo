// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installSurfaceControlInbox, type SurfaceInboxObservation } from './surface-control-inbox';

const key = '__surfaceInboxTest';
const selector = '.desktop-chat-center';
const options = { method: 'POST', body: JSON.stringify({ operation: 'inbox', itemId: 'coord' }) };
const url = '/api/telos/work/controls';
const observation = () => (window as unknown as Record<string, SurfaceInboxObservation>)[key];
afterEach(() => {
  observation()?.restore();
  delete (window as unknown as Record<string, SurfaceInboxObservation>)[key];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('excludes old mobile and pre-surface requests at issuance while preserving fetch identity', async () => {
  let releaseOld!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => (releaseOld = resolve));
  const currentResponse = Response.json([{ controlId: 'desktop' }]);
  const current = Promise.resolve(currentResponse);
  const original = vi.fn().mockReturnValueOnce(old).mockReturnValue(current);
  vi.stubGlobal('fetch', original);
  const mobile = window.fetch(url, options);
  installSurfaceControlInbox({ key, itemId: 'coord', selector });
  const beforeSurface = window.fetch(url, options);
  document.body.innerHTML = '<div class="desktop-chat-center"></div>';
  releaseOld(Response.json([{ controlId: 'old-mobile' }]));
  await mobile;
  await beforeSurface;
  let settled = false;
  void observation().result.then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  const wrong = { ...options, body: JSON.stringify({ operation: 'inbox', itemId: 'other' }) };
  expect(window.fetch(url, wrong)).toBe(current);
  await Promise.resolve();
  expect(settled).toBe(false);
  const receiver = { marker: 'original receiver' };
  expect(Reflect.apply(window.fetch, receiver, [url, options])).toBe(current);
  expect(original.mock.calls.at(-1)).toEqual([url, options]);
  expect(original.mock.contexts.at(-1)).toBe(receiver);
  await expect(observation().result).resolves.toEqual({
    status: 200,
    body: [{ controlId: 'desktop' }],
  });
  expect(currentResponse.bodyUsed).toBe(false);
  observation().restore();
  expect(window.fetch).toBe(original);
});

it('retains the first eligible failure instead of selecting a later success', async () => {
  const original = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'first failed' }, { status: 503 }))
    .mockResolvedValue(Response.json([{ controlId: 'later' }]));
  vi.stubGlobal('fetch', original);
  document.body.innerHTML = '<div class="desktop-chat-center"></div>';
  installSurfaceControlInbox({ key, itemId: 'coord', selector });
  await window.fetch(url, options);
  await window.fetch(url, options);
  await expect(observation().result).resolves.toEqual({
    status: 503,
    body: { error: 'first failed' },
  });
});

it('ignores only an aborted no-response mount attempt before the live desktop response', async () => {
  const controller = new AbortController();
  let refuse!: (reason: unknown) => void;
  const cancelled = new Promise<Response>((_resolve, reject) => (refuse = reject));
  const original = vi
    .fn()
    .mockReturnValueOnce(cancelled)
    .mockResolvedValue(Response.json([{ controlId: 'live-desktop' }]));
  vi.stubGlobal('fetch', original);
  document.body.innerHTML = '<div class="desktop-chat-center"></div>';
  installSurfaceControlInbox({ key, itemId: 'coord', selector });
  const first = window.fetch(url, { ...options, signal: controller.signal });
  expect(first).toBe(cancelled);
  controller.abort();
  refuse(controller.signal.reason);
  await expect(first).rejects.toBe(controller.signal.reason);
  await window.fetch(url, options);
  await expect(observation().result).resolves.toEqual({
    status: 200,
    body: [{ controlId: 'live-desktop' }],
  });
});

it.each([false, true])(
  'retains a non-abort rejection (own signal aborted: %s)',
  async (aborted) => {
    const failure = new TypeError('Network failed');
    const controller = new AbortController();
    if (aborted) controller.abort();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(Response.json([{ controlId: 'later' }])),
    );
    document.body.innerHTML = '<div class="desktop-chat-center"></div>';
    installSurfaceControlInbox({ key, itemId: 'coord', selector });
    await expect(window.fetch(url, { ...options, signal: controller.signal })).rejects.toBe(
      failure,
    );
    await window.fetch(url, options);
    await expect(observation().result).rejects.toBe(failure);
  },
);

it('propagates malformed first response and restores only its own wrapper', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('malformed'))
      .mockResolvedValue(Response.json([{ controlId: 'later' }])),
  );
  document.body.innerHTML = '<div class="desktop-chat-center"></div>';
  installSurfaceControlInbox({ key, itemId: 'coord', selector });
  await window.fetch(url, options);
  await window.fetch(url, options);
  await expect(observation().result).rejects.toThrow();
  const replacement = vi.fn();
  window.fetch = replacement;
  observation().restore();
  expect(window.fetch).toBe(replacement);
});
