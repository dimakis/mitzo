import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  contained,
  digestFile,
  durableJson,
  readSmall,
  safeDirectory,
  syncDirectory,
  verifiedCopy,
} from './files.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
const repoPath = z
  .string()
  .regex(/^(config|(?:keys|index|snapshots)\/[a-f0-9]{64}|data\/[a-f0-9]{2}\/[a-f0-9]{64})$/);
const catalogSchema = z
  .object({
    version: z.literal(1),
    id,
    createdAt: z.string().datetime(),
    files: z
      .array(z.object({ path: repoPath, hash, size: z.number().int().nonnegative() }).strict())
      .min(1)
      .max(100000),
  })
  .strict();
type Catalog = z.infer<typeof catalogSchema>;
export type UploadState = 'uploaded' | 'pending' | 'unknown';
export type UploadProbe = (path: string) => Promise<UploadState>;
export interface Generation {
  id: string;
  createdAt: string;
  status: 'uploaded' | 'pending';
  objects: number;
  bytes: number;
}

/** Exports only completed Restic repositories. The caller must hold its writer fence. */
export class ICloudBackupTransport {
  constructor(
    private readonly directory: string,
    private readonly upload: UploadProbe,
  ) {}
  private catalogPath(generation: string) {
    id.parse(generation);
    return join(this.directory, 'generations', generation + '.json');
  }
  private objectPath(digest: string) {
    hash.parse(digest);
    return join(this.directory, 'objects', digest);
  }
  private async catalog(generation: string): Promise<Catalog> {
    const result = catalogSchema.parse(JSON.parse(await readSmall(this.catalogPath(generation))));
    if (
      result.id !== generation ||
      new Set(result.files.map((f) => f.path)).size !== result.files.length ||
      !result.files.some((f) => f.path === 'config') ||
      !result.files.some((f) => f.path.startsWith('keys/')) ||
      !result.files.some((f) => f.path.startsWith('snapshots/'))
    )
      throw new Error('Invalid backup catalog');
    return result;
  }
  async publish(repository: string): Promise<Generation> {
    if (contained(repository, this.directory) || contained(this.directory, repository))
      throw new Error('Backup source and destination overlap');
    await safeDirectory(repository);
    const files: Catalog['files'] = [];
    const visit = async (directory: string, prefix = '') => {
      for (const name of (await readdir(directory)).sort()) {
        const path = prefix + name;
        const source = join(directory, name);
        const stat = await lstat(source);
        if (stat.isSymbolicLink()) throw new Error('Unsafe backup repository');
        if (path === 'locks' && stat.isDirectory()) {
          if ((await readdir(source)).length !== 0) throw new Error('Restic repository is busy');
          continue;
        }
        if (stat.isDirectory() && /^(data|data\/[a-f0-9]{2}|keys|index|snapshots)$/.test(path))
          await visit(source, path + '/');
        else {
          repoPath.parse(path);
          if (!stat.isFile()) throw new Error('Unsafe backup repository');
          files.push({ path, ...(await digestFile(source)) });
        }
      }
    };
    await visit(resolve(repository));
    const catalog = catalogSchema.parse({
      version: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      files,
    });
    // Check required structure before exporting a single object.
    if (
      !files.some((f) => f.path === 'config') ||
      !files.some((f) => f.path.startsWith('keys/')) ||
      !files.some((f) => f.path.startsWith('snapshots/'))
    )
      throw new Error('Incomplete backup repository');
    await safeDirectory(this.directory, true);
    for (const file of files) {
      const target = this.objectPath(file.hash);
      try {
        const existing = await digestFile(target);
        if (existing.hash !== file.hash || existing.size !== file.size)
          throw new Error('Backup object integrity failure');
      } catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
        await verifiedCopy(join(repository, file.path), target, file);
      }
    }
    // A generation is selectable only after all its local objects are durable.
    await durableJson(this.catalogPath(catalog.id), catalog);
    return this.refresh(catalog.id);
  }
  async refresh(generation: string): Promise<Generation> {
    const catalog = await this.catalog(generation);
    let uploaded = true;
    for (const file of catalog.files) {
      const path = this.objectPath(file.hash);
      const actual = await digestFile(path);
      if (actual.hash !== file.hash || actual.size !== file.size)
        throw new Error('Backup object integrity failure');
      uploaded &&= (await this.upload(path).catch(() => 'unknown')) === 'uploaded';
    }
    uploaded &&=
      (await this.upload(this.catalogPath(generation)).catch(() => 'unknown')) === 'uploaded';
    return {
      id: generation,
      createdAt: catalog.createdAt,
      status: uploaded ? 'uploaded' : 'pending',
      objects: catalog.files.length,
      bytes: catalog.files.reduce((sum, f) => sum + f.size, 0),
    };
  }
  async restore(generation: string, destination: string): Promise<void> {
    if (contained(this.directory, destination) || contained(destination, this.directory))
      throw new Error('Restore destination overlaps backup storage');
    const catalog = await this.catalog(generation);
    await this.refresh(generation); // Validates every object before writing anything.
    await safeDirectory(dirname(destination));
    try {
      await lstat(destination);
      throw new Error('Restore destination already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const staging = destination + '.staging-' + randomUUID();
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const file of catalog.files)
        await verifiedCopy(this.objectPath(file.hash), join(staging, file.path), file);
      // mkdir reserves the final name without replacing an existing user's workspace.
      await mkdir(destination, { mode: 0o700 });
      await rename(staging, destination);
      await syncDirectory(dirname(destination));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
