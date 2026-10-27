import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem, totalmem, loadavg, release, constants } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { setInterval, setTimeout, clearInterval, clearTimeout } from 'node:timers';

export async function runBrowserCommand({ command, args, directory }) {
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, 'command.log');
  writeFileSync(logPath, '');
  writeFileSync(join(directory, 'resources.jsonl'), '');
  const snapshot = () => {
    const record = {
      timestamp: new Date().toISOString(),
      kernel: release(),
      totalMemory: totalmem(),
      freeMemory: freemem(),
      load: loadavg(),
      linux: {},
    };
    for (const path of [
      '/proc/meminfo',
      '/proc/pressure/memory',
      '/sys/fs/cgroup/memory.current',
      '/sys/fs/cgroup/memory.max',
      '/sys/fs/cgroup/memory.events',
      '/proc/self/cgroup',
      '/sys/fs/cgroup/memory/memory.oom_control',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    ]) {
      try {
        record.linux[path] = readFileSync(path, 'utf8').trim();
      } catch {
        /* Not available on every host. */
      }
    }
    if (process.platform === 'linux') {
      try {
        record.processes = execFileSync(
          'ps',
          ['-e', '-o', 'pid,ppid,pgid,rss,comm', '--sort=-rss'],
          { encoding: 'utf8', timeout: 2000, maxBuffer: 128 * 1024 },
        )
          .trim()
          .split('\n')
          .slice(0, 16);
      } catch {
        /* Observability must not replace the test result. */
      }
    }
    const meminfo = record.linux['/proc/meminfo'] ?? '';
    const availableKiB = Number(/^MemAvailable:\s+(\d+)/m.exec(meminfo)?.[1]);
    const swapFreeKiB = Number(/^SwapFree:\s+(\d+)/m.exec(meminfo)?.[1]);
    if (availableKiB < 256 * 1024 && swapFreeKiB < 128 * 1024)
      console.error('CI_BROWSER_MEMORY_PRESSURE ' + JSON.stringify({ availableKiB, swapFreeKiB }));
    const line = JSON.stringify(record);
    appendFileSync(join(directory, 'resources.jsonl'), line + '\n');
    console.log('CI_BROWSER_RESOURCES ' + line);
  };
  snapshot();
  // A separate group lets cancellation reach only this command's descendants.
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [stream, output] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ])
    stream.on('data', (data) => {
      appendFileSync(logPath, data);
      output.write(data);
    });
  const heartbeat = setInterval(snapshot, 30000);
  let interruptedBy = null;
  let escalation;
  const terminate = (signal) => {
    interruptedBy ??= signal;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* Process may already have exited. */
    }
    escalation ??= setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }, 5000);
  };
  const interrupt = () => terminate('SIGINT');
  const stop = () => terminate('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', stop);
  try {
    const observed = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: 127, signal: null, error: String(error) }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const result = { ...observed, interruptedBy, timestamp: new Date().toISOString() };
    writeFileSync(join(directory, 'exit.json'), JSON.stringify(result) + '\n');
    console.log('CI_BROWSER_EXIT ' + JSON.stringify(result));
    return interruptedBy
      ? 128 + constants.signals[interruptedBy]
      : observed.signal
        ? 128 + constants.signals[observed.signal]
        : (observed.code ?? 1);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(escalation);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', stop);
    // Retire any descendants still in the owned group after npm exits.
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* No remaining child. */
      }
    }
    snapshot();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [script, ...args] = process.argv.slice(2);
  if (!['test:ui', 'test:ui:ci', 'test:browser'].includes(script))
    throw Error('Select a browser CI test script');
  process.exitCode = await runBrowserCommand({
    command: 'npm',
    args: ['run', script, '--', ...args],
    directory: 'test-results/browser-diagnostics',
  });
}
