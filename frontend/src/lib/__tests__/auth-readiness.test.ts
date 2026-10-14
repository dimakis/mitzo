// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const init = vi.hoisted(() => ({ ready: undefined as Promise<void> | undefined }));
const span = vi.hoisted(() => ({ end: vi.fn(), setAttribute: vi.fn(), setStatus: vi.fn() }));
vi.mock('../tracing', () => ({
  tracer: { startSpan: () => span },
  injectTraceparent: () => ({
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  }),
  get tracingReady() {
    return init.ready;
  },
}));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue(new Response('{}'));
  localStorage.clear();
  localStorage.setItem('mitzo_auth_token', 'current-token');
});
afterEach(() => {
  init.ready = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('authentication independent of tracing readiness', () => {
  it('sends and completes the check even when tracing initialization hangs', async () => {
    init.ready = new Promise(() => {});
    const { restoreCookieAuthentication } = await import('../api-fetch');
    const result = restoreCookieAuthentication();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await result).toBe(true);
    expect(localStorage.getItem('mitzo_auth_token')).toBe('current-token');
  });
  it('rejects an obsolete response when credentials change during the request', async () => {
    init.ready = new Promise(() => {});
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    const { restoreCookieAuthentication, loginSucceeded } = await import('../api-fetch');
    const old = restoreCookieAuthentication();
    expect(fetchMock).toHaveBeenCalledOnce();
    loginSucceeded('new-token');
    finish(new Response('{}'));
    expect(await old).toBe(false);
    expect(await restoreCookieAuthentication()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
