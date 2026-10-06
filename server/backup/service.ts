import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { BackupOverview, BackupRun } from '@mitzo/protocol';
import type { Generation } from './icloud-transport.js';
import { durableJson, readSmall, safeDirectory, syncDirectory } from './files.js';
export interface BackupDriver {
  capture(destination: string): Promise<void>;
  initialize(): Promise<void>;
  backup(source: string): Promise<string>;
  check(): Promise<void>;
  publish(): Promise<Generation>;
  refresh(generation: string): Promise<Generation>;
}
const failure = 'Backup did not complete. Check host configuration and retry.' as const;
const uploadFailure = 'Upload verification unavailable. Retry verification.' as const;
const running = new Set(['capturing', 'encrypting', 'publishing']);
const runSchema = z
  .object({
    id: z.string().uuid(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    status: z.enum([
      'capturing',
      'encrypting',
      'publishing',
      'pending',
      'uploaded',
      'failed',
      'interrupted',
    ]),
    snapshot: z
      .string()
      .regex(/^[a-f0-9]{8,64}$/)
      .optional(),
    generation: z.string().uuid().optional(),
    bytes: z.number().int().nonnegative().optional(),
    cloudVerifiedAt: z.string().datetime().optional(),
    error: z.enum([failure, uploadFailure]).optional(),
  })
  .strict();
const journalSchema = z
  .object({ version: z.literal(1), runs: z.array(runSchema).max(50) })
  .strict();
const coverage: BackupOverview['coverage'] = [
  {
    name: 'Mitzo and Telos databases',
    supported: true,
    detail: 'Messages, tasks, Telos relationships, session links and stored artifacts.',
  },
  {
    name: 'Workspace files and other local stores',
    supported: false,
    detail: 'Not captured by this backup group yet.',
  },
  {
    name: 'LifeOps vault and recovery key',
    supported: false,
    detail: 'Vault capture and independent key recovery are still required.',
  },
  {
    name: 'OpenShell and Podman',
    supported: false,
    detail: 'A coordinated stopped-runtime capture is still required.',
  },
  {
    name: 'Centaur and ContexGin',
    supported: false,
    detail: 'Owner snapshot integration is still required.',
  },
];
/** One host-owned repository; all writers take the same durable filesystem fence.
 * An abandoned fence is deliberately retained for operator investigation. */
export class BackupService {
  private busy = false;
  private task: Promise<void> = Promise.resolve();
  constructor(
    private readonly options?: { root: string; driver: BackupDriver },
    private readonly setup: string[] = [
      'Configure host backup storage and executables.',
      'Store the backup password in Keychain and confirm independent recovery.',
    ],
  ) {
    if (options && !isAbsolute(options.root)) throw Error('Backup root must be absolute');
  }
  private async runs(): Promise<BackupRun[]> {
    if (!this.options) return [];
    try {
      return journalSchema.parse(JSON.parse(await readSmall(join(this.options.root, 'runs.json'))))
        .runs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw Error('Backup history unavailable', { cause: e });
    }
  }
  private async save(runs: BackupRun[]) {
    await durableJson(
      join(this.options!.root, 'runs.json'),
      journalSchema.parse({ version: 1, runs: runs.slice(0, 50) }),
    );
  }
  private async locked(): Promise<boolean> {
    if (!this.options) return false;
    try {
      await lstat(join(this.options.root, 'writer.lock'));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }
  async overview(): Promise<BackupOverview> {
    const runs = await this.runs();
    const locked = await this.locked();
    return {
      ready: !!this.options,
      busy: this.busy || locked,
      setup: this.options
        ? locked && !this.busy
          ? [
              'A backup writer lock is retained. Have the host operator inspect it before starting another backup.',
            ]
          : []
        : this.setup,
      runs: runs.map((r) =>
        !this.busy && running.has(r.status) ? { ...r, status: 'interrupted' } : r,
      ),
      lastCapture: runs.find((r) => r.snapshot)?.startedAt ?? null,
      lastCloudUpload: runs.find((r) => r.status === 'uploaded')?.cloudVerifiedAt ?? null,
      coverage: coverage.map((c) => ({ ...c })),
    };
  }
  private async acquire() {
    if (!this.options || this.busy) throw Error('Backup unavailable or busy');
    this.busy = true;
    try {
      await safeDirectory(this.options.root, true);
      if (((await lstat(this.options.root)).mode & 0o077) !== 0)
        throw Error('Backup root must be private');
      await mkdir(join(this.options.root, 'writer.lock'), { mode: 0o700 });
      await syncDirectory(this.options.root);
    } catch {
      this.busy = false;
      throw Error('Backup unavailable or busy');
    }
  }
  private async release() {
    await rm(join(this.options!.root, 'writer.lock'), { recursive: true });
    await syncDirectory(this.options!.root);
  }
  async start(): Promise<void> {
    await this.acquire();
    let runs: BackupRun[];
    try {
      runs = await this.runs();
      runs.unshift({ id: randomUUID(), startedAt: new Date().toISOString(), status: 'capturing' });
      await this.save(runs);
    } catch {
      this.busy = false;
      throw Error('Backup history unavailable; writer lock retained');
    }
    this.task = this.capture(runs)
      .catch(() => {
        /* Durable fence stays closed on receipt/cleanup failure. */
      })
      .finally(() => {
        this.busy = false;
      });
  }
  private async capture(runs: BackupRun[]) {
    const { root, driver } = this.options!;
    const run = runs[0];
    const source = join(root, 'captures', run.id);
    let generation: Generation | undefined;
    try {
      await driver.initialize();
      await safeDirectory(join(root, 'captures'), true);
      await driver.capture(source);
      run.status = 'encrypting';
      await this.save(runs);
      const snapshot = await driver.backup(source);
      await driver.check();
      run.snapshot = snapshot;
      run.status = 'publishing';
      await this.save(runs);
      generation = await driver.publish();
    } catch {
      run.status = 'failed';
      run.error = failure;
    }
    // Remove plaintext before recording completion and releasing the repository fence.
    await rm(source, { recursive: true, force: true });
    run.completedAt = new Date().toISOString();
    if (generation) {
      run.generation = generation.id;
      run.bytes = generation.bytes;
      run.status = generation.status;
      if (generation.status === 'uploaded') run.cloudVerifiedAt = new Date().toISOString();
    }
    await this.save(runs);
    await this.release();
  }
  async refresh(): Promise<void> {
    await this.acquire();
    let runs: BackupRun[];
    try {
      runs = await this.runs();
      if (!runs.some((r) => r.generation && r.status === 'pending')) {
        await this.release();
        this.busy = false;
        return;
      }
    } catch {
      this.busy = false;
      throw Error('Backup history unavailable; writer lock retained');
    }
    this.task = (async () => {
      for (const run of runs) {
        if (!run.generation || run.status !== 'pending') continue;
        try {
          const generation = await this.options!.driver.refresh(run.generation);
          run.status = generation.status;
          run.bytes = generation.bytes;
          delete run.error;
          if (generation.status === 'uploaded') run.cloudVerifiedAt = new Date().toISOString();
        } catch {
          run.error = uploadFailure;
        }
      }
      await this.save(runs);
      await this.release();
    })()
      .catch(() => {})
      .finally(() => {
        this.busy = false;
      });
  }
  /** Host shutdown/test hook; HTTP actions return as soon as admission is durable. */
  async idle() {
    await this.task;
  }
}
