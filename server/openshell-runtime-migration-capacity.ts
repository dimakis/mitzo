import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
export interface RuntimeMigrationCapacity {
  archiveBytes: number;
  archiveEntries: number;
  seedBytes: number;
  hostFreeBytes: number;
  vmFreeBytes: number;
  hostRequiredBytes: number;
  vmRequiredBytes: number;
}
/** Three simultaneous archive/extraction copies plus the fresh seed backup and
 * fixed headroom. Existing image layers and original sandbox are never reclaimed. */
export function migrationCapacity(
  archiveBytes: number,
  seedBytes: number,
  hostFreeBytes: number,
  vmFreeBytes: number,
  archiveEntries = 0,
): RuntimeMigrationCapacity {
  const headroom = 64 * 1024 * 1024;
  const extractedBound = archiveBytes + archiveEntries * 4096;
  const proof = {
    archiveBytes,
    archiveEntries,
    seedBytes,
    hostFreeBytes,
    vmFreeBytes,
    hostRequiredBytes: 3 * extractedBound + headroom,
    vmRequiredBytes: 3 * extractedBound + 2 * seedBytes + headroom,
  };
  if (
    [archiveBytes, archiveEntries, seedBytes, hostFreeBytes, vmFreeBytes].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    )
  )
    throw new Error('Migration storage capacity observation is invalid');
  if (hostFreeBytes < proof.hostRequiredBytes || vmFreeBytes < proof.vmRequiredBytes)
    throw new Error(
      `Migration storage capacity insufficient: host requires ${proof.hostRequiredBytes} bytes, available ${hostFreeBytes}; VM requires ${proof.vmRequiredBytes} bytes, available ${vmFreeBytes}`,
    );
  return proof;
}
function directoryBytes(path: string): number {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error('Migration seed capacity contains unsupported layout');
  return stat.isFile()
    ? Math.ceil(stat.size / 4096) * 4096
    : 4096 + readdirSync(path).reduce((total, name) => total + directoryBytes(join(path, name)), 0);
}
export async function requireRuntimeMigrationCapacity(
  input: {
    checkpointPath: string;
    privateDirectory: string;
    seedDirectory: string;
    targetImage: string;
    imageReference: string;
  },
  run: (args: string[]) => Promise<string>,
): Promise<RuntimeMigrationCapacity> {
  // Refuse an uncached target: downloading unknown layers exceeds this bound.
  const images = JSON.parse(await run(['image', 'inspect', input.imageReference]));
  if (images.length !== 1 || images[0].Digest !== input.targetImage)
    throw new Error('Migration target image is not locally cached');
  const info = JSON.parse(await run(['info', '--format', 'json']));
  const graphRoot = info.store?.graphRoot,
    hostname = info.host?.hostname;
  if (
    typeof graphRoot !== 'string' ||
    !/^\/[a-zA-Z0-9_./-]+$/.test(graphRoot) ||
    typeof hostname !== 'string'
  )
    throw new Error('Migration VM storage capacity provenance unavailable');
  const machines = JSON.parse(await run(['machine', 'list', '--format', 'json']));
  const running = machines.filter((machine: { Running: boolean }) => machine.Running);
  if (running.length !== 1 || !/^[a-zA-Z0-9_.-]+$/.test(running[0].Name))
    throw new Error('Migration VM capacity ownership is ambiguous');
  const machine = running[0].Name;
  if ((await run(['machine', 'ssh', machine, 'hostname'])).trim() !== hostname)
    throw new Error('Migration VM capacity host differs from current backend');
  const disk = (await run(['machine', 'ssh', machine, 'df', '-Pk', graphRoot])).trim().split('\n');
  const columns = disk.at(-1)?.trim().split(/\s+/);
  if (disk.length !== 2 || !columns || columns.length < 6 || !/^\d+$/.test(columns[3]))
    throw new Error('Migration VM free space observation unavailable');
  const host = statfsSync(input.privateDirectory);
  const vmBlock = Number(
    (await run(['machine', 'ssh', machine, 'stat', '-f', '-c', '%S', graphRoot])).trim(),
  );
  if (!Number.isSafeInteger(vmBlock) || vmBlock <= 0 || vmBlock > 4096 || host.bsize > 4096)
    throw new Error('Migration storage capacity allocation unit is unsupported');
  return migrationCapacity(
    statSync(input.checkpointPath).size,
    directoryBytes(realpathSync(input.seedDirectory)),
    host.bavail * host.bsize,
    Number(columns[3]) * 1024,
    execFileSync('tar', ['-tf', input.checkpointPath], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .trim()
      .split('\n').length,
  );
}
