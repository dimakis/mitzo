import { lstat, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { BackupSetupOverview } from '@mitzo/protocol';
import { BackupService } from './service.js';
import { durableJson, readSmall, safeDirectory } from './files.js';

export const BackupSetupInput = z
  .object({
    password: z
      .string()
      .min(16)
      .max(4096)
      .refine((value) => !/[\r\n\0]/.test(value)),
    recoveryConfirmed: z.literal(true),
  })
  .strict();
const receipt = z
  .object({ version: z.literal(1), prepared: z.literal(true), recoveryConfirmed: z.boolean() })
  .strict();
export class BackupSetupError extends Error {}
export interface BackupSetupOptions {
  root: string;
  cloud: string;
  supported: boolean;
  prepareTools(): Promise<void>;
  savePassword(password: string): Promise<void>;
  createService(): BackupService;
  legacyService?: BackupService;
}
/** Operator-only setup. Paths and executables come from the host, never a request.
 * The durable receipt contains no secret. Setup never starts a private capture. */
export class BackupSetup {
  private service?: BackupService;
  private busy = false;
  constructor(private readonly options: BackupSetupOptions) {}
  private async read() {
    try {
      await this.privateRoot();
      const path = join(this.options.root, 'setup.json');
      const info = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new BackupSetupError();
      return receipt.parse(JSON.parse(await readSmall(path, 4096)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new BackupSetupError(
        'Backup setup needs a host check. Existing configuration was preserved.',
      );
    }
  }
  private async privateRoot(create = false) {
    await safeDirectory(this.options.root, create);
    const info = await lstat(this.options.root);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new BackupSetupError('Backup storage must be private.');
  }
  private async current() {
    if (this.options.legacyService && (await this.options.legacyService.overview()).ready)
      return this.options.legacyService;
    if ((await this.read())?.recoveryConfirmed) {
      this.service ??= this.options.createService();
      return this.service;
    }
    return new BackupService(undefined, ['Complete backup setup in Mitzo.']);
  }
  async status(): Promise<BackupSetupOverview> {
    const saved = await this.read();
    const configured = (await this.current().then((service) => service.overview())).ready;
    return {
      supported: this.options.supported,
      prepared: !!saved || configured,
      configured,
      busy: this.busy || (await this.setupLocked()),
      localFolder: this.options.root,
      cloudFolder: this.options.cloud,
    };
  }
  private async setupLocked() {
    try {
      await lstat(join(this.options.root, 'setup.lock'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  async overview() {
    const view = await (await this.current()).overview();
    return { ...view, busy: view.busy || (await this.setupLocked()) };
  }
  async start() {
    if (await this.setupLocked()) throw new BackupSetupError('Backup setup is busy.');
    return (await this.current()).start();
  }
  async refresh() {
    if (await this.setupLocked()) throw new BackupSetupError('Backup setup is busy.');
    return (await this.current()).refresh();
  }
  private async mutate(work: () => Promise<void>) {
    if (!this.options.supported)
      throw new BackupSetupError('Backup setup requires the Mac running Mitzo.');
    if (this.busy) throw new BackupSetupError('Backup setup is already running.');
    this.busy = true;
    let owned = false;
    const lock = join(this.options.root, 'setup.lock');
    try {
      await this.privateRoot(true);
      await mkdir(lock, { mode: 0o700 });
      owned = true;
      for (const name of ['writer.lock', 'admission.lock']) {
        try {
          await lstat(join(this.options.root, name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        throw new BackupSetupError(
          'Backup storage has a retained writer lock. A host check is required.',
        );
      }
      await work();
    } finally {
      try {
        if (owned) await rmdir(lock);
      } finally {
        this.busy = false;
      }
    }
  }
  async prepare() {
    await this.mutate(async () => {
      if ((await this.status()).configured) return;
      await this.options.prepareTools();
      await durableJson(join(this.options.root, 'setup.json'), {
        version: 1,
        prepared: true,
        recoveryConfirmed: false,
      });
    });
  }
  async configure(input: { password: string; recoveryConfirmed: boolean }) {
    const parsed = BackupSetupInput.safeParse(input);
    if (!parsed.success)
      throw new BackupSetupError(
        'Use a password of at least 16 characters and confirm its recovery copy.',
      );
    await this.mutate(async () => {
      const saved = await this.read();
      if (!saved || (await this.status()).configured)
        throw new BackupSetupError(
          'Prepare storage first. A configured backup password cannot be replaced here.',
        );
      try {
        await this.options.savePassword(parsed.data.password);
      } catch {
        throw new BackupSetupError(
          'Backup password could not be saved. Unlock Keychain on the Mac and retry.',
        );
      }
      await durableJson(join(this.options.root, 'setup.json'), {
        version: 1,
        prepared: true,
        recoveryConfirmed: true,
      });
    });
  }
}
