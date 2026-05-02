import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SseRegistry } from '../src/sse-registry.js';

function mockResponse() {
  return {
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as import('express').Response;
}

describe('SseRegistry', () => {
  let registry: SseRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SseRegistry();
  });

  afterEach(() => {
    registry.destroy();
    vi.useRealTimers();
  });

  it('starts with size 0', () => {
    expect(registry.size).toBe(0);
  });

  it('tracks added clients', () => {
    registry.add('c1', mockResponse());
    expect(registry.size).toBe(1);

    registry.add('c2', mockResponse());
    expect(registry.size).toBe(2);
  });

  it('removes clients', () => {
    registry.add('c1', mockResponse());
    registry.remove('c1');
    expect(registry.size).toBe(0);
  });

  it('remove is a no-op for unknown id', () => {
    registry.remove('nonexistent');
    expect(registry.size).toBe(0);
  });

  it('broadcasts to all clients', () => {
    const r1 = mockResponse();
    const r2 = mockResponse();
    registry.add('c1', r1);
    registry.add('c2', r2);

    registry.broadcast('test_event', { foo: 'bar' });

    const expected = 'event: test_event\ndata: {"foo":"bar"}\n\n';
    expect(r1.write).toHaveBeenCalledWith(expected);
    expect(r2.write).toHaveBeenCalledWith(expected);
  });

  it('skips broadcast when no clients', () => {
    // Should not throw
    registry.broadcast('test_event', {});
  });

  it('removes dead clients on broadcast failure', () => {
    const r1 = mockResponse();
    const r2 = mockResponse();
    (r1.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('connection reset');
    });

    registry.add('c1', r1);
    registry.add('c2', r2);
    registry.broadcast('test_event', {});

    expect(registry.size).toBe(1);
    expect(r2.write).toHaveBeenCalled();
  });

  it('sendTo delivers to a specific client', () => {
    const r1 = mockResponse();
    const r2 = mockResponse();
    registry.add('c1', r1);
    registry.add('c2', r2);

    const result = registry.sendTo('c1', 'hydrate', [1, 2, 3]);

    expect(result).toBe(true);
    expect(r1.write).toHaveBeenCalledWith('event: hydrate\ndata: [1,2,3]\n\n');
    expect(r2.write).not.toHaveBeenCalled();
  });

  it('sendTo returns false for unknown client', () => {
    expect(registry.sendTo('missing', 'test', {})).toBe(false);
  });

  it('sendTo removes client on write failure', () => {
    const res = mockResponse();
    (res.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('broken');
    });
    registry.add('c1', res);

    const result = registry.sendTo('c1', 'test', {});
    expect(result).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('starts heartbeat on first client', () => {
    const res = mockResponse();
    registry.add('c1', res);

    vi.advanceTimersByTime(30_000);
    expect(res.write).toHaveBeenCalledWith(':heartbeat\n\n');
  });

  it('stops heartbeat when last client disconnects', () => {
    const res = mockResponse();
    registry.add('c1', res);
    registry.remove('c1');

    vi.advanceTimersByTime(30_000);
    // Only the initial add, no heartbeat write
    expect(res.write).not.toHaveBeenCalled();
  });

  it('cleans up dead connections during heartbeat', () => {
    const r1 = mockResponse();
    const r2 = mockResponse();
    (r1.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('dead');
    });

    registry.add('c1', r1);
    registry.add('c2', r2);

    vi.advanceTimersByTime(30_000);

    expect(registry.size).toBe(1);
  });

  it('destroy closes all connections and stops heartbeat', () => {
    const r1 = mockResponse();
    const r2 = mockResponse();
    registry.add('c1', r1);
    registry.add('c2', r2);

    registry.destroy();

    expect(r1.end).toHaveBeenCalled();
    expect(r2.end).toHaveBeenCalled();
    expect(registry.size).toBe(0);

    // Heartbeat should be stopped — no writes after destroy
    vi.advanceTimersByTime(30_000);
    expect(r1.write).not.toHaveBeenCalled();
  });
});
