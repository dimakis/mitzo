// CI-only kernel fixture: no VM, launchd, credentials, or model dispatch.
import { createServer, createConnection } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
const executable = process.argv[2];
assert(executable?.startsWith('/'));
const root = mkdtempSync(join(tmpdir(), 'mitzo-peer-fixture-'));
const path = join(root, 'peer.sock');
const server = createServer();
let client, socket;
const deadline = setTimeout(() => {
  socket?.destroy();
  client?.destroy();
  server.close();
  process.exitCode = 1;
}, 10000);
try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(path, done);
  });
  const accepted = new Promise((done) => server.once('connection', done));
  client = createConnection({ path });
  socket = await accepted;
  const result = await new Promise((done, reject) => {
    const child = spawn(executable, ['peer'], { stdio: [socket, 'pipe', 'pipe'] });
    let out = '',
      err = '';
    child.stdout.on('data', (b) => {
      out += b;
    });
    child.stderr.on('data', (b) => {
      err += b;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal(err, '');
      done(JSON.parse(out));
    });
  });
  assert.equal(result.pid, process.pid);
  assert.equal(result.uid, process.getuid());
  const inspected = spawnSync(executable, ['process', String(process.pid)], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(inspected.status, 0);
  assert.equal(JSON.parse(inspected.stdout).kernelBirth, result.kernelBirth);
  assert.equal(JSON.parse(inspected.stdout).executable, result.executable);
  const fakePeer = spawnSync(executable, ['peer'], {
    encoding: 'utf8',
    timeout: 5000,
    input: '{"pid":1}',
  });
  // Node's child pipe is a real AF_UNIX socket pair. The helper correctly
  // measures its kernel peer and ignores the untrusted JSON bytes entirely.
  assert.equal(fakePeer.status, 0);
  assert.equal(JSON.parse(fakePeer.stdout).pid, process.pid);
  assert.notEqual(JSON.parse(fakePeer.stdout).pid, 1);
  const nonSocket = spawnSync(executable, ['peer'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(nonSocket.status, 0);
} finally {
  clearTimeout(deadline);
  socket?.destroy();
  client?.destroy();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
