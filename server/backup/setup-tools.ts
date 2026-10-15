import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BackupSetupError } from './setup.js';
import {
  digestFile,
  durableJson,
  readSmall,
  safeDirectory,
  syncDirectory,
  syncSnapshotTree,
  verifiedCopy,
} from './files.js';

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
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const legacyManifest = z.object({ archiveHash: hash, resticHash: hash, probeHash: hash }).strict();
const currentManifest = legacyManifest
  .extend({ version: z.literal(2), generation: z.uuid(), sourceHash: hash })
  .strict();
const manifestSchema = z.union([currentManifest, legacyManifest]);
type Manifest = z.infer<typeof manifestSchema>;
function pathsFor(directory: string, manifest?: Manifest) {
  return backupToolPaths(
    manifest && 'generation' in manifest
      ? join(directory, 'generation-' + manifest.generation)
      : directory,
  );
}
async function readManifest(directory: string) {
  try {
    return manifestSchema.parse(JSON.parse(await readSmall(join(directory, 'tools.json'), 4096)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function qualify(directory: string, manifest: Manifest) {
  const paths = pathsFor(directory, manifest);
  if ('generation' in manifest) {
    const installed = await readManifest(join(directory, 'generation-' + manifest.generation));
    if (JSON.stringify(installed) !== JSON.stringify(manifest)) throw Error();
  }
  for (const [path, expected] of [
    [paths.restic, manifest.resticHash],
    [paths.probe, manifest.probeHash],
  ]) {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 ||
      (await digestFile(path)).hash !== expected
    )
      throw Error();
  }
  return paths;
}
/** Read-only resolution for startup. Only a complete, qualified bundle is selected. */
export async function readBackupToolPaths(directory: string) {
  const manifest = await readManifest(directory);
  return manifest ? qualify(directory, manifest) : backupToolPaths(directory);
}
/** Stage a complete immutable generation before atomically selecting it. A failed
 * selection preserves the previous tools; unselected generations cannot block retry.
 * Source identity is part of qualification, so updates rebuild the upload probe. */
export async function prepareBackupTools(options: {
  directory: string;
  source: string;
  download?: (url: string) => Promise<Buffer>;
  execute?: Execute;
  archiveHash?: string;
}) {
  const archiveHash = options.archiveHash ?? hashes[process.arch];
  const run = options.execute ?? execute;
  const generation = randomUUID();
  const scratch = join(options.directory, 'prepare-' + generation);
  try {
    if (!archiveHash) throw Error();
    await safeDirectory(options.directory, true);
    const info = await lstat(options.directory);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error();
    const source = await readSmall(options.source, 256 * 1024);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const previous = await readManifest(options.directory);
    const selected = previous ? await qualify(options.directory, previous) : undefined;
    if (
      previous &&
      'sourceHash' in previous &&
      previous.sourceHash === sourceHash &&
      previous.archiveHash === archiveHash
    )
      return selected!;
    if (!previous) {
      // Unknown legacy files are not ours to overwrite or adopt.
      for (const path of Object.values(backupToolPaths(options.directory))) {
        try {
          await lstat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        throw Error();
      }
    }
    await safeDirectory(scratch, true);
    const paths = backupToolPaths(scratch);
    if (previous?.archiveHash === archiveHash && selected) {
      await verifiedCopy(selected.restic, paths.restic, {
        hash: previous.resticHash,
        size: (await lstat(selected.restic)).size,
      });
      await chmod(paths.restic, 0o700);
    } else {
      const compressed = await (options.download ?? download)(
        `https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}.bz2`,
      );
      if (createHash('sha256').update(compressed).digest('hex') !== archiveHash) throw Error();
      const archive = join(scratch, 'restic.bz2');
      await writeFile(archive, compressed, { flag: 'wx', mode: 0o600 });
      await writeFile(paths.restic, await run('/usr/bin/bzip2', ['-dc', archive]), {
        flag: 'wx',
        mode: 0o700,
      });
      await rm(archive);
    }
    // Compile the exact bytes whose hash is recorded, even if the source file changes.
    const pinnedSource = join(scratch, 'probe.swift');
    await writeFile(pinnedSource, source, { flag: 'wx', mode: 0o600 });
    const cache = join(scratch, 'module-cache');
    await run('/usr/bin/swiftc', ['-module-cache-path', cache, pinnedSource, '-o', paths.probe]);
    await chmod(paths.probe, 0o700);
    await rm(pinnedSource);
    await rm(cache, { recursive: true, force: true });
    const manifest = {
      version: 2 as const,
      generation,
      archiveHash,
      sourceHash,
      resticHash: (await digestFile(paths.restic)).hash,
      probeHash: (await digestFile(paths.probe)).hash,
    };
    await durableJson(join(scratch, 'tools.json'), manifest);
    await syncSnapshotTree(scratch);
    await rename(scratch, join(options.directory, 'generation-' + generation));
    await syncDirectory(options.directory);
    // If this fails before or after rename, retry selects either the previous complete
    // generation or this complete generation. Never delete a possibly selected bundle.
    await durableJson(join(options.directory, 'tools.json'), manifest);
    return pathsFor(options.directory, manifest);
  } catch {
    throw new BackupSetupError(
      'Backup tools could not be prepared. Check internet access and the Mac’s Swift command-line tools, then retry. Existing files were preserved.',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
