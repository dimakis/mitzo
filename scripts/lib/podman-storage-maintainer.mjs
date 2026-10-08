import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { digest, imageId } from './podman-storage-policy.mjs';

// One fixed authority directory per host account, shared by aliases and backends.
export const maintenanceHome = () => join(homedir(), '.local', 'state', 'mitzo-storage');
export function storeKey(store) {
  if (
    !store?.machineId ||
    !store.filesystemId ||
    !store.graphRoot ||
    !store.graphDriver ||
    typeof store.rootless !== 'boolean'
  )
    throw Error('Incomplete maintenance store identity');
  return digest({
    machineId: store.machineId,
    filesystemId: store.filesystemId,
    graphRoot: store.graphRoot,
    graphDriver: store.graphDriver,
    rootless: store.rootless,
  });
}
async function directory(home, store) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const root = await lstat(home);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.mode & 0o077 ||
    root.uid !== process.getuid?.()
  )
    throw Error('Maintenance home must be a private host-owned directory');
  const path = join(home, storeKey(store));
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077 || st.uid !== root.uid)
    throw Error('Invalid store authority directory');
  return path;
}
async function syncDirectory(path) {
  const fd = await open(path, constants.O_RDONLY);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function readJson(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.size > 16 * 1024 * 1024)
      throw Error('Invalid or oversized storage evidence');
    return JSON.parse(await fd.readFile('utf8'));
  } finally {
    await fd.close();
  }
}
export async function writeJson(path, value, exclusive = false) {
  const temp = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const fd = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fd.writeFile(JSON.stringify(value, null, 2) + '\n');
    await fd.sync();
  } finally {
    await fd.close();
  }
  if (!exclusive) await rename(temp, path);
  await syncDirectory(join(path, '..'));
}
export async function withStoreLock(home, store, action, signal) {
  signal?.throwIfAborted();
  const path = await directory(home, store);
  const lock = join(path, 'maintenance.lock');
  let fd;
  try {
    fd = await open(
      lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error(
        'Store maintenance locked; inspect original operation; no automatic lock stealing',
      );
    throw error;
  }
  const token = randomUUID();
  try {
    await fd.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: Date.now(), store }));
    await fd.sync();
    await syncDirectory(path);
    signal?.throwIfAborted();
    return await action();
  } finally {
    await fd.close();
    // A replaced lock is evidence to investigate, never something to remove.
    if ((await readJson(lock)).token !== token)
      throw Error('Maintenance lock changed; operator recovery required');
    await unlink(lock);
    await syncDirectory(path);
  }
}
export async function readState(home, store) {
  try {
    return await readJson(join(await directory(home, store), 'enrollment.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeState(home, store, state) {
  await writeJson(join(await directory(home, store), 'enrollment.json'), state);
}
export async function appendAudit(home, store, event, limit = 8 * 1024 * 1024) {
  const path = await directory(home, store);
  const audit = join(path, 'audit.jsonl');
  const row = JSON.stringify({ time: Date.now(), ...event }) + '\n';
  if (Buffer.byteLength(row) > limit) throw Error('Audit event exceeds bounded capacity');
  const st = await lstat(audit).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (st && (!st.isFile() || st.isSymbolicLink())) throw Error('Invalid audit file');
  if (st && st.size + Buffer.byteLength(row) > limit) {
    await unlink(`${audit}.2`).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rename(`${audit}.1`, `${audit}.2`).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rename(audit, `${audit}.1`);
  }
  const fd = await open(
    audit,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fd.writeFile(row);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await syncDirectory(path);
}

export async function enrollStore(home, store, requested, signal) {
  return withStoreLock(
    home,
    store,
    async () => {
      if (
        requested.version !== 1 ||
        !requested.review ||
        digest(requested.store) !== digest(store) ||
        !Array.isArray(requested.producers) ||
        requested.producers.some((p) => !p.owner || !p.family || !p.coordinated || !p.review) ||
        !Array.isArray(requested.builds)
      )
        throw Error('Explicit reviewed coordinated enrollment required');
      const current = await readState(home, store);
      const builds = new Map((current?.builds ?? []).map((b) => [b.operation, b]));
      for (const b of requested.builds) {
        if (builds.has(b.operation)) {
          if (digest(builds.get(b.operation)) !== digest(b))
            throw Error('Enrollment cannot rewrite original build custody');
        } else {
          if (
            !b.classificationReview ||
            b.state !== 'succeeded' ||
            !b.reproducible ||
            !b.recipeDigest ||
            !Number.isFinite(b.completedAt) ||
            !Array.isArray(b.images) ||
            !b.images.length ||
            b.images.some((id) => !imageId.test(id))
          )
            throw Error('Legacy output requires explicit reviewed classification');
          builds.set(b.operation, b);
        }
      }
      const state = { ...requested, builds: [...builds.values()] };
      await appendAudit(home, store, {
        event: 'enrollment',
        review: state.review,
        digest: digest(state),
      });
      await writeState(home, store, state);
      return state;
    },
    signal,
  );
}

/** Producer callback is host-owned code and must return its exact proven outputs. */
export async function managedBuild(home, store, recipe, build, signal) {
  return withStoreLock(
    home,
    store,
    async () => {
      const state = await readState(home, store);
      if (
        !state ||
        !recipe.review ||
        recipe.reproducible !== true ||
        !recipe.inputsDigest ||
        !state.producers.some(
          (p) =>
            p.owner === recipe.owner && p.family === recipe.family && p.coordinated && p.review,
        )
      )
        throw Error('Reviewed reproducible producer recipe required');
      if (state.builds.some((b) => b.state !== 'succeeded'))
        throw Error('Store has unresolved build operations');
      const record = {
        operation: randomUUID(),
        owner: recipe.owner,
        family: recipe.family,
        state: 'active',
        startedAt: Date.now(),
        reproducible: true,
        recipeDigest: digest(recipe),
        images: [],
      };
      state.builds.push(record);
      await writeState(home, store, state);
      await appendAudit(home, store, { event: 'build-started', ...record });
      try {
        signal?.throwIfAborted();
        const outputs = await build(signal);
        if (!Array.isArray(outputs) || !outputs.length || outputs.some((id) => !imageId.test(id)))
          throw Error('Producer returned no exact output identity');
        record.images = [...new Set(outputs)];
        record.completedAt = Date.now();
        record.state = 'succeeded';
        await writeState(home, store, state);
        await appendAudit(home, store, { event: 'build-completed', ...record });
        return record;
      } catch (error) {
        record.state = 'uncertain';
        await writeState(home, store, state);
        await appendAudit(home, store, { event: 'build-uncertain', operation: record.operation });
        throw error;
      }
    },
    signal,
  );
}
