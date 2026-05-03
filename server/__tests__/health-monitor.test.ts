import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthMonitor } from '../health-monitor';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock SseRegistry
function createMockRegistry() {
  return {
    broadcast: vi.fn(),
    sendTo: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    size: 0,
    destroy: vi.fn(),
  };
}

function yapperOk(stt = true, tts = true) {
  return {
    ok: true,
    json: () => Promise.resolve({ status: 'ready', models: { stt, tts } }),
  };
}

function contexginOk() {
  return { ok: true, json: () => Promise.resolve({ status: 'healthy' }) };
}

function serviceDown() {
  return { ok: false, json: () => Promise.resolve({}) };
}

describe('HealthMonitor', () => {
  let registry: ReturnType<typeof createMockRegistry>;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = createMockRegistry();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts health on first check', async () => {
    mockFetch.mockResolvedValueOnce(yapperOk()).mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();

    // Flush the initial async check
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.broadcast).toHaveBeenCalledWith(
      'health',
      expect.objectContaining({
        services: expect.arrayContaining([
          expect.objectContaining({ name: 'yapper', ok: true }),
          expect.objectContaining({ name: 'contexgin', ok: true }),
        ]),
        checkedAt: expect.any(Number),
      }),
    );

    monitor.destroy();
  });

  it('does not broadcast when status is unchanged', async () => {
    mockFetch
      .mockResolvedValueOnce(yapperOk())
      .mockResolvedValueOnce(contexginOk())
      .mockResolvedValueOnce(yapperOk())
      .mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(registry.broadcast).toHaveBeenCalledTimes(1);

    // Advance to next poll
    await vi.advanceTimersByTimeAsync(30_000);
    // No second broadcast — status unchanged
    expect(registry.broadcast).toHaveBeenCalledTimes(1);

    monitor.destroy();
  });

  it('broadcasts when status changes', async () => {
    // First check: both ok
    mockFetch.mockResolvedValueOnce(yapperOk()).mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.broadcast).toHaveBeenCalledTimes(1);

    // Second check: yapper down
    mockFetch.mockResolvedValueOnce(serviceDown()).mockResolvedValueOnce(contexginOk());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(registry.broadcast).toHaveBeenCalledTimes(2);

    const lastCall = registry.broadcast.mock.calls[1];
    expect(lastCall[1].services[0]).toEqual(expect.objectContaining({ name: 'yapper', ok: false }));

    monitor.destroy();
  });

  it('parses Yapper detail with stt/tts fields', async () => {
    mockFetch.mockResolvedValueOnce(yapperOk(true, false)).mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    const payload = registry.broadcast.mock.calls[0][1];
    const yapper = payload.services.find((s: any) => s.name === 'yapper');
    expect(yapper.detail).toEqual({ stt: true, tts: false });

    monitor.destroy();
  });

  it('returns undefined detail when Yapper omits models', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      })
      .mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    const payload = registry.broadcast.mock.calls[0][1];
    const yapper = payload.services.find((s: any) => s.name === 'yapper');
    expect(yapper.detail).toBeUndefined();

    monitor.destroy();
  });

  it('marks service as down on fetch error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    const payload = registry.broadcast.mock.calls[0][1];
    const yapper = payload.services.find((s: any) => s.name === 'yapper');
    expect(yapper.ok).toBe(false);

    monitor.destroy();
  });

  it('getSnapshot returns last payload', async () => {
    mockFetch.mockResolvedValueOnce(yapperOk()).mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    // Before start — empty snapshot
    expect(monitor.getSnapshot()).toEqual({ services: [], checkedAt: 0 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = monitor.getSnapshot();
    expect(snapshot.services).toHaveLength(2);
    expect(snapshot.checkedAt).toBeGreaterThan(0);

    monitor.destroy();
  });

  it('broadcasts on detail change even if ok is same', async () => {
    // First: stt=true, tts=true
    mockFetch.mockResolvedValueOnce(yapperOk(true, true)).mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.broadcast).toHaveBeenCalledTimes(1);

    // Second: stt=true, tts=false — ok is still true but detail changed
    mockFetch.mockResolvedValueOnce(yapperOk(true, false)).mockResolvedValueOnce(contexginOk());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(registry.broadcast).toHaveBeenCalledTimes(2);

    monitor.destroy();
  });

  it('marks service as down on fetch timeout', async () => {
    // Simulate AbortSignal.timeout rejecting with TimeoutError
    const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
    mockFetch.mockRejectedValueOnce(timeoutErr).mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    const payload = registry.broadcast.mock.calls[0]?.[1];
    const yapper = payload?.services.find((s: any) => s.name === 'yapper');
    expect(yapper?.ok).toBe(false);

    monitor.destroy();
  });

  it('start() is idempotent — calling twice does not create duplicate intervals', async () => {
    mockFetch.mockResolvedValue(yapperOk()).mockResolvedValue(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();
    monitor.start(); // second call should be a no-op

    await vi.advanceTimersByTimeAsync(0);

    // Only one initial check, not two
    // Each check fetches 2 services, so 2 fetch calls = 1 check
    expect(mockFetch).toHaveBeenCalledTimes(2);

    monitor.destroy();
  });

  it('destroy clears the timer', async () => {
    mockFetch.mockResolvedValueOnce(yapperOk()).mockResolvedValueOnce(contexginOk());

    const monitor = new HealthMonitor(registry as any);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    monitor.destroy();

    // Advance time — no further checks
    mockFetch.mockReset();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
