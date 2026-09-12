import { execFile } from 'node:child_process';

type Run = (command: string, args: string[], signal: AbortSignal) => Promise<string>;
type Log = { warn(data: object, message: string): void; info(data: object, message: string): void };
export interface LifecycleMetrics {
  available: boolean;
  usageBytes?: number;
  reclaimableBytes?: number;
  phaseCounts?: Record<string, number>;
}
function bytes(value: unknown) {
  const match = String(value).match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i);
  if (!match) return undefined;
  return (
    Number(match[1]) *
    ({ '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2].toUpperCase()] ?? 1)
  );
}
function command(command: string, args: string[], signal: AbortSignal) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      command,
      args,
      { signal, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}
/** Read-only lifecycle telemetry. Podman `system df` reports usage, never free disk capacity. */
export class OpenShellLifecycleObservability {
  private alerted = false;
  readonly outcomes: Record<string, number> = {};
  constructor(
    private options: {
      run?: Run;
      log: Log;
      usageThresholdBytes?: number;
      sandboxThreshold?: number;
    },
  ) {}
  async collect(signal: AbortSignal): Promise<LifecycleMetrics> {
    try {
      const output = await (this.options.run ?? command)(
        'podman',
        ['system', 'df', '--format', 'json'],
        signal,
      );
      const rows = JSON.parse(output) as Array<Record<string, unknown>>;
      if (!Array.isArray(rows)) throw new Error('Podman usage response is not an array');
      const parsed = rows.map((row) => ({
        usage: bytes(row.RawSize),
        reclaimable: bytes(row.RawReclaimable),
      }));
      if (parsed.some((row) => row.usage === undefined || row.reclaimable === undefined))
        throw new Error('Podman usage response is missing raw byte fields');
      const usageBytes = parsed.reduce((sum, row) => sum + row.usage!, 0);
      const reclaimableBytes = parsed.reduce((sum, row) => sum + row.reclaimable!, 0);
      return { available: true, usageBytes, reclaimableBytes };
    } catch {
      return { available: false };
    }
  }
  observe(metrics: LifecycleMetrics) {
    if (!metrics.available) {
      this.options.log.warn({}, 'OpenShell usage telemetry unavailable');
      return;
    }
    const sandboxCount = Object.values(metrics.phaseCounts ?? {}).reduce((a, b) => a + b, 0);
    const exceeded =
      (this.options.usageThresholdBytes !== undefined &&
        (metrics.usageBytes ?? 0) >= this.options.usageThresholdBytes) ||
      (this.options.sandboxThreshold !== undefined &&
        sandboxCount >= this.options.sandboxThreshold);
    if (exceeded && !this.alerted) {
      this.alerted = true;
      this.options.log.warn(
        { usageBytes: metrics.usageBytes, sandboxCount },
        'OpenShell usage threshold exceeded',
      );
    }
    if (!exceeded && this.alerted) {
      this.alerted = false;
      this.options.log.info(
        { usageBytes: metrics.usageBytes, sandboxCount },
        'OpenShell usage threshold recovered',
      );
    }
  }
  recordOutcome(outcome: string) {
    this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
  }
}
