import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { observeJoinedFixtureProcesses } from './joined-fixture-processes.mjs';

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
