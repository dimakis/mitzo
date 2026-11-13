import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it.each(['input closes', 'supervisor dies'])(
  'terminates the native login when %s',
  async (failure) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-supervisor-')));
    const executable = join(root, 'fake-claude.cjs'),
      pidFile = join(root, 'pid');
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);`,
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
      if (failure === 'input closes') worker.stdin.end();
      else worker.kill('SIGKILL');
      await stopped;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return true;
            throw cause;
          }
        })
        .toBe(true);
    } finally {
      worker.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true });
    }
  },
);
