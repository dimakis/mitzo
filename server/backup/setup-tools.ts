import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BackupSetupError } from './setup.js';
import { digestFile, durableJson, readSmall, safeDirectory } from './files.js';

const hashes: Record<string, string> = {
  arm64: '7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143',
  x64: 'c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35',
};
const exec = promisify(execFile);
type Execute = (binary: string, args: string[]) => Promise<Buffer>;
const execute: Execute = async (binary, args) =>
  (
    await exec(binary, args, {
      encoding: 'buffer',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin' },
    })
  ).stdout;
async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw Error();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw Error();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function backupToolPaths(directory: string) {
  return {
    restic: join(directory, 'restic-0.19.1'),
    probe: join(directory, 'icloud-upload-status'),
  };
}
const manifestSchema = z
  .object({ archiveHash: z.string(), resticHash: z.string(), probeHash: z.string() })
  .strict();
/** Pinned upstream Restic download and the bundled reviewed Swift source only.
 * No shell, package-manager installer, model or provider credentials are used. */
export async function prepareBackupTools(options: {
  directory: string;
  source: string;
  download?: (url: string) => Promise<Buffer>;
  execute?: Execute;
  archiveHash?: string;
}) {
  const paths = backupToolPaths(options.directory);
  const archiveHash = options.archiveHash ?? hashes[process.arch];
  const run = options.execute ?? execute;
  const scratch = join(options.directory, 'prepare-' + randomUUID());
  try {
    if (!archiveHash) throw Error();
    await safeDirectory(options.directory, true);
    const info = await lstat(options.directory);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error();
    const manifestPath = join(options.directory, 'tools.json');
    let manifest: z.infer<typeof manifestSchema> | undefined;
    try {
      manifest = manifestSchema.parse(JSON.parse(await readSmall(manifestPath, 4096)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (manifest) {
      if (manifest.archiveHash !== archiveHash) throw Error();
      for (const [path, hash] of [
        [paths.restic, manifest.resticHash],
        [paths.probe, manifest.probeHash],
      ]) {
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o777) !== 0o700 ||
          (await digestFile(path)).hash !== hash
        )
          throw Error();
      }
      return paths;
    }
    // Never overwrite an unqualified executable or a partial earlier installation.
    for (const path of Object.values(paths)) {
      try {
        await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw Error();
    }
    const compressed = await (options.download ?? download)(
      `https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}.bz2`,
    );
    if (createHash('sha256').update(compressed).digest('hex') !== archiveHash) throw Error();
    await safeDirectory(scratch, true);
    const archive = join(scratch, 'restic.bz2');
    await writeFile(archive, compressed, { flag: 'wx', mode: 0o600 });
    const restic = join(scratch, 'restic');
    await writeFile(restic, await run('/usr/bin/bzip2', ['-dc', archive]), {
      flag: 'wx',
      mode: 0o700,
    });
    const probe = join(scratch, 'probe');
    await run('/usr/bin/swiftc', [
      '-module-cache-path',
      join(scratch, 'module-cache'),
      options.source,
      '-o',
      probe,
    ]);
    await chmod(probe, 0o700);
    const values = {
      archiveHash,
      resticHash: (await digestFile(restic)).hash,
      probeHash: (await digestFile(probe)).hash,
    };
    await link(restic, paths.restic);
    await link(probe, paths.probe);
    await durableJson(manifestPath, values);
    return paths;
  } catch {
    throw new BackupSetupError(
      'Backup tools could not be prepared. Check internet access and the Mac’s Swift command-line tools, then retry. Existing files were preserved.',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
