import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('terminates the native login when the controlling process loses its input pipe', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-supervisor-')));
  const executable = join(root, 'fake-claude.cjs'),
    pidFile = join(root, 'pid');
  writeFileSync(
    executable,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log('ready');setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const worker = spawn(
    process.execPath,
    [fileURLToPath(new URL('../claude-login-supervisor.cjs', import.meta.url)), executable],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      worker.stdout.once('data', () => resolve());
      worker.once('close', (code) =>
        reject(Error(`Login supervisor exited before readiness (${code})`)),
      );
      worker.once('error', reject);
    });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const stopped = new Promise<void>((resolve, reject) => {
      worker.once('close', () => resolve());
      worker.once('error', reject);
    });
    worker.stdin.end();
    await stopped;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    worker.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
