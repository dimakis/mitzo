import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { TmuxTerminalBackend } from '../terminal-backend.js';
import type { TerminalRecord } from '../terminal-service.js';
const available = spawnSync('tmux', ['-V']).status === 0;
it.skipIf(!available)(
  'preserves a real isolated shell across backend detach and server reconstruction',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'mitzo-terminal-test-'));
    const namespace = `mitzo-test-${randomUUID()}`;
    vi.stubEnv('HOME', home);
    vi.stubEnv('SHELL', '/bin/sh');
    const record: TerminalRecord = {
      id: `term-${randomUUID()}`,
      owner: 'test',
      identity: 'isolated-test',
      kind: 'host',
      label: 'Test',
      cwd: home,
      state: 'running',
      createdAt: 1,
    };
    const backend = new TmuxTerminalBackend(namespace);
    let output = '';
    let live: Awaited<ReturnType<TmuxTerminalBackend['start']>> | undefined;
    try {
      live = await backend.start(record, false, {
        data: (value) => (output += value),
        exit: () => {},
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          if (output.includes('READY_MARKER')) {
            clearInterval(timer);
            clearTimeout(timeout);
            resolve();
          }
        }, 20);
        const timeout = setTimeout(() => {
          clearInterval(timer);
          reject(Error('Shell did not respond'));
        }, 3000);
        live!.write("export MITZO_TEST_VALUE=persisted; printf 'READY_%s\\n' MARKER\r");
      });
      live.detach();
      output = '';
      const reconstructed = new TmuxTerminalBackend(namespace);
      live = await reconstructed.start(record, true, {
        data: (value) => (output += value),
        exit: () => {},
      });
      live.write('printf \'VALUE_%s\\n\' "$MITZO_TEST_VALUE"\r');
      await vi.waitFor(() => expect(output).toContain('VALUE_persisted'), {
        timeout: 3000,
        interval: 20,
      });
    } finally {
      live?.detach();
      spawnSync('tmux', ['-L', namespace, 'kill-server'], { env: { ...process.env, HOME: home } });
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  },
  10000,
);
