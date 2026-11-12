import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { expect, test, vi } from 'vitest';
import { observeJoinedFixtureProcesses } from './joined-fixture-processes.mjs';
import { createJoinedChildProxy } from './joined-child-proxy';

test('child proxy releases a cancelled request before upstream response headers arrive', async () => {
  let pendingSocket: Socket | undefined;
  const backend = createServer((req, res) => {
    if (req.url === '/pending') pendingSocket = req.socket;
    else res.end('owned child response');
  });
  const listen = async (server: Server) => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Private test port required');
    return address.port;
  };
  let target: number | undefined;
  const proxy = createServer(createJoinedChildProxy(() => target));
  let client: ReturnType<typeof request> | undefined;
  try {
    target = await listen(backend);
    const port = await listen(proxy);
    const body = await new Promise<string>((done, reject) => {
      request({ hostname: '127.0.0.1', port, path: '/complete' }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => done(text));
        res.on('error', reject);
      })
        .on('error', reject)
        .end();
    });
    expect(body).toBe('owned child response');
    client = request({ hostname: '127.0.0.1', port, path: '/pending' });
    client.on('error', () => {});
    client.end();
    await vi.waitFor(() => expect(pendingSocket).toBeDefined());
    client.destroy();
    // Disposal must not depend on a response that the cancelled browser will never read.
    await vi.waitFor(() => expect(pendingSocket!.destroyed).toBe(true), { timeout: 1_000 });
  } finally {
    target = undefined;
    client?.destroy();
    for (const server of [proxy, backend]) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    }
  }
});

test('final disposal joins a detached writer through close before removing its fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joined-fixture-writer-'));
  const processes = observeJoinedFixtureProcesses();
  let child: ChildProcess | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      process.stdout.write('ready');
      process.stdin.once('data', () => {
        fs.writeFileSync(process.argv[1], 'last canonical sidecar');
        process.exit(0);
      });
    `,
        join(root, 'late-sidecar'),
      ],
      { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    await once(child.stdout!, 'data');
    let joined = false;
    const disposal = processes.close().then(() => {
      joined = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(joined).toBe(false);
    expect(() => spawn(process.execPath, ['-e', 'process.exit(0)'])).toThrow(
      'Fixture process owner is closing',
    );
    child.stdin!.end('finish');
    await disposal;
    expect(child.exitCode).toBe(0);
    expect(child.stdout!.destroyed).toBe(true);
    expect(await readFile(join(root, 'late-sidecar'), 'utf8')).toBe('last canonical sidecar');
    await rm(root, { recursive: true, force: true });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await processes.join();
    processes.restore();
    await rm(root, { recursive: true, force: true });
  }
});
