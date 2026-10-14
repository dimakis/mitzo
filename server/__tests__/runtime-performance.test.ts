import { afterEach, describe, expect, it, vi } from 'vitest';
const histogram = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
  percentile: vi.fn(() => 180_000_000),
  max: 250_000_000,
  mean: 40_000_000,
}));
vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: vi.fn(() => histogram),
  performance: { eventLoopUtilization: vi.fn(() => ({ utilization: 0.8 })) },
}));
import { startRuntimePerformanceMonitor } from '../runtime-performance.js';
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('runtime responsiveness evidence', () => {
  it('reports event-loop stalls without request or provider data and stops at shutdown', () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const stop = startRuntimePerformanceMonitor(warn);
    vi.advanceTimersByTime(30000);
    expect(warn).toHaveBeenCalledWith(
      'Server event loop delayed',
      expect.objectContaining({ maxMs: 250, p99Ms: 180, meanMs: 40, utilization: 0.8 }),
    );
    expect(histogram.reset).toHaveBeenCalledOnce();
    stop();
    vi.advanceTimersByTime(60000);
    expect(warn).toHaveBeenCalledOnce();
    expect(histogram.disable).toHaveBeenCalledOnce();
  });
});
