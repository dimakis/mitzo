import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { URL } from 'node:url';
import { digest, imageId } from './podman-storage-policy.mjs';

const exec = promisify(execFile);
export async function runCommand(exe, args, signal) {
  const { stdout } = await exec(exe, args, {
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    signal,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout;
}
const normalizeId = (id) =>
  typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) ? `sha256:${id}` : id;
const array = (text) => {
  const v = JSON.parse(text);
  if (!Array.isArray(v)) throw Error('Expected complete Podman array');
  return v;
};
function prefix(selection) {
  if (selection.local === true && !selection.connection && !selection.machine)
    return ['--remote=false'];
  if (
    !selection.local &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(selection.connection ?? '') &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(selection.machine ?? '')
  )
    return ['--connection', selection.connection];
  throw Error('Select an explicit local store or machine connection');
}
function dfRow(text) {
  const rows = text.trim().split('\n');
  if (rows.length !== 2) throw Error('Ambiguous filesystem measurement');
  const parts = rows[1].trim().split(/\s+/);
  const [total, used, available] = parts.slice(1, 4).map(Number);
  if (
    !parts[0] ||
    ![total, used, available].every(Number.isSafeInteger) ||
    total <= 0 ||
    used < 0 ||
    available < 0 ||
    available > total ||
    used > total
  )
    throw Error('Invalid filesystem measurement');
  return { source: parts[0], total, available };
}
export async function measureFilesystem(path, run = runCommand) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\n\r\0]/.test(path))
    throw Error('Invalid filesystem path');
  const bytes = dfRow(await run('df', ['-k', '-P', '--', path]));
  const inodes = dfRow(await run('df', ['-i', '-P', '--', path]));
  if (bytes.source !== inodes.source) throw Error('Filesystem changed during measurement');
  return {
    status: 'available',
    measuredAt: Date.now(),
    path,
    source: bytes.source,
    totalBytes: bytes.total * 1024,
    freeBytes: bytes.available * 1024,
    totalInodes: inodes.total,
    freeInodes: inodes.available,
  };
}

/** Bounded, read-only collection. Missing evidence is never an empty success. */
export async function collectStore(
  selection,
  { run = runCommand, platform = process.platform, enrollment = null, signal } = {},
) {
  const bounded = globalThis.AbortSignal.any([
    globalThis.AbortSignal.timeout(120000),
    ...(signal ? [signal] : []),
  ]);
  const command = (exe, args) => run(exe, args, bounded);
  const s = {
    collectedAt: Date.now(),
    complete: false,
    store: null,
    images: [],
    containers: [],
    enrollment,
    blockers: [],
    telemetry: {
      guest: { status: 'unavailable' },
      host: { status: 'unavailable', reason: 'VM backing path not configured' },
    },
  };
  try {
    const p = prefix(selection);
    if ((platform !== 'linux' && selection.local) || (platform === 'linux' && !selection.local))
      throw Error('Linux uses an explicit local store; macOS requires a selected machine');
    const podman = (args) => command('podman', [...p, ...args]);
    const info = JSON.parse(await podman(['info', '--format', 'json']));
    const root = info.store?.graphRoot;
    if (
      typeof root !== 'string' ||
      !/^\/[A-Za-z0-9_./-]+$/.test(root) ||
      !info.store.graphDriverName ||
      typeof info.host?.security?.rootless !== 'boolean'
    )
      throw Error('Incomplete store identity');
    let guest = command;
    let machineIdentity = null;
    if (selection.local) {
      if (info.host.serviceIsRemote !== false)
        throw Error('Local Podman selected a remote service');
    } else {
      const connections = array(
        await command('podman', ['system', 'connection', 'list', '--format', 'json']),
      );
      const matches = connections.filter((c) => c.Name === selection.connection);
      const machines = array(await command('podman', ['machine', 'inspect', selection.machine]));
      if (matches.length !== 1 || machines.length !== 1)
        throw Error('Ambiguous selected connection or machine');
      const c = matches[0],
        m = machines[0];
      const uri = new URL(c.URI);
      if (
        !c.IsMachine ||
        m.Name !== selection.machine ||
        !m.Created ||
        !m.ConfigDir?.Path ||
        uri.protocol !== 'ssh:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname) ||
        Number(uri.port) !== m.SSHConfig?.Port ||
        c.Identity !== m.SSHConfig?.IdentityPath ||
        ![m.SSHConfig?.RemoteUsername, 'root'].includes(uri.username) ||
        uri.pathname !== info.host.remoteSocket?.path?.replace(/^unix:\/\//, '')
      )
        throw Error('Connection does not identify the selected machine/store');
      machineIdentity = {
        name: m.Name,
        created: m.Created,
        configDir: m.ConfigDir.Path,
        uri: c.URI,
        keyPath: c.Identity,
      };
      guest = (exe, args) => command('podman', ['machine', 'ssh', selection.machine, exe, ...args]);
      if (selection.hostBackingPath) {
        try {
          s.telemetry.host = await measureFilesystem(selection.hostBackingPath, command);
        } catch (error) {
          s.telemetry.host = { status: 'unavailable', reason: error.message };
        }
      }
    }
    const machineId = (await guest('cat', ['/etc/machine-id'])).trim();
    const filesystemId = (await guest('stat', ['-f', '-c', '%i', '--', root])).trim();
    const filesystemSource = (await guest('findmnt', ['-n', '-o', 'SOURCE', '-T', root])).trim();
    if (
      !machineId ||
      !filesystemId ||
      !filesystemSource ||
      /[\r\n]/.test(machineId + filesystemId + filesystemSource)
    )
      throw Error('Incomplete guest filesystem identity');
    s.store = {
      connection: selection.connection ?? 'local',
      machine: machineIdentity,
      machineId,
      filesystemId,
      filesystemSource,
      graphRoot: root,
      graphDriver: info.store.graphDriverName,
      rootless: info.host.security.rootless,
    };
    s.telemetry.guest = await measureFilesystem(root, guest);
    if (selection.local)
      s.telemetry.host = {
        status: 'not-applicable',
        reason: 'Local store has no VM backing filesystem',
      };
    const listContainers = async () =>
      array(await podman(['ps', '--all', '--external', '--format', 'json']))
        .map((c) => {
          const image = normalizeId(c.ImageID);
          if (!c.Id || !imageId.test(image))
            throw Error('Incomplete container or external build image reference');
          return { id: c.Id, image };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    const listImages = async () =>
      [
        ...new Set(
          array(await podman(['images', '--all', '--no-trunc', '--format', 'json'])).map((i) =>
            normalizeId(i.Id),
          ),
        ),
      ].sort();
    s.containers = await listContainers();
    const ids = await listImages();
    if (ids.some((id) => !imageId.test(id))) throw Error('Incomplete image identity');
    for (let n = 0; n < ids.length; n += 50) {
      const batch = ids.slice(n, n + 50);
      const inspected = array(await podman(['image', 'inspect', ...batch])).map((i) => ({
        id: normalizeId(i.Id),
        parent: i.Parent === '' ? '' : normalizeId(i.Parent),
        layers: i.RootFS?.Layers,
      }));
      if (digest(inspected.map((i) => i.id).sort()) !== digest(batch))
        throw Error('Partial image inspection');
      s.images.push(...inspected);
    }
    if (
      digest(await listContainers()) !== digest(s.containers) ||
      digest(await listImages()) !== digest(ids)
    )
      throw Error('Inventory changed during collection');
    const endInfo = JSON.parse(await podman(['info', '--format', 'json']));
    if (
      endInfo.store?.graphRoot !== root ||
      endInfo.store?.graphDriverName !== s.store.graphDriver ||
      endInfo.host?.security?.rootless !== s.store.rootless ||
      endInfo.host?.remoteSocket?.path !== info.host.remoteSocket?.path
    )
      throw Error('Store changed during collection');
    s.complete = true;
  } catch (error) {
    s.blockers.push(error instanceof Error ? error.message : 'Collection failed');
  }
  return s;
}

export async function removeImage(selection, id, run = runCommand, signal) {
  if (!imageId.test(id)) throw Error('Removal requires an immutable image ID');
  try {
    await run('podman', [...prefix(selection), 'image', 'rm', '--no-prune', id], signal);
    return { code: 0 };
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 125,
      detail: error instanceof Error ? error.message : 'Removal failed',
    };
  }
}
