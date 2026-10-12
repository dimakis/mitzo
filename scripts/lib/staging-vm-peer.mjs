import { spawn, spawnSync } from 'node:child_process';
import { constants, openSync, fstatSync, readFileSync, closeSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import process from 'node:process';
import { resolve, dirname } from 'node:path';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';

const refuse = () => {
  throw Error('Original kernel VM peer or process lineage unavailable; retain capacity');
};
function checkedObservation(r, uid) {
  if (
    !r ||
    !Number.isSafeInteger(r.pid) ||
    r.pid < 2 ||
    !Number.isSafeInteger(r.ppid) ||
    r.ppid < 1 ||
    r.uid !== uid ||
    r.peerUid !== uid ||
    !/^\d+:\d{1,6}$/.test(r.kernelBirth) ||
    !r.executable?.startsWith('/')
  )
    refuse();
  return Object.freeze({ ...r });
}
function same(a, b) {
  return (
    a.pid === b.pid &&
    a.uid === b.uid &&
    a.kernelBirth === b.kernelBirth &&
    a.executable === b.executable
  );
}

/** Read-only observations, not authorization. The binary must be compiled from
 * accepted source and measured in the approved plan; this module never builds it. */
export function createDarwinVmPeerInspector({
  path,
  sha256,
  assertCurrent,
  uid = process.getuid(),
}) {
  if (
    process.platform !== 'darwin' ||
    resolve(path) !== path ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof assertCurrent !== 'function'
  )
    refuse();
  function check() {
    assertCurrent();
    for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022) refuse();
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        s.mode & 0o022 ||
        !(s.mode & 0o100) ||
        (s.uid !== uid && s.uid !== 0) ||
        s.size > 1048576 ||
        createHash('sha256').update(readFileSync(fd)).digest('hex') !== sha256
      )
        refuse();
    } finally {
      closeSync(fd);
    }
  }
  function parse(stdout) {
    check();
    return checkedObservation(JSON.parse(stdout), uid);
  }
  return Object.freeze({
    observeProcess(pid) {
      if (!Number.isSafeInteger(pid) || pid < 2) refuse();
      check();
      const result = spawnSync(path, ['process', String(pid)], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 8192,
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status !== 0 || result.signal || result.error || result.stderr) refuse();
      return parse(result.stdout);
    },
    async observePeer(socket) {
      if (!(socket instanceof Socket) || socket.destroyed || !socket.readable || !socket.writable)
        refuse();
      check();
      // Documented child stdio Stream duplication passes the actual connected FD;
      // no private Node _handle or a caller-supplied FD/PID is used.
      return await new Promise((done, reject) => {
        let output = '',
          errorOutput = '',
          failed = false;
        const child = spawn(path, ['peer'], {
          stdio: [socket, 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin' },
        });
        const fail = () => {
          failed = true;
          reject(Error('Kernel peer observation failed'));
        };
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          fail();
        }, 5000);
        child.once('error', fail);
        child.stdout.on('data', (b) => {
          output += b;
          if (Buffer.byteLength(output) > 8192) {
            child.kill('SIGTERM');
            fail();
          }
        });
        child.stderr.on('data', (b) => {
          errorOutput += b;
          if (Buffer.byteLength(errorOutput) > 8192) {
            child.kill('SIGTERM');
            fail();
          }
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          if (failed) return;
          try {
            if (code !== 0 || signal || errorOutput || socket.destroyed) refuse();
            done(parse(output));
          } catch (e) {
            reject(e);
          }
        });
      });
    },
  });
}

/** Must run in the original controller, before it authorizes the stock start.
 * A later JSON report cannot recreate this captured live parentage. */
export function createOriginalVmStartLineageObserver({
  supervisor,
  podman,
  vfkit,
  gvproxy,
  uid,
  assertCurrent,
  observePeer,
  observeProcess,
  listProcesses,
}) {
  const pins = { supervisor, podman, vfkit, gvproxy };
  for (const pin of Object.values(pins)) if (!pin?.path?.startsWith('/')) refuse();
  let captured = {},
    finished = false,
    lost = false;
  const current = () => {
    if (lost) refuse();
    assertCurrent();
  };
  const inspect = (pid) => checkedObservation(observeProcess(pid), uid);
  function capture(kind, r) {
    if (r.executable !== pins[kind].path) refuse();
    if (captured[kind] && !same(captured[kind], r)) refuse();
    captured[kind] ??= r;
  }
  function rows() {
    const result = listProcesses();
    if (!Array.isArray(result) || result.length > 32768) refuse();
    return result;
  }
  return Object.freeze({
    async captureSupervisor(socket) {
      current();
      if (captured.supervisor || finished) refuse();
      const r = checkedObservation(await observePeer(socket), uid);
      current();
      const actual = inspect(r.pid);
      if (
        !same(r, actual) ||
        actual.ppid !== 1 ||
        rows().find((p) => p.pid === r.pid)?.command !== supervisor.argv
      )
        refuse();
      capture('supervisor', actual);
      return actual;
    },
    captureStart() {
      current();
      if (!captured.supervisor || finished) refuse();
      if (!same(inspect(captured.supervisor.pid), captured.supervisor)) refuse();
      const all = rows();
      if (!captured.podman) {
        const candidates = all.filter(
          (p) => p.ppid === captured.supervisor.pid && p.command === podman.argv,
        );
        if (candidates.length > 1) refuse();
        if (!candidates.length) return;
        const r = inspect(candidates[0].pid);
        if (r.ppid !== captured.supervisor.pid) refuse();
        capture('podman', r);
      }
      // Parent must still physically exist during helper capture. If it exited
      // before polling, retain uncertainty rather than adopting orphan helpers.
      const parent = inspect(captured.podman.pid);
      if (!same(parent, captured.podman) || parent.ppid !== captured.supervisor.pid) refuse();
      for (const kind of ['vfkit', 'gvproxy']) {
        if (captured[kind]) continue;
        const candidates = all.filter(
          (p) => p.ppid === parent.pid && p.command.startsWith(pins[kind].path + ' '),
        );
        if (candidates.length > 1) refuse();
        if (candidates.length === 1) {
          const r = inspect(candidates[0].pid);
          if (r.ppid !== parent.pid) refuse();
          capture(kind, r);
        }
      }
      if (!same(inspect(parent.pid), parent)) refuse();
      current();
    },
    finish(reported) {
      current();
      if (finished) refuse();
      for (const kind of Object.keys(pins)) {
        if (!captured[kind] || reported?.[kind]?.pid !== captured[kind].pid) refuse();
        if (kind !== 'podman' && !same(inspect(captured[kind].pid), captured[kind])) refuse();
      }
      finished = true;
      captured = Object.freeze({ ...captured });
      return captured;
    },
    assertCurrent() {
      current();
      if (!finished) refuse();
      for (const kind of ['supervisor', 'vfkit', 'gvproxy']) {
        const r = inspect(captured[kind].pid);
        if (
          !same(r, captured[kind]) ||
          (kind === 'supervisor' ? r.ppid !== 1 : r.ppid !== captured.podman.pid && r.ppid !== 1)
        )
          refuse();
      }
      return captured;
    },
    retain() {
      lost = true;
    },
  });
}
