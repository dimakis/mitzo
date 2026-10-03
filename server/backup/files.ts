import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export async function safeDirectory(path: string, create = false): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe backup directory');
  }
}
export function contained(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
export async function digestFile(path: string): Promise<{ hash: string; size: number }> {
  await safeDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Invalid backup object');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
    }
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      size !== before.size
    )
      throw new Error('Backup source changed during capture');
    return { hash: hash.digest('hex'), size };
  } finally {
    await handle.close();
  }
}
export async function readSmall(path: string, limit = 16 * 1024 * 1024): Promise<string> {
  await safeDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid backup catalog');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('Invalid backup catalog');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
export async function durableJson(path: string, value: unknown): Promise<void> {
  await safeDirectory(dirname(path), true);
  const tmp = path + '.' + randomUUID() + '.tmp';
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(tmp, { force: true });
  }
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function verifiedCopy(
  source: string,
  target: string,
  expected: { hash: string; size: number },
): Promise<void> {
  await safeDirectory(dirname(target), true);
  const input = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const tmp = target + '.' + randomUUID() + '.tmp';
  let output;
  try {
    if (!(await input.stat()).isFile()) throw new Error('Invalid backup object');
    output = await open(tmp, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
      await output.writeFile(chunk);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.hash)
      throw new Error('Backup object integrity failure');
    await output.sync();
    await output.close();
    output = undefined;
    await rename(tmp, target);
    await syncDirectory(dirname(target));
  } finally {
    await input.close();
    await output?.close();
    await rm(tmp, { force: true });
  }
}

export async function syncSnapshotTree(path: string): Promise<void> {
  await safeDirectory(path);
  for (const name of await readdir(path)) {
    const entry = join(path, name);
    const stat = await lstat(entry);
    if (stat.isSymbolicLink()) throw new Error('Unsafe snapshot entry');
    if (stat.isDirectory()) await syncSnapshotTree(entry);
    else {
      if (!stat.isFile()) throw new Error('Unsafe snapshot entry');
      const handle = await open(
        entry,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Unsafe snapshot entry');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(path);
}
