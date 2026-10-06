import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createHostBackupService, readBackupPassword } from '../backup/host.js';
it('keeps absent, partial, overlapping, and unconfirmed host setup disabled', async () => {
  const capture = vi.fn(async () => {});
  for (const env of [
    {},
    { MITZO_BACKUP_ROOT: '/private/backups' },
    { MITZO_BACKUP_ROOT: '/private/backups', MITZO_BACKUP_RECOVERY_CONFIRMED: 'false' },
  ]) {
    expect((await createHostBackupService(capture, env).overview()).ready).toBe(false);
  }
  expect(capture).not.toHaveBeenCalled();
});
it('retrieves only the fixed Keychain credential and never leaks executor failures', async () => {
  const execute = vi.fn(async () => 'example-secret\n');
  expect(await readBackupPassword(execute)).toBe('example-secret');
  expect(execute).toHaveBeenCalledWith('/usr/bin/security', [
    'find-generic-password',
    '-s',
    'mitzo.backup',
    '-a',
    'repository',
    '-w',
  ]);
  await expect(
    readBackupPassword(async () => {
      throw Error('SECRET /private/path');
    }),
  ).rejects.toThrow('Backup credential unavailable');
});

it('rejects backup roots inside iCloud even with otherwise complete configuration', async () => {
  const cloud = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const env = {
    MITZO_BACKUP_ROOT: join(cloud, 'local'),
    MITZO_BACKUP_ICLOUD_DIRECTORY: join(cloud, 'encrypted'),
    MITZO_BACKUP_RESTIC_BINARY: '/usr/local/bin/restic',
    MITZO_BACKUP_UPLOAD_PROBE: '/usr/local/bin/upload-probe',
    MITZO_BACKUP_RECOVERY_CONFIRMED: 'true',
  };
  expect((await createHostBackupService(async () => {}, env).overview()).ready).toBe(false);
});
