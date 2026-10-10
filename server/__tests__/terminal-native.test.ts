import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    writeFileSync(join(home, '.tmux.conf'), 'set -g exit-unattached on\nset -g status on\n');
    const environment = { ...process.env, HOME: home, SHELL: '/bin/sh' };
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
    const backend = new TmuxTerminalBackend(namespace, environment);
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
      expect(
        spawnSync('tmux', ['-L', namespace, 'show-option', '-t', record.id, 'status'], {
          encoding: 'utf8',
        }).stdout.trim(),
      ).toBe('status off');
      live.detach();
      output = '';
      const reconstructed = new TmuxTerminalBackend(namespace, environment);
      const exits: Array<'disconnected' | undefined> = [];
      live = await reconstructed.start(record, true, {
        data: (value) => (output += value),
        exit: (reason) => {
          exits.push(reason);
        },
      });
      live.write('printf \'VALUE_%s\\n\' "$MITZO_TEST_VALUE"\r');
      await vi.waitFor(() => expect(output).toContain('VALUE_persisted'), {
        timeout: 3000,
        interval: 20,
      });
      const client = spawnSync(
        'tmux',
        ['-L', namespace, 'list-clients', '-t', record.id, '-F', '#{client_pid}'],
        { encoding: 'utf8' },
      )
        .stdout.trim()
        .split('\n')
        .at(-1)!;
      expect(Number.isSafeInteger(Number(client)) && Number(client) > 0).toBe(true);
      process.kill(Number(client), 'SIGTERM');
      await vi.waitFor(() => expect(exits).toEqual(['disconnected']), {
        timeout: 3000,
        interval: 20,
      });
      output = '';
      live = await new TmuxTerminalBackend(namespace, environment).start(record, true, {
        data: (value) => {
          output += value;
        },
        exit: () => {},
      });
      live.write('printf \'RECOVERED_%s\\n\' "$MITZO_TEST_VALUE"\r');
      await vi.waitFor(() => expect(output).toContain('RECOVERED_persisted'), {
        timeout: 3000,
        interval: 20,
      });
      await reconstructed.end(record);
      await expect(reconstructed.end(record)).resolves.toBeUndefined();
    } finally {
      live?.detach();
      spawnSync('tmux', ['-L', namespace, 'kill-server'], { env: { ...process.env, HOME: home } });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  },
  10000,
);
