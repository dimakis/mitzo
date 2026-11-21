import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, createReadStream } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
  open,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

export const dependencyStoreRoot = () =>
  join(userInfo().homedir, '.local', 'share', 'mitzo-dependency-store', 'v1');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const error = (code) => Object.assign(new Error(`Dependency store: ${code}`), { code });
const inside = (root, path) => {
  const scope = relative(root, path);
  return scope !== '..' && !scope.startsWith(`..${sep}`) && !isAbsolute(scope);
};
const keyPattern = /^[a-f0-9]{64}$/;
const toolchainPattern = /^\.mitzo-devtools\/toolchains\/[a-zA-Z0-9-]+$/;

async function exists(path) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
}

// Refuse redirected directories before creating/copying descendants. In production
// the OS task sandbox also denies writes to this fixed host-owned store root.
export async function ownedDirectory(root, path = root) {
  root = resolve(root);
  path = resolve(path);
  if (!inside(root, path)) throw error('workspace_escape');
  const parent = dirname(root);
  if (parent !== root && !(await exists(root))) await mkdir(parent, { recursive: true });
  let current = root;
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = await exists(current);
    if (!info) await mkdir(current);
    else if (!info.isDirectory() || info.isSymbolicLink()) throw error('redirected_directory');
  }
  return path;
}

async function fileDigest(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

async function inventory(root, { nativeSource = false } = {}) {
  const rows = [];
  async function walk(path, name) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !inside(root, resolve(dirname(path), target)))
        throw error('unsafe_link');
      rows.push([name, 'link', target]);
    } else if (info.isDirectory()) {
      rows.push([name, 'directory']);
      for (const child of (await readdir(path)).sort()) {
        if (nativeSource && ['build', 'node_modules', '.git'].includes(child)) continue;
        await walk(join(path, child), name ? `${name}/${child}` : child);
      }
    } else if (info.isFile()) {
      if (info.nlink !== 1) throw error('hardlinked_artifact');
      rows.push([name, 'file', info.mode & 0o111, info.size, await fileDigest(path)]);
    } else throw error('special_artifact');
  }
  if (await exists(root)) await walk(root, '');
  return rows;
}

async function workspacePaths(cwd) {
  const lock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'));
  return Object.keys(lock.packages ?? {})
    .filter(
      (path) =>
        path &&
        !path.split('/').includes('node_modules') &&
        !isAbsolute(path) &&
        !path.split('/').some((part) => ['..', '.'].includes(part)),
    )
    .sort();
}

export async function dependencyIdentity(cwd, runtime) {
  const manifests = [];
  for (const path of ['', ...(await workspacePaths(cwd))]) {
    const filename = join(cwd, path, 'package.json');
    if (await exists(filename)) manifests.push([path, await fileDigest(filename)]);
  }
  return hash(
    JSON.stringify({
      schema: 1,
      lock: await fileDigest(join(cwd, 'package-lock.json')),
      runtime,
      manifests,
      native: await inventory(join(cwd, 'packages/sqlite-file-owner'), { nativeSource: true }),
      // Root lifecycle hooks and vendored packages can change without a lock edit.
      scripts: await inventory(join(cwd, 'scripts'), { nativeSource: true }),
      vendor: await inventory(join(cwd, 'vendor'), { nativeSource: true }),
    }),
  );
}

async function partsFor(cwd, toolchain) {
  if (!toolchainPattern.test(toolchain)) throw error('invalid_toolchain');
  const parts = ['node_modules', toolchain];
  for (const path of await workspacePaths(cwd)) {
    if (await exists(join(cwd, path, 'node_modules'))) parts.push(`${path}/node_modules`);
  }
  if (await exists(join(cwd, 'packages/sqlite-file-owner/build')))
    parts.push('packages/sqlite-file-owner/build');
  return parts.sort();
}

async function clone(source, target) {
  if (process.platform === 'darwin') {
    // libuv's COPYFILE_FICLONE_FORCE is ENOSYS on macOS. The system cp -c
    // uses clonefile(2); -P preserves symlinks rather than following them.
    await promisify(execFile)('/bin/cp', ['-cR', '-P', source, target]);
    return;
  }
  await cp(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
    // On APFS failure is explicit: never silently promise CoW while copying bytes.
    mode: constants.COPYFILE_FICLONE,
  });
}

async function permissions(root, rows, writable) {
  for (const [name, kind, executable] of [...rows].reverse()) {
    if (kind !== 'link')
      await chmod(
        join(root, name),
        kind === 'directory' ? (writable ? 0o755 : 0o555) : (writable ? 0o644 : 0o444) | executable,
      );
  }
}

async function removeOwned(path) {
  if (!(await exists(path))) return;
  // Cleanup never follows links or re-hashes rejected content. In particular an
  // unsafe symlink must not prevent removal of our own unpublished temporary.
  async function writable(entry) {
    const info = await lstat(entry);
    if (info.isSymbolicLink()) return;
    await chmod(entry, info.isDirectory() ? 0o755 : 0o644 | (info.mode & 0o111));
    if (info.isDirectory())
      for (const name of await readdir(entry)) await writable(join(entry, name));
  }
  await writable(path);
  await rm(path, { recursive: true });
}

// Cleanup can fail a successful operation, but never replace its original
// failure. Callers returning a fallback also expose the secondary failure.
async function cleanupAfter(work, primary) {
  try {
    await work();
  } catch (cause) {
    if (!primary) throw cause;
    primary.cleanupCode = cause.code ?? 'cleanup_failed';
    return primary.cleanupCode;
  }
}

async function withWriter(store, work) {
  await ownedDirectory(store);
  const lock = join(store, '.writer');
  try {
    await mkdir(lock);
  } catch (cause) {
    if (cause.code === 'EEXIST') throw error('writer_busy');
    throw cause;
  }
  let primary;
  try {
    return await work();
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    await cleanupAfter(() => rm(lock, { recursive: true }), primary);
  }
}

/** Host-only. Never promote a task's receipt or mutable node_modules. The host
 * creates a clean build under .builds, runs isolated setup, then verifies again. */
export async function publishDependencySet({
  store = dependencyStoreRoot(),
  cwd,
  runtime,
  toolchain,
  verify,
}) {
  store = resolve(store);
  cwd = await realpath(cwd);
  if (!inside(join(store, '.builds'), cwd) || cwd === join(store, '.builds'))
    throw error('untrusted_build');
  return withWriter(store, async () => {
    if (!(await verify()).ready) throw error('verification_failed');
    const key = await dependencyIdentity(cwd, runtime);
    const parts = await partsFor(cwd, toolchain);
    const entries = await ownedDirectory(store, join(store, 'entries'));
    const pending = await mkdtemp(join(store, '.pending-'));
    let primary;
    try {
      const payload = await ownedDirectory(pending, join(pending, 'payload'));
      for (const part of parts) {
        await ownedDirectory(payload, dirname(join(payload, part)));
        await clone(join(cwd, part), join(payload, part));
      }
      const rows = await inventory(payload);
      const metadata = { schema: 1, key, runtime, parts, inventory: rows, createdAt: Date.now() };
      await writeFile(join(pending, 'entry.json'), JSON.stringify(metadata), { flag: 'wx' });
      await permissions(pending, await inventory(pending), false);
      const destination = join(entries, key);
      if (await exists(destination)) {
        // Never replace an entry while another session could be reading it.
        const retained = JSON.parse(await readFile(join(destination, 'entry.json'), 'utf8'));
        if (
          JSON.stringify(await inventory(join(destination, 'payload'))) !==
          JSON.stringify(retained.inventory)
        )
          throw error('integrity_mismatch');
      } else {
        // macOS needs write permission on a directory moved between parents.
        // The OS sandbox, not mode bits, is the session trust boundary.
        await chmod(pending, 0o755);
        await rename(pending, destination);
        await chmod(destination, 0o555);
      }
      return { key, status: 'published' };
    } catch (cause) {
      primary = cause;
      throw cause;
    } finally {
      await cleanupAfter(() => removeOwned(pending), primary);
    }
  });
}

/** Read-only store access. Stage and hash the private clone before any install
 * path is replaced. A missing or damaged entry falls back to isolated setup. */
export async function restoreDependencySet({ store = dependencyStoreRoot(), cwd }) {
  const entries = join(store, 'entries');
  if (!(await exists(entries))) return { status: 'miss' };
  if ((await lstat(entries)).isSymbolicLink()) throw error('redirected_directory');
  cwd = await realpath(cwd);
  for (const key of (await readdir(entries)).filter((name) => keyPattern.test(name)).sort()) {
    const entry = join(entries, key);
    let temporary;
    let primary;
    let fallback;
    try {
      if (!(await lstat(entry)).isDirectory()) throw error('invalid_entry');
      const metadata = JSON.parse(await readFile(join(entry, 'entry.json'), 'utf8'));
      if (
        metadata?.schema !== 1 ||
        metadata.key !== key ||
        !metadata.runtime ||
        !Array.isArray(metadata.parts) ||
        !metadata.parts.every((part) => typeof part === 'string') ||
        !Array.isArray(metadata.inventory)
      )
        throw error('invalid_entry');
      if (metadata.runtime.platform !== process.platform || metadata.runtime.arch !== process.arch)
        continue;
      if ((await dependencyIdentity(cwd, metadata.runtime)) !== key) continue;
      const toolchain = metadata.parts.find((part) =>
        part.startsWith('.mitzo-devtools/toolchains/'),
      );
      // Parts are strictly limited; no arbitrary metadata-directed task writes.
      const allowed = new Set([
        'node_modules',
        toolchain,
        'packages/sqlite-file-owner/build',
        ...(await workspacePaths(cwd)).map((path) => `${path}/node_modules`),
      ]);
      if (
        !toolchain ||
        !toolchainPattern.test(toolchain) ||
        !metadata.parts.includes('node_modules') ||
        metadata.parts.some((part) => !allowed.has(part)) ||
        new Set(metadata.parts).size !== metadata.parts.length
      )
        throw error('invalid_entry');
      const scratch = await ownedDirectory(cwd, join(cwd, '.mitzo-devtools', 'tmp'));
      temporary = await mkdtemp(join(scratch, 'dependency-clone-'));
      await clone(join(entry, 'payload'), join(temporary, 'payload'));
      const payload = join(temporary, 'payload');
      const rows = await inventory(payload);
      if (JSON.stringify(rows) !== JSON.stringify(metadata.inventory))
        throw error('integrity_mismatch');
      await permissions(payload, rows, true);
      for (const part of metadata.parts) {
        const target = join(cwd, part);
        await ownedDirectory(cwd, dirname(target));
        const existing = await exists(target);
        if (existing?.isSymbolicLink() || (existing && !existing.isDirectory()))
          throw error('redirected_directory');
      }
      for (const part of metadata.parts) {
        const target = join(cwd, part);
        if (await exists(target)) await rename(target, join(temporary, `old-${randomUUID()}`));
        await rename(join(payload, part), target);
      }
      // APFS may not update atime. Sessions record use in their own writable
      // task; only the host adopts these bounded advisory receipts for LRU.
      const usage = join(temporary, 'usage.json');
      await writeFile(usage, JSON.stringify({ key }), { flag: 'wx' });
      await rename(usage, join(cwd, '.mitzo-devtools', 'dependency-store-use.json'));
      return {
        status: 'hit',
        key,
        clone: process.platform === 'darwin' ? 'apfs' : 'reflink-or-copy',
      };
    } catch (cause) {
      primary = cause;
      if (
        ['integrity_mismatch', 'unsafe_link', 'invalid_entry', 'ENOENT'].includes(cause.code) ||
        cause instanceof SyntaxError
      )
        return (fallback = {
          status: 'invalid',
          reason: cause.code === 'ENOENT' ? 'entry_removed' : (cause.code ?? 'invalid_entry'),
        });
      throw cause;
    } finally {
      if (temporary) {
        const cleanupCode = await cleanupAfter(() => removeOwned(temporary), primary);
        if (fallback && cleanupCode) fallback.cleanupReason = 'cleanup_failed';
      }
    }
  }
  return { status: 'miss' };
}

export async function managedDependencyConsumers() {
  const root = join(userInfo().homedir, '.local', 'share', 'mitzo', 'ordinary-tasks');
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 10000) throw error('consumer_scan_limit');
  return entries
    .filter((entry) => entry.isDirectory() && /^(repo|ordinary)-[a-f0-9-]+$/.test(entry.name))
    .map((entry) => join(root, entry.name));
}

async function usageReceipts(roots, now) {
  const usage = {};
  for (const root of roots) {
    const directory = join(root, '.mitzo-devtools');
    const path = join(directory, 'dependency-store-use.json');
    // Task receipts are advisory only: never follow a redirected directory or
    // file, retain payloads, or let a receipt expand the candidate deletion set.
    if (!(await exists(directory))) continue;
    if ((await realpath(directory)) !== resolve(directory)) continue;
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 || info.uid !== process.getuid?.())
        continue;
      const receipt = JSON.parse(await file.readFile('utf8'));
      if (keyPattern.test(receipt?.key ?? ''))
        usage[receipt.key] = Math.max(usage[receipt.key] ?? 0, Math.min(now, info.mtimeMs));
    } catch (cause) {
      // A removed, redirected or malformed task hint grants no retention claim.
      if (!['ENOENT', 'ELOOP', 'ENOTDIR'].includes(cause.code) && !(cause instanceof SyntaxError))
        throw cause;
    } finally {
      if (file) await file.close();
    }
  }
  return usage;
}

/** Host-only LRU. Private session receipts update a host-owned ledger, without
 * granting any session writes to entries or trusting atime on APFS. */
export async function pruneDependencyStore({
  store = dependencyStoreRoot(),
  maxEntries = 8,
  maxAgeMs = 30 * 86400_000,
  now = Date.now(),
  usageRoots = [],
} = {}) {
  if (
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0
  )
    throw error('invalid_retention');
  return withWriter(store, async () => {
    const entries = join(store, 'entries');
    if (!(await exists(entries))) return [];
    const candidates = [];
    const ledgerPath = join(store, 'usage.json');
    const previous = (await exists(ledgerPath))
      ? JSON.parse(await readFile(ledgerPath, 'utf8'))
      : {};
    const usage = await usageReceipts(usageRoots, now);
    for (const key of (await readdir(entries)).filter((name) => keyPattern.test(name))) {
      const path = join(entries, key);
      if (!(await lstat(path)).isDirectory()) throw error('invalid_entry');
      const metadata = JSON.parse(await readFile(join(path, 'entry.json'), 'utf8'));
      if (metadata.schema !== 1 || metadata.key !== key) throw error('invalid_entry');
      if (!Number.isFinite(metadata.createdAt)) throw error('invalid_entry');
      candidates.push({
        key,
        path,
        used: Math.max(
          Math.min(now, metadata.createdAt),
          Number.isFinite(previous[key]) ? Math.min(now, previous[key]) : 0,
          usage[key] ?? 0,
        ),
      });
    }
    candidates.sort((a, b) => b.used - a.used || b.key.localeCompare(a.key));
    const removed = [];
    for (const [index, item] of candidates.entries()) {
      if (index < maxEntries && now - item.used <= maxAgeMs) continue;
      await removeOwned(item.path);
      removed.push(item.key);
    }
    const pending = join(store, `.usage-${randomUUID()}`);
    await writeFile(
      pending,
      JSON.stringify(
        Object.fromEntries(
          candidates
            .filter((item) => !removed.includes(item.key))
            .map((item) => [item.key, item.used]),
        ),
      ),
      { flag: 'wx' },
    );
    await rename(pending, ledgerPath);
    return removed;
  });
}
