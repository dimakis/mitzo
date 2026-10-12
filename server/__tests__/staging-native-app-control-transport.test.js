import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import process from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({
  files: new Map(),
  accepted: undefined,
  server: undefined,
  clients: [],
  corruptResponse: false,
  peerDenied: false,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original();
  const stat = (path) => ({
    isDirectory: () => !state.files.has(path) && !path.endsWith('.sock'),
    isSocket: () => path.endsWith('.sock'),
    isFile: () => state.files.has(path),
    isSymbolicLink: () => false,
    uid: process.getuid(),
    nlink: 1,
    dev: 1,
    ino: 11,
    mode: state.files.has(path) ? 0o100400 : path.endsWith('.sock') ? 0o140600 : 0o40700,
    size: state.files.get(path)?.length ?? 0,
  });
  return {
    ...fs,
    realpathSync: (path) => path,
    lstatSync: stat,
    fstatSync: stat,
    openSync: (path) => path,
    closeSync() {},
    fsyncSync() {},
    mkdirSync() {},
    chmodSync() {},
    readFileSync: (path) => state.files.get(path),
    writeFileSync: (path, body) => {
      if (state.files.has(path)) throw Error('exclusive');
      state.files.set(path, body);
    },
  };
});
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  const { Buffer } = await import('node:buffer');
  class Socket extends EventEmitter {
    destroyed = false;
    setTimeout() {
      return this;
    }
    write(body) {
      if (this.serverSide && state.corruptResponse && String(body).includes('signature')) {
        const frame = JSON.parse(body);
        frame.signature = '0'.repeat(64);
        body = JSON.stringify(frame) + '\n';
      }
      globalThis.queueMicrotask(() => this.other.emit('data', Buffer.from(body)));
      return true;
    }
    end(body) {
      if (body) this.write(body);
      globalThis.setImmediate(() => this.destroy());
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('close');
      if (!this.other.destroyed) {
        this.other.destroyed = true;
        this.other.emit('close');
      }
    }
  }
  return {
    createServer(accepted) {
      state.accepted = accepted;
      const server = new EventEmitter();
      server.listen = (_, done) => globalThis.queueMicrotask(done);
      server.close = () => {};
      state.server = server;
      return server;
    },
    createConnection() {
      const client = new Socket(),
        server = new Socket();
      server.serverSide = true;
      client.other = server;
      server.other = client;
      state.clients.push(client, server);
      globalThis.queueMicrotask(() => {
        state.accepted(server);
        client.emit('connect');
      });
      return client;
    },
  };
});
vi.mock('node:child_process', () => ({
  spawnSync: () => ({ status: 0, stdout: state.command, stderr: '' }),
}));
vi.mock('../../scripts/lib/staging-vm-peer.mjs', () => ({
  createDarwinVmPeerInspector: () => ({
    async observePeer(socket) {
      if (state.peerDenied) throw Error('missing actual peer');
      return this.observeProcess(socket.serverSide ? process.pid + 10 : process.pid);
    },
    observeProcess(pid) {
      return {
        pid,
        kernelBirth: 'actual-fixture-' + pid,
        uid: process.getuid(),
        executable: process.execPath,
      };
    },
  }),
}));
vi.mock('../../scripts/lib/staging-cold-control.mjs', () => ({
  verifyPreparedController: vi.fn(),
}));
vi.mock('../../scripts/lib/staging-pipeline-mutation-guard.mjs', () => ({
  assertStagingPipelineMutation({ proof }) {
    if (proof !== 'live-private-run') throw Error('queue lost');
  },
}));
import {
  createOriginalNativeAppControlServer,
  requestOriginalNativeAppControl,
} from '../../scripts/lib/staging-native-app-control-transport.mjs';
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const root = join(homedir(), '.local/share/mitzo-staging');
const allocation = '11111111-1111-1111-1111-111111111111';
const nativeSourceCommit = 'a'.repeat(40);
const nativeSourceRoot = join(root, 'releases', nativeSourceCommit.slice(0, 12));
const input = {
  version: 1,
  operation: 'resources',
  target: 'b'.repeat(40),
  expectedCurrent: nativeSourceCommit,
  planSha256: null,
  queueProof: 'live-private-run',
};
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  state.files.clear();
  state.clients = [];
  state.corruptResponse = false;
  state.peerDenied = false;
  state.command = `${process.execPath} ${join(nativeSourceRoot, 'scripts/staging-native-app-control.mjs')} --allocation ${allocation} --operation resources --target ${input.target} --expected-current ${input.expectedCurrent} --plan-sha256 none`;
});
afterEach(() => {
  for (const socket of state.clients) socket.destroy();
  Object.defineProperty(process, 'platform', platform);
});
async function fixture() {
  const operation = vi.fn(async () => ({ version: 1, observation: 'actual-controlled-response' }));
  const server = createOriginalNativeAppControlServer({
    root,
    allocation,
    nativeSourceRoot,
    nativeSourceCommit,
    approvedPeerInspector: {},
    assertOriginalCurrent() {},
    operations: { resources: operation, plan: operation, apply: operation },
  });
  await server.listen();
  const phases = [];
  const request = () =>
    requestOriginalNativeAppControl({
      root,
      allocation,
      input,
      approvedPeerInspector: {},
      assertServerCurrent(_, context) {
        phases.push(context);
      },
    });
  return { server, operation, phases, request };
}
it('pairs actual finite MAC framing with before-request and authenticated after-response physical phases', async () => {
  const f = await fixture();
  expect(await f.request()).toEqual({ version: 1, observation: 'actual-controlled-response' });
  expect(f.operation).toHaveBeenCalledTimes(1);
  expect(
    f.phases
      .filter((context) => context.phase === 'before-request')
      .every((value) => !('output' in value)),
  ).toBe(true);
  expect(f.phases.at(-1)).toEqual({
    phase: 'after-response',
    output: { version: 1, observation: 'actual-controlled-response' },
  });
  f.server.fence();
});
it('refuses a corrupted response MAC before exposing output to after-response physical qualification', async () => {
  const f = await fixture();
  state.corruptResponse = true;
  await expect(f.request()).rejects.toThrow();
  expect(f.phases.some((context) => context.phase === 'after-response')).toBe(false);
  f.server.fence();
});
it('refuses a missing peer and absorbs a caller reset without crashing the original parent or dispatching effects', async () => {
  const f = await fixture();
  state.peerDenied = true;
  const result = f.request();
  await expect(result).rejects.toThrow();
  const serverSocket = state.clients.find((socket) => socket.serverSide);
  expect(() => serverSocket.emit('error', Error('private caller reset'))).not.toThrow();
  expect(f.operation).not.toHaveBeenCalled();
  f.server.fence();
});
