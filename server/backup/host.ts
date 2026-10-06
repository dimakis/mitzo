import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { BackupService } from './service.js';
import { contained } from './files.js';
import { ResticRepository } from './restic.js';
import { ICloudBackupTransport } from './icloud-transport.js';
import { createICloudUploadProbe } from './icloud-upload-probe.js';
type Executor = (binary: string, args: string[]) => Promise<string>;
const execute: Executor = (binary, args) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { encoding: 'utf8', timeout: 10000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } },
      (error, stdout) => {
        if (error) reject(Error('Backup credential unavailable'));
        else resolve(stdout);
      },
    );
  });
export async function readBackupPassword(run: Executor = execute): Promise<string> {
  try {
    const result = await run('/usr/bin/security', [
      'find-generic-password',
      '-s',
      'mitzo.backup',
      '-a',
      'repository',
      '-w',
    ]);
    const secret = result.replace(/\r?\n$/, '');
    if (!secret || secret.includes('\n') || secret.includes('\0') || secret.length > 4096)
      throw Error();
    return secret;
  } catch {
    throw Error('Backup credential unavailable');
  }
}
/** Environment is host authority. Reading configuration never opens stores, reads
 * Keychain, captures private data, creates directories or starts a timer. */
export function createHostBackupService(
  capture: (path: string) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): BackupService {
  const keys = [
    'MITZO_BACKUP_ROOT',
    'MITZO_BACKUP_ICLOUD_DIRECTORY',
    'MITZO_BACKUP_RESTIC_BINARY',
    'MITZO_BACKUP_UPLOAD_PROBE',
  ] as const;
  const setup: string[] = [];
  if (!keys.every((key) => env[key] && isAbsolute(env[key]!)))
    setup.push(
      'Configure absolute host paths for backup storage, iCloud, Restic and the upload helper.',
    );
  if (env.MITZO_BACKUP_RECOVERY_CONFIRMED !== 'true')
    setup.push('Store the password in Keychain and confirm an independent recovery copy.');
  if (process.platform !== 'darwin') setup.push('The iCloud upload helper requires a macOS host.');
  if (setup.length) return new BackupService(undefined, setup);
  const root = resolve(env.MITZO_BACKUP_ROOT!);
  const cloud = resolve(env.MITZO_BACKUP_ICLOUD_DIRECTORY!);
  const cloudRoot = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (
    !contained(cloudRoot, cloud) ||
    cloud === cloudRoot ||
    contained(root, cloud) ||
    contained(cloud, root) ||
    contained(cloudRoot, root)
  )
    return new BackupService(undefined, [
      'Use a dedicated iCloud backup folder and separate private local storage.',
    ]);
  if (keys.slice(2).some((key) => contained(root, env[key]!) || contained(cloudRoot, env[key]!)))
    return new BackupService(undefined, [
      'Install trusted backup executables outside backup storage and iCloud.',
    ]);
  const repository = join(root, 'repository');
  const restic = new ResticRepository({
    binary: env.MITZO_BACKUP_RESTIC_BINARY!,
    repository,
    scratch: join(root, 'temporary'),
    password: readBackupPassword,
    recoveryConfirmed: true,
  });
  const transport = new ICloudBackupTransport(
    cloud,
    createICloudUploadProbe(env.MITZO_BACKUP_UPLOAD_PROBE!),
  );
  return new BackupService({
    root,
    driver: {
      capture,
      initialize: () => restic.initialize(),
      backup: (path) => restic.backup(path),
      check: () => restic.check(),
      publish: () => transport.publish(repository),
      refresh: (id) => transport.refresh(id),
    },
  });
}
