import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

export interface OpenShellCapacitySnapshot {
  collectedAt: number;
  podman: { available: boolean; usageBytes?: number; reclaimableBytes?: number; error?: string };
  filesystem: { available: boolean; freeBytes?: number; totalBytes?: number; error?: string };
}

export interface OpenShellCapacityPolicy {
  warningFreePercent: number;
  hardFreePercent: number;
  recoverFreePercent: number;
}

export class OpenShellCapacityError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'OpenShellCapacityError';
  }
}

function percentage(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 100)
    throw new Error(`${key} must be a percentage from 1 to 99`);
  return value;
}

export function openShellCapacityPolicy(env: NodeJS.ProcessEnv): OpenShellCapacityPolicy {
  const warningFreePercent = percentage(env, 'MITZO_OPENSHELL_CAPACITY_WARNING_FREE_PERCENT', 20);
  const hardFreePercent = percentage(env, 'MITZO_OPENSHELL_CAPACITY_HARD_FREE_PERCENT', 10);
  const recoverFreePercent = percentage(env, 'MITZO_OPENSHELL_CAPACITY_RECOVER_FREE_PERCENT', 15);
  if (
    hardFreePercent >= warningFreePercent ||
    recoverFreePercent <= hardFreePercent ||
    recoverFreePercent >= warningFreePercent
  )
    throw new Error('OpenShell capacity thresholds must be warning > recovery > hard');
  return { warningFreePercent, hardFreePercent, recoverFreePercent };
}

export function openShellCapacityEnabled(
  env: NodeJS.ProcessEnv,
  validatePath: (path: string) => void = (path) => accessSync(path, constants.R_OK),
) {
  const raw = env.MITZO_OPENSHELL_CAPACITY_ENABLED;
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw !== '1') throw new Error('MITZO_OPENSHELL_CAPACITY_ENABLED must be 0 or 1');
  if (!env.MITZO_OPENSHELL_CAPACITY_PATH?.trim())
    throw new Error(
      'MITZO_OPENSHELL_CAPACITY_PATH is required when OpenShell capacity admission is enabled',
    );
  try {
    validatePath(env.MITZO_OPENSHELL_CAPACITY_PATH.trim());
  } catch {
    throw new Error('MITZO_OPENSHELL_CAPACITY_PATH must be a readable host-visible path');
  }
  return true;
}

function scrub(value: unknown) {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(?:\/[^\s:]+)+/g, '<path>')
    .replace(/https?:\/\/[^\s]+/g, '<endpoint>')
    .slice(0, 180);
}

function bytes(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value).match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)(?:i?B)?$/i);
  if (!match) return undefined;
  return (
    Number(match[1]) *
    ({ '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2].toUpperCase()] ?? 1)
  );
}

const run = (binary: string, args: string[], signal: AbortSignal) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      binary,
      args,
      { signal, timeout: 15_000, maxBuffer: 128 * 1024, encoding: 'utf8' },
      (error, out) => (error ? reject(error) : resolve(out)),
    ),
  );

/** Metrics deliberately distinguish Podman's reclaimable estimate from the host/VM free space. */
export class OpenShellCapacityCollector {
  constructor(
    // Podman's storage can live in a VM or a separate volume. Host root is
    // therefore never a safe implicit proxy for the storage being protected.
    private readonly path = process.env.MITZO_OPENSHELL_CAPACITY_PATH,
    private readonly commands: {
      podman?: (signal: AbortSignal) => Promise<string>;
      filesystem?: (signal: AbortSignal) => Promise<string>;
    } = {},
  ) {}
  async collect(signal: AbortSignal): Promise<OpenShellCapacitySnapshot> {
    const snapshot: OpenShellCapacitySnapshot = {
      collectedAt: Date.now(),
      podman: { available: false },
      filesystem: { available: false },
    };
    const [podman, filesystem] = await Promise.allSettled([
      (this.commands.podman ?? ((s) => run('podman', ['system', 'df', '--format', 'json'], s)))(
        signal,
      ),
      this.commands.filesystem
        ? this.commands.filesystem(signal)
        : this.path
          ? run('df', ['-Pk', this.path], signal)
          : Promise.reject(new Error('authoritative OpenShell capacity path is not configured')),
    ]);
    if (podman.status === 'fulfilled') {
      try {
        const rows = JSON.parse(podman.value) as unknown;
        if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === 'object'))
          throw new Error('Podman capacity output was invalid');
        const metrics = rows.map((row) => {
          const values = row as Record<string, unknown>;
          return {
            usage:
              bytes(values.RawSize) ??
              bytes(values.rawSize) ??
              bytes(values.Size) ??
              bytes(values.size),
            reclaimable:
              bytes(values.RawReclaimable) ??
              bytes(values.rawReclaimable) ??
              bytes(values.Reclaimable) ??
              bytes(values.reclaimable),
          };
        });
        if (metrics.some((row) => row.usage === undefined || row.reclaimable === undefined))
          throw new Error('Podman capacity metrics were incomplete');
        const usageBytes = metrics.reduce((sum, row) => sum + row.usage!, 0);
        const reclaimableBytes = metrics.reduce((sum, row) => sum + row.reclaimable!, 0);
        snapshot.podman = { available: true, usageBytes, reclaimableBytes };
      } catch (error) {
        snapshot.podman = { available: false, error: scrub(error) };
      }
    } else snapshot.podman = { available: false, error: scrub(podman.reason) };
    if (filesystem.status === 'fulfilled') {
      const line = filesystem.value.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/) ?? [];
      const total = Number(line[1]);
      const free = Number(line[3]);
      if (Number.isFinite(total) && Number.isFinite(free) && total > 0 && free >= 0)
        snapshot.filesystem = { available: true, totalBytes: total * 1024, freeBytes: free * 1024 };
      else
        snapshot.filesystem = { available: false, error: 'filesystem capacity output was invalid' };
    } else snapshot.filesystem = { available: false, error: scrub(filesystem.reason) };
    return snapshot;
  }
}

/** Serialized, fail-closed admission is only used for new physical sandboxes. */
export class OpenShellCapacityAdmission {
  // A restart loses the previous latch state. Treat that ambiguity as a hard
  // stop until a sample reaches the recovery threshold.
  private hard = true;
  private tail = Promise.resolve();
  constructor(
    private readonly collector: OpenShellCapacityCollector,
    private readonly policy: OpenShellCapacityPolicy,
  ) {}
  private async snapshot(signal: AbortSignal, updateHardStop: boolean) {
    const capacity = await this.collector.collect(signal);
    const freePercent =
      capacity.filesystem.available &&
      capacity.filesystem.freeBytes !== undefined &&
      capacity.filesystem.totalBytes
        ? (capacity.filesystem.freeBytes / capacity.filesystem.totalBytes) * 100
        : undefined;
    if (updateHardStop) {
      if (freePercent === undefined) this.hard = true;
      else if (this.hard && freePercent >= this.policy.recoverFreePercent) this.hard = false;
      else if (!this.hard && freePercent < this.policy.hardFreePercent) this.hard = true;
    }
    const state =
      freePercent === undefined
        ? 'unavailable'
        : this.hard || freePercent < this.policy.hardFreePercent
          ? 'hard_stop'
          : freePercent < this.policy.warningFreePercent
            ? 'warning'
            : 'normal';
    return {
      ...capacity,
      freePercent,
      state,
      policy: this.policy,
    } as const;
  }
  /** Read-only status collection must not clear or trip the create latch. */
  async status(signal: AbortSignal) {
    return this.snapshot(signal, false);
  }
  /** Acquire the global create reservation. The caller must retain it until
   * the physical `sandbox create` invocation has returned. */
  async reserveNewSandbox(signal: AbortSignal): Promise<() => void> {
    let release!: () => void;
    let granted = false;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const status = await this.snapshot(signal, true);
      if (status.state === 'unavailable')
        throw new OpenShellCapacityError(
          'OpenShell capacity is unavailable; retry after capacity collection recovers',
        );
      if (status.state === 'hard_stop')
        throw new OpenShellCapacityError(
          'OpenShell capacity hard stop is active; retry after free capacity recovers',
        );
      granted = true;
      return release;
    } finally {
      // A rejected admission must never hold up a later caller. A successful
      // caller owns this release until it has issued the physical create.
      if (!granted) release();
    }
  }
  async admitNewSandbox(signal: AbortSignal) {
    const release = await this.reserveNewSandbox(signal);
    release();
  }
}

let admission: OpenShellCapacityAdmission | undefined;
export function configureOpenShellCapacityAdmission(value: OpenShellCapacityAdmission | undefined) {
  admission = value;
}
export function admitOpenShellSandboxCreate(signal: AbortSignal) {
  return admission?.admitNewSandbox(signal) ?? Promise.resolve();
}
export function reserveOpenShellSandboxCreate(signal: AbortSignal) {
  return admission?.reserveNewSandbox(signal) ?? Promise.resolve(undefined);
}
export function openShellCapacityStatus(signal: AbortSignal) {
  return admission?.status(signal);
}
