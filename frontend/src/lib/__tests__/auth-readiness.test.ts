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
describe('bounded authentication tracing readiness', () => {
  it('keeps the five-second deadline when tracing initialization hangs and never sends a late check', async () => {
    let initialize!: () => void;
    init.ready = new Promise<void>((resolve) => {
      initialize = resolve;
    });
    const { restoreCookieAuthentication } = await import('../api-fetch');
    const result = restoreCookieAuthentication().catch((error: Error) => error);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result) as Error).toHaveProperty('message', 'Authentication check timed out');
    expect(localStorage.getItem('mitzo_auth_token')).toBe('current-token');
    initialize();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await restoreCookieAuthentication()).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('does not send an obsolete check after credentials change during initialization', async () => {
    let initialize!: () => void;
    init.ready = new Promise<void>((resolve) => {
      initialize = resolve;
    });
    const { restoreCookieAuthentication, loginSucceeded } = await import('../api-fetch');
    const old = restoreCookieAuthentication();
    loginSucceeded('new-token');
    initialize();
    expect(await old).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await restoreCookieAuthentication()).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
