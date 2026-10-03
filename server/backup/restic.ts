import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { contained, safeDirectory, syncDirectory } from './files.js';

export interface ResticOptions {
  binary: string;
  repository: string;
  scratch: string;
  password(): Promise<string>;
  recoveryConfirmed: boolean;
}
/** Trusted host configuration only; not an HTTP request or agent-supplied command. */
export class ResticRepository {
  constructor(private readonly options: ResticOptions) {
    if (!options.recoveryConfirmed) throw new Error('Independent recovery must be confirmed');
    if (![options.binary, options.repository, options.scratch].every(isAbsolute))
      throw new Error('Backup paths must be absolute');
    if (
      contained(options.repository, options.scratch) ||
      contained(options.scratch, options.repository)
    )
      throw new Error('Backup repository and scratch overlap');
  }
  private async run(args: string[], cwd?: string): Promise<string> {
    await safeDirectory(this.options.scratch, true);
    const privateDirectory = await mkdtemp(join(this.options.scratch, 'credential-'));
    try {
      const secret = await this.options.password();
      if (!secret || secret.includes('\n') || secret.includes('\0') || secret.length > 4096)
        throw new Error('Invalid backup credential');
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(
          this.options.binary,
          ['--repo', this.options.repository, '--no-cache', ...args],
          {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { PATH: '/usr/bin:/bin', TMPDIR: privateDirectory, RESTIC_PASSWORD: secret },
          },
        );
        let output = '';
        let failed = false;
        const timer = setTimeout(
          () => {
            failed = true;
            child.kill('SIGKILL');
          },
          60 * 60 * 1000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
          if (output.length + chunk.length > 16 * 1024 * 1024) {
            failed = true;
            child.kill('SIGKILL');
          } else output += chunk.toString();
        });
        child.on('error', () => {
          clearTimeout(timer);
          reject(new Error('Encrypted backup command failed'));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0 || failed) reject(new Error('Encrypted backup command failed'));
          else resolve(output);
        });
      });
    } finally {
      await rm(privateDirectory, { recursive: true, force: true });
    }
  }
  async initialize(): Promise<void> {
    await safeDirectory(dirname(this.options.repository), true);
    try {
      await lstat(this.options.repository);
      await safeDirectory(this.options.repository);
      await this.run(['snapshots', '--json']);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.run(['init', '--repository-version', '2']);
    }
  }
  async backup(source: string): Promise<string> {
    await safeDirectory(source);
    if (
      contained(source, this.options.repository) ||
      contained(source, this.options.scratch) ||
      contained(this.options.repository, source)
    )
      throw new Error('Backup source overlaps internal storage');
    const output = await this.run(
      ['backup', '--json', '--host', 'mitzo-backup', '--tag', 'ecosystem', '.'],
      source,
    );
    const result = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { message_type?: string; snapshot_id?: string })
      .find((line) => line.message_type === 'summary');
    if (!result?.snapshot_id || !/^[a-f0-9]{8,64}$/.test(result.snapshot_id))
      throw new Error('Invalid encrypted backup receipt');
    return result.snapshot_id;
  }
  async check(): Promise<void> {
    await this.run(['check', '--read-data']);
  }
  async restore(snapshot: string, destination: string): Promise<void> {
    if (!/^[a-f0-9]{8,64}$/.test(snapshot)) throw new Error('Invalid snapshot');
    if (
      contained(this.options.repository, destination) ||
      contained(destination, this.options.repository) ||
      contained(this.options.scratch, destination) ||
      contained(destination, this.options.scratch)
    )
      throw new Error('Restore destination overlaps internal storage');
    await safeDirectory(dirname(destination));
    try {
      await lstat(destination);
      throw new Error('Restore destination already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.check();
    const staging = destination + '.restore-' + randomUUID();
    try {
      await this.run(['restore', snapshot, '--target', staging, '--verify']);
      await mkdir(destination, { mode: 0o700 });
      await rename(staging, destination);
      await syncDirectory(dirname(destination));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
