import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/** Observe process-wide starvation separately from provider/request latency. */
export function startRuntimePerformanceMonitor(
  warn: (message: string, fields: Record<string, unknown>) => void,
): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let previous = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const current = performance.eventLoopUtilization();
    const interval = performance.eventLoopUtilization(current, previous);
    previous = current;
    if (histogram.max >= 100_000_000) {
      const memory = process.memoryUsage();
      warn('Server event loop delayed', {
        maxMs: Math.round(histogram.max / 1e6),
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        meanMs: Math.round(histogram.mean / 1e6),
        utilization: Math.round(interval.utilization * 1000) / 1000,
        rssMiB: Math.round(memory.rss / 1024 / 1024),
        heapUsedMiB: Math.round(memory.heapUsed / 1024 / 1024),
      });
    }
    histogram.reset();
  }, 30_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
