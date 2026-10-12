import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  fsyncSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createDarwinVmPeerInspector } from './staging-vm-peer.mjs';
import { assertStagingPipelineMutation } from './staging-pipeline-mutation-guard.mjs';
import { verifyPreparedController } from './staging-cold-control.mjs';
const refuse = () =>
  Error('Original private native app control unavailable; preserve owner and uncertainty');
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const commit = /^[a-f0-9]{40}$/;
const mac = (key, challenge, body) =>
  createHmac('sha256', key)
    .update(challenge + '\n' + body)
    .digest('hex');
function synchronous(fn) {
  const result = fn();
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => {});
    throw refuse();
  }
}
function paths(root, allocation) {
  if (root !== join(homedir(), '.local/share/mitzo-staging') || !uuid.test(allocation))
    throw refuse();
  return {
    parent: '/private/tmp/mitzo-app-' + allocation,
    socket: '/private/tmp/mitzo-app-' + allocation + '/control.sock',
    key: join(root, 'symposium/allocations', allocation, 'service/app-control.key'),
  };
}
function privateKey(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd),
      named = lstatSync(path),
      body = readFileSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      (s.mode & 0o777) !== 0o400 ||
      s.size !== 32 ||
      body.length !== 32 ||
      named.dev !== s.dev ||
      named.ino !== s.ino ||
      realpathSync(path) !== path
    )
      throw refuse();
    return { body, identity: [s.dev, s.ino, s.uid, s.mode, s.nlink].join(':') };
  } finally {
    closeSync(fd);
  }
}
function parent(path) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw refuse();
  return [s.dev, s.ino].join(':');
}
function request(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !==
      'expectedCurrent,operation,planSha256,queueProof,target,version' ||
    value.version !== 1 ||
    !['resources', 'plan', 'apply'].includes(value.operation) ||
    !commit.test(value.target) ||
    !commit.test(value.expectedCurrent) ||
    (value.operation === 'apply'
      ? !/^[a-f0-9]{64}$/.test(value.planSha256)
      : value.planSha256 !== null) ||
    typeof value.queueProof !== 'string' ||
    !value.queueProof.length ||
    value.queueProof.length > 2048
  )
    throw refuse();
  return Object.freeze({ ...value });
}
/** The original actual custodian retains this listener. The source-pinned C
 * helper observes the real connected kernel peer; JSON PID/source declarations
 * and the private MAC alone cannot authorize an operation. No host action occurs
 * until the actual actor explicitly invokes listen after its running proof. */
export function createOriginalNativeAppControlServer({
  root,
  allocation,
  nativeSourceRoot,
  nativeSourceCommit,
  approvedPeerInspector,
  assertOriginalCurrent,
  operations,
}) {
  const p = paths(root, allocation);
  if (
    process.platform !== 'darwin' ||
    nativeSourceRoot !== join(root, 'releases', nativeSourceCommit.slice(0, 12)) ||
    !commit.test(nativeSourceCommit) ||
    typeof assertOriginalCurrent !== 'function' ||
    Object.keys(operations ?? {})
      .sort()
      .join() !== 'apply,plan,resources' ||
    Object.values(operations).some((fn) => typeof fn !== 'function')
  )
    throw refuse();
  const current = () => synchronous(assertOriginalCurrent);
  const peer = createDarwinVmPeerInspector({ ...approvedPeerInspector, assertCurrent: current });
  let listening = false,
    fenced = false,
    busy = false,
    capturedKey,
    parentIdentity,
    socketIdentity;
  const clients = new Set();
  const retained = () => {
    if (fenced || !listening || !capturedKey || parent(p.parent) !== parentIdentity) throw refuse();
    current();
    const key = privateKey(p.key);
    if (key.identity !== capturedKey.identity || !key.body.equals(capturedKey.body)) throw refuse();
    const s = lstatSync(p.socket);
    if (
      !s.isSocket() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o600 ||
      [s.dev, s.ino].join(':') !== socketIdentity
    )
      throw refuse();
    current();
  };
  const server = createServer((socket) => {
    if (clients.size >= 2) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.setTimeout(180000, () => socket.destroy());
    let text = '',
      received = false;
    const ready = (async () => {
      retained();
      const original = await peer.observePeer(socket);
      retained();
      if (original.executable !== process.execPath) throw refuse();
      const challenge = randomBytes(32).toString('hex');
      socket.write(JSON.stringify({ version: 1, challenge }) + '\n');
      return { original, challenge };
    })();
    void ready.catch(() => socket.destroy());
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (received || Buffer.byteLength(text) > 8192) {
        socket.destroy();
        return;
      }
      if (!text.includes('\n')) return;
      received = true;
      void (async () => {
        const { original, challenge } = await ready;
        if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw refuse();
        const frame = JSON.parse(text);
        if (
          Object.keys(frame).sort().join() !== 'body,signature' ||
          typeof frame.body !== 'string' ||
          !/^[a-f0-9]{64}$/.test(frame.signature)
        )
          throw refuse();
        const expected = mac(capturedKey.body, challenge, frame.body);
        if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(frame.signature, 'hex')))
          throw refuse();
        const input = request(JSON.parse(frame.body));
        const argv =
          process.execPath +
          ' ' +
          join(nativeSourceRoot, 'scripts/staging-native-app-control.mjs') +
          ' --allocation ' +
          allocation +
          ' --operation ' +
          input.operation +
          ' --target ' +
          input.target +
          ' --expected-current ' +
          input.expectedCurrent +
          ' --plan-sha256 ' +
          (input.planSha256 ?? 'none');
        const assertCallerCurrent = () => {
          retained();
          if (socket.destroyed) throw refuse();
          const actual = peer.observeProcess(original.pid);
          if (
            actual.pid !== original.pid ||
            actual.kernelBirth !== original.kernelBirth ||
            actual.uid !== original.uid ||
            actual.executable !== original.executable
          )
            throw refuse();
          const result = spawnSync('/bin/ps', ['-p', String(original.pid), '-o', 'command='], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 8192,
            env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
          });
          if (result.error || result.signal || result.status !== 0 || result.stdout.trim() !== argv)
            throw refuse();
          verifyPreparedController(root, nativeSourceRoot, nativeSourceCommit);
          // Missing/expired/quarantined queue never permits a native transition.
          const queue = join(homedir(), '.local/share/mitzo-staging-pipeline/queue.db');
          if (!lstatSync(queue, { throwIfNoEntry: false })) throw refuse();
          assertStagingPipelineMutation({
            target: input.target,
            apply: input.operation === 'apply',
            proof: input.queueProof,
          });
          retained();
        };
        assertCallerCurrent();
        if (busy) throw refuse();
        busy = true;
        try {
          const output = await operations[input.operation](input, assertCallerCurrent);
          assertCallerCurrent();
          const response = JSON.stringify({ version: 1, output });
          if (Buffer.byteLength(response) > 32700) throw refuse();
          socket.end(
            JSON.stringify({
              body: response,
              signature: mac(capturedKey.body, challenge, response),
            }) + '\n',
          );
        } finally {
          busy = false;
        }
      })().catch(() => socket.destroy());
    });
  });
  server.on('error', () => {
    fenced = true;
  });
  return Object.freeze({
    async listen() {
      current();
      if (listening || fenced) throw refuse();
      listening = true; // One attempt; any uncertain side effect remains retained.
      try {
        parent(join(root, 'symposium/allocations', allocation, 'service'));
        mkdirSync(p.parent, { mode: 0o700 });
        parentIdentity = parent(p.parent);
        writeFileSync(p.key, randomBytes(32), { flag: 'wx', mode: 0o400 });
        const fd = openSync(p.key, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        capturedKey = privateKey(p.key);
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(p.socket, resolve);
        });
        chmodSync(p.socket, 0o600);
        const observedSocket = lstatSync(p.socket);
        socketIdentity = [observedSocket.dev, observedSocket.ino].join(':');
        retained();
      } catch (error) {
        fenced = true;
        throw error;
      }
    },
    fence() {
      fenced = true;
      for (const socket of clients) socket.destroy();
      server.close();
    },
  });
}
/** Exact retained-source CLI only. Its private key is insufficient authority;
 * the server independently observes actual process birth/executable/argv/source
 * and the live private queue at every dispatched effect. */
export async function requestOriginalNativeAppControl({
  root,
  allocation,
  input,
  approvedPeerInspector,
  assertServerCurrent,
}) {
  const p = paths(root, allocation),
    normalized = request(input);
  if (typeof assertServerCurrent !== 'function') throw refuse();
  parent(p.parent);
  const key = privateKey(p.key),
    body = JSON.stringify(normalized);
  return await new Promise((resolve, reject) => {
    const socket = createConnection(p.socket);
    const peer = createDarwinVmPeerInspector({
      ...approvedPeerInspector,
      assertCurrent: () => {
        parent(p.parent);
      },
    });
    let original,
      challenge,
      text = '',
      challenged = false,
      finished = false,
      processing = false;
    const fail = () => {
      if (!finished) {
        finished = true;
        socket.destroy();
        reject(refuse());
      }
    };
    socket.setTimeout(180000, fail);
    socket.once('error', fail);
    socket.once('close', () => {
      if (!finished) fail();
    });
    const serverCurrent = (phase = 'before-request', output) => {
      if (!original || socket.destroyed) throw refuse();
      const observed = peer.observeProcess(original.pid);
      if (
        observed.kernelBirth !== original.kernelBirth ||
        observed.executable !== original.executable ||
        observed.uid !== original.uid
      )
        throw refuse();
      synchronous(() =>
        assertServerCurrent(observed, { phase, ...(phase === 'after-response' ? { output } : {}) }),
      );
    };
    const ready = new Promise((done, denied) =>
      socket.once('connect', () => {
        void peer
          .observePeer(socket)
          .then((observed) => {
            original = observed;
            serverCurrent();
            done();
          })
          .catch(denied);
      }),
    );
    void ready.catch(fail);
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > 65536) {
        fail();
        return;
      }
      const newline = text.indexOf('\n');
      if (newline === -1) return;
      if (processing || newline !== text.length - 1) {
        fail();
        return;
      }
      processing = true;
      const frameText = text;
      text = '';
      void (async () => {
        try {
          await ready;
          const frame = JSON.parse(frameText.slice(0, -1));
          if (!challenged) {
            serverCurrent('before-request');
            if (
              Object.keys(frame).sort().join() !== 'challenge,version' ||
              frame.version !== 1 ||
              !/^[a-f0-9]{64}$/.test(frame.challenge)
            )
              throw refuse();
            const again = privateKey(p.key);
            if (again.identity !== key.identity || !again.body.equals(key.body)) throw refuse();
            challenged = true;
            challenge = frame.challenge;
            socket.write(
              JSON.stringify({ body, signature: mac(key.body, frame.challenge, body) }) + '\n',
            );
          } else {
            if (
              Object.keys(frame).sort().join() !== 'body,signature' ||
              typeof frame.body !== 'string' ||
              !/^[a-f0-9]{64}$/.test(frame.signature) ||
              !timingSafeEqual(
                Buffer.from(mac(key.body, challenge, frame.body), 'hex'),
                Buffer.from(frame.signature, 'hex'),
              )
            )
              throw refuse();
            const response = JSON.parse(frame.body);
            if (Object.keys(response).sort().join() !== 'output,version' || response.version !== 1)
              throw refuse();
            // Only the authenticated envelope can reach this phase. The client
            // still independently qualifies actual new physical child identity.
            serverCurrent('after-response', response.output);
            finished = true;
            socket.end();
            resolve(response.output);
          }
        } catch {
          fail();
        } finally {
          processing = false;
        }
      })();
    });
  });
}
