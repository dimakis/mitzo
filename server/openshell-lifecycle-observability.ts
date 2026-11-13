import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

type Run = (command: string, args: string[], signal: AbortSignal) => Promise<string>;
type Log = { warn(data: object, message: string): void; info(data: object, message: string): void };
interface TelemetryCause {
  name: string;
  code?: string;
  exitCode?: number;
  signal?: string;
}
export interface LifecycleTelemetryDiagnostic {
  operation: 'podman_system_df';
  collectionId: string;
  stage: 'command' | 'parse' | 'validate';
  code:
    | 'command_failed'
    | 'command_timeout'
    | 'cancelled'
    | 'invalid_json'
    | 'invalid_shape'
    | 'invalid_bytes';
  cause?: TelemetryCause;
  nextAction: string;
}
export interface LifecycleMetrics {
  available: boolean;
  usageBytes?: number;
  reclaimableBytes?: number;
  phaseCounts?: Record<string, number>;
  diagnostic?: LifecycleTelemetryDiagnostic;
}
export interface LifecycleObservabilityThresholds {
  usageThresholdBytes?: number;
  sandboxThreshold?: number;
}

function positiveThreshold(value: string | undefined, name: string) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`Invalid OpenShell lifecycle ${name} threshold`);
  return parsed;
}

/** Optional alert thresholds. Empty values leave alerts disabled. */
export function openShellLifecycleObservabilityThresholds(
  env: NodeJS.ProcessEnv,
): LifecycleObservabilityThresholds {
  return {
    usageThresholdBytes: positiveThreshold(
      env.MITZO_OPENSHELL_USAGE_THRESHOLD_BYTES,
      'usage bytes',
    ),
    sandboxThreshold: positiveThreshold(env.MITZO_OPENSHELL_SANDBOX_THRESHOLD, 'sandbox count'),
  };
}
function bytes(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const match = String(value).match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i);
  if (!match) return undefined;
  const parsed =
    Number(match[1]) *
    ({ '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2].toUpperCase()] ?? 1);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Retain only bounded cause metadata, never exception text, output or nested payloads. */
function sanitizedCause(error: unknown): TelemetryCause {
  const source =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const name =
    typeof source.name === 'string' &&
    ['Error', 'AbortError', 'SyntaxError', 'TypeError', 'RangeError'].includes(source.name)
      ? source.name
      : 'Error';
  const code =
    typeof source.code === 'string' &&
    [
      'ENOENT',
      'EACCES',
      'EPERM',
      'ENOSPC',
      'ENOBUFS',
      'E2BIG',
      'ETIMEDOUT',
      'ABORT_ERR',
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    ].includes(source.code)
      ? source.code
      : undefined;
  const exitCode =
    typeof source.code === 'number' &&
    Number.isSafeInteger(source.code) &&
    source.code >= 0 &&
    source.code <= 255
      ? source.code
      : undefined;
  const signal =
    typeof source.signal === 'string' &&
    ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGPIPE'].includes(
      source.signal,
    )
      ? source.signal
      : undefined;
  return {
    name,
    ...(code ? { code } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal ? { signal } : {}),
  };
}
function command(command: string, args: string[], signal: AbortSignal) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      command,
      args,
      { signal, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}
/** Read-only lifecycle telemetry. Podman `system df` reports usage, never free disk capacity. */
export class OpenShellLifecycleObservability {
  private alerted = false;
  private available?: boolean;
  private failureSignature?: string;
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
    const collectionId = randomUUID();
    let stage: LifecycleTelemetryDiagnostic['stage'] = 'command';
    let code: LifecycleTelemetryDiagnostic['code'] = 'command_failed';
    const unavailable = (
      failureCode: LifecycleTelemetryDiagnostic['code'],
      cause?: unknown,
    ): LifecycleMetrics => ({
      available: false,
      diagnostic: {
        operation: 'podman_system_df',
        collectionId,
        stage,
        code: failureCode,
        ...(cause !== undefined ? { cause: sanitizedCause(cause) } : {}),
        nextAction:
          failureCode === 'cancelled'
            ? 'Collection cancelled; retry on the next scheduled reconciliation.'
            : stage === 'command'
              ? 'Check Podman availability and access; retry read-only telemetry.'
              : 'Check Podman system df JSON/raw-byte compatibility; usage remains unknown.',
      },
    });
    // Shutdown cancellation is expected: do not launch, change availability or warn.
    if (signal.aborted) return unavailable('cancelled');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 10_000);
    try {
      const output = await (this.options.run ?? command)(
        'podman',
        ['system', 'df', '--format', 'json'],
        AbortSignal.any([signal, deadline.signal]),
      );
      if (signal.aborted) return unavailable('cancelled');
      if (deadline.signal.aborted) return unavailable('command_timeout');
      stage = 'parse';
      code = 'invalid_json';
      const rows: unknown = JSON.parse(output);
      stage = 'validate';
      code = 'invalid_shape';
      if (
        !Array.isArray(rows) ||
        !rows.length ||
        rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
      )
        throw new Error('Podman usage response must contain usage rows');
      code = 'invalid_bytes';
      const parsed = rows.map((row) => ({
        usage: bytes(row.RawSize),
        reclaimable: bytes(row.RawReclaimable),
      }));
      if (parsed.some((row) => row.usage === undefined || row.reclaimable === undefined))
        throw new Error('Podman usage response is missing raw byte fields');
      const usageBytes = parsed.reduce((sum, row) => sum + row.usage!, 0);
      const reclaimableBytes = parsed.reduce((sum, row) => sum + row.reclaimable!, 0);
      if (!Number.isSafeInteger(usageBytes) || !Number.isSafeInteger(reclaimableBytes))
        throw new Error('Podman usage totals exceed safe byte accounting');
      return { available: true, usageBytes, reclaimableBytes };
    } catch (error) {
      return unavailable(
        signal.aborted ? 'cancelled' : deadline.signal.aborted ? 'command_timeout' : code,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  observe(metrics: LifecycleMetrics) {
    if (!metrics.available) {
      if (metrics.diagnostic?.code === 'cancelled') {
        this.recordOutcome('telemetry_cancelled');
        return;
      }
      const signature = JSON.stringify([
        metrics.diagnostic?.stage,
        metrics.diagnostic?.code,
        metrics.diagnostic?.cause,
      ]);
      if (this.available !== false || this.failureSignature !== signature)
        this.options.log.warn(
          metrics.diagnostic ? { diagnostic: metrics.diagnostic } : {},
          'OpenShell usage telemetry unavailable',
        );
      this.failureSignature = signature;
      this.available = false;
      this.recordOutcome('telemetry_unavailable');
      return;
    }
    if (this.available === false) this.options.log.info({}, 'OpenShell usage telemetry recovered');
    this.available = true;
    this.failureSignature = undefined;
    const sandboxCount = Object.values(metrics.phaseCounts ?? {}).reduce((a, b) => a + b, 0);
    this.options.log.info(
      {
        usageBytes: metrics.usageBytes,
        reclaimableBytes: metrics.reclaimableBytes,
        sandboxCount,
        phaseCounts: metrics.phaseCounts ?? {},
        outcomes: { ...this.outcomes },
      },
      'OpenShell lifecycle telemetry',
    );
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
