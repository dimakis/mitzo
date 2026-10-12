#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  lstatSync,
  chmodSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import {
  createFreshAppleHvPlan,
  inspectFreshAppleHvInputs,
  observeFreshAppleHvProcess,
} from './lib/staging-fresh-applehv.mjs';

const refuse = () => {
  throw Error('Original fresh VM supervisor authority unavailable; retain native uncertainty');
};
export function parseFreshAppleHvSupervisorArguments(args) {
  if (
    args.length !== 4 ||
    args[0] !== '--plan' ||
    args[2] !== '--guard' ||
    !args[1].startsWith('/') ||
    resolve(args[1]) !== args[1] ||
    !args[3].startsWith('/private/tmp/') ||
    resolve(args[3]) !== args[3]
  )
    refuse();
  return { planPath: args[1], guardPath: args[3] };
}
function readPlan(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 262144
    )
      refuse();
    return createFreshAppleHvPlan(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function processes() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1048576,
  });
  if (r.status !== 0 || r.error || r.signal) refuse();
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const m = row.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) refuse();
      return { pid: Number(m[1]), parentPid: Number(m[2]), command: m[3] };
    });
}
async function startPodman(approved) {
  const p = approved.plan,
    podmanPin = p.helpers.find((h) => h.kind === 'podman'),
    startedAt = Date.now();
  const child = spawn(podmanPin.path, ['machine', 'start', p.qualification.machineName], {
    cwd: p.nativeRoot,
    env: p.qualification.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ended = false,
    exitCode,
    childError,
    outputBytes = 0,
    podman,
    vfkit,
    gvproxy;
  child.once('error', (e) => {
    childError = e;
    ended = true;
  });
  child.once('exit', (code) => {
    exitCode = code;
    ended = true;
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (bytes) => {
      outputBytes += bytes.length;
    });
  while (!ended && Date.now() - startedAt < 180000) {
    if (child.pid && !podman) podman = observeFreshAppleHvProcess(child.pid);
    for (const row of processes().filter((row) => row.parentPid === child.pid)) {
      if (!vfkit && row.command.startsWith(p.helpers.find((h) => h.kind === 'vfkit').path + ' '))
        vfkit = observeFreshAppleHvProcess(row.pid);
      if (
        !gvproxy &&
        row.command.startsWith(p.helpers.find((h) => h.kind === 'gvproxy').path + ' ')
      )
        gvproxy = observeFreshAppleHvProcess(row.pid);
    }
    if (outputBytes > 65536) refuse();
    await delay(50);
  }
  // Never signal a timed-out child or replay an uncertain command.
  if (
    !ended ||
    exitCode !== 0 ||
    childError ||
    !podman ||
    !vfkit ||
    !gvproxy ||
    podman.command !== podmanPin.path + ' machine start ' + p.qualification.machineName
  )
    refuse();
  const socket = lstatSync(p.qualification.apiSocket);
  if (!socket.isSocket() || socket.uid !== process.getuid() || socket.nlink !== 1) refuse();
  chmodSync(p.qualification.apiSocket, 0o600);
  const after = lstatSync(p.qualification.apiSocket);
  if (after.dev !== socket.dev || after.ino !== socket.ino || (after.mode & 0o777) !== 0o600)
    refuse();
  const guest = spawnSync(
    podmanPin.path,
    ['machine', 'ssh', p.qualification.machineName, 'cat', '/proc/sys/kernel/random/boot_id'],
    {
      env: p.qualification.environment,
      cwd: p.nativeRoot,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024,
    },
  );
  const guestBootUUID = guest.stdout?.trim();
  if (
    guest.status !== 0 ||
    guest.error ||
    guest.signal ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(guestBootUUID)
  )
    refuse();
  return {
    podman,
    vfkit,
    gvproxy,
    startedAt,
    guestBootUUID,
    apiSocket: { dev: after.dev, ino: after.ino },
  };
}
/** Trusted dependency injection is for offline tests. The real CLI builds its
 * channel only to the actual original controller's private live socket. JSON
 * plans, launchd registration, and a version string never grant this start. */
export async function superviseFreshAppleHvVm(approved, requestGuard, effects = {}) {
  const verifyInputs = effects.verifyInputs ?? (() => inspectFreshAppleHvInputs(approved));
  const currentSupervisor =
    effects.currentSupervisor ?? (() => observeFreshAppleHvProcess(process.pid));
  await verifyInputs();
  const supervisor = currentSupervisor();
  const ack = await requestGuard({
    kind: 'authorize',
    pid: supervisor.pid,
    planSha256: approved.sha256,
  });
  if (ack?.kind !== 'authorized' || ack.planSha256 !== approved.sha256) refuse();
  await verifyInputs();
  const current = await requestGuard({
    kind: 'current',
    pid: supervisor.pid,
    birth: supervisor.birth,
    planSha256: approved.sha256,
  });
  if (current?.kind !== 'current') refuse();
  const started = await (effects.startPodman ?? (() => startPodman(approved)))();
  const lineage = { ...started, supervisor };
  const saved = await requestGuard({ kind: 'running', lineage });
  if (saved?.kind !== 'recorded') refuse();
  return lineage;
}
async function guardedChannel(approved, guardPath) {
  const socketStat = lstatSync(guardPath);
  if (
    !socketStat.isSocket() ||
    socketStat.uid !== process.getuid() ||
    (socketStat.mode & 0o777) !== 0o600 ||
    guardPath !== approved.plan.qualification.guardSocket
  )
    refuse();
  const socket = createConnection(guardPath);
  socket.setEncoding('utf8');
  const requests = [];
  let buffer = '',
    closed = false;
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 65536) {
      socket.destroy();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const row = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        requests.shift()?.resolve(JSON.parse(row));
      } catch {
        socket.destroy();
      }
    }
  });
  const lost = () => {
    closed = true;
    for (const request of requests.splice(0))
      request.reject(Error('Original controller channel lost'));
  };
  socket.on('error', lost);
  socket.on('close', lost);
  return {
    socket,
    request: (message) =>
      new Promise((resolveRequest, rejectRequest) => {
        if (closed) {
          rejectRequest(Error('Original controller channel lost'));
          return;
        }
        const timer = setTimeout(() => {
          rejectRequest(Error('Original controller response uncertain'));
          socket.destroy();
        }, 180000);
        requests.push({
          resolve: (value) => {
            clearTimeout(timer);
            resolveRequest(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            rejectRequest(error);
          },
        });
        socket.write(JSON.stringify(message) + '\n');
      }),
  };
}
async function main() {
  if (process.argv.slice(2).join() === '--help') {
    console.log('Registered canonical fresh VM supervisor; no manual start or JSON reopen.');
    return;
  }
  process.umask(0o077);
  const { planPath, guardPath } = parseFreshAppleHvSupervisorArguments(process.argv.slice(2)),
    approved = readPlan(planPath);
  if (
    planPath !== approved.plan.supervisor.programArguments[3] ||
    process.execPath !== approved.plan.node.path
  )
    refuse();
  const channel = await guardedChannel(approved, guardPath);
  try {
    const lineage = await superviseFreshAppleHvVm(approved, channel.request);
    while (!channel.socket.destroyed) {
      await delay(5000);
      const ack = await channel.request({
        kind: 'current',
        pid: lineage.supervisor.pid,
        birth: lineage.supervisor.birth,
        planSha256: approved.sha256,
      });
      if (ack?.kind !== 'current') refuse();
      if (ack.normalRetirement === true) return; // Only the original controller's live drain path can request this.
      for (const original of [lineage.vfkit, lineage.gvproxy]) {
        const now = observeFreshAppleHvProcess(original.pid);
        if (now.birth !== original.birth || now.command !== original.command) refuse();
      }
    }
    refuse(); // Channel loss retains a running VM; it never stops or restarts it.
  } finally {
    channel.socket.destroy();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      'Fresh VM supervisor refused or uncertain; retain the original allocation and operation.',
    );
    process.exitCode = 1;
  });
