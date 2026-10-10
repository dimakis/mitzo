import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupSetup, BackupSetupError } from './setup.js';
import { backupKeychainService, BackupKeychain } from './setup-keychain.js';
import { readBackupToolPaths, prepareBackupTools } from './setup-tools.js';
import { createHostBackupService } from './host.js';
import { safeDirectory } from './files.js';

export function createHostBackupSetup(
  capture: (path: string) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const root = env.MITZO_BACKUP_ROOT || join(homedir(), '.mitzo', 'backups');
  const cloudRoot = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const cloud = env.MITZO_BACKUP_ICLOUD_DIRECTORY || join(cloudRoot, 'Mitzo Backups');
  const directory = join(
    homedir(),
    '.mitzo',
    'backup-tools',
    backupKeychainService(root).slice(-16),
  );
  const password = new BackupKeychain(root);
  const toolPaths = async () => {
    const managed = await readBackupToolPaths(directory);
    return {
      restic: env.MITZO_BACKUP_RESTIC_BINARY || managed.restic,
      probe: env.MITZO_BACKUP_UPLOAD_PROBE || managed.probe,
    };
  };
  const createService = async () => {
    const paths = await toolPaths();
    const settings = {
      ...env,
      MITZO_BACKUP_ROOT: root,
      MITZO_BACKUP_ICLOUD_DIRECTORY: cloud,
      MITZO_BACKUP_RESTIC_BINARY: paths.restic,
      MITZO_BACKUP_UPLOAD_PROBE: paths.probe,
      MITZO_BACKUP_RECOVERY_CONFIRMED: 'true',
    };
    return createHostBackupService(capture, settings, () => password.read());
  };
  return new BackupSetup({
    root,
    cloud,
    supported: process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch),
    legacyService: createHostBackupService(capture, env),
    createService,
    savePassword: (value) => password.save(value),
    prepareTools: async (configured) => {
      if (!(await (await createService()).overview()).ready)
        throw new BackupSetupError('The Mac’s backup storage configuration needs a host check.');
      try {
        await safeDirectory(cloudRoot);
      } catch {
        throw new BackupSetupError('Turn on iCloud Drive on the Mac running Mitzo, then retry.');
      }
      // An unregistered existing repository may need its original recovery key.
      // Never create a new credential for it or silently adopt it through this flow.
      const existing = await lstat(join(root, 'repository')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (existing && !configured)
        throw new BackupSetupError(
          'An existing backup repository needs a recovery check before it can be connected. Its password and data were preserved.',
        );
      if (!env.MITZO_BACKUP_RESTIC_BINARY || !env.MITZO_BACKUP_UPLOAD_PROBE)
        await prepareBackupTools({
          directory,
          source: fileURLToPath(
            new URL('../../scripts/backup/icloud-upload-status.swift', import.meta.url),
          ),
        });
      for (const path of Object.values(await toolPaths())) {
        const info = await lstat(path);
        if (!info.isFile()) throw new BackupSetupError('A configured backup tool is unavailable.');
        await access(path, constants.X_OK);
      }
      await safeDirectory(cloud, true);
    },
  });
}
