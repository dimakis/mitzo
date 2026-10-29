import { spawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runBrowserCommand, readMacProcessDiagnostics } from '../ci-browser-run.mjs';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
afterEach(() => vi.mocked(childProcess.execFileSync).mockReset());
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'ci-browser-diagnostics-'));
  roots.push(root);
  return root;
}
it('retains command output and resource observations without swallowing a test failure', async () => {
  const root = directory();
  expect(
    await runBrowserCommand({
      command: process.execPath,
      args: ['-e', 'console.log("fixture output");process.exitCode=7'],
      directory: root,
    }),
  ).toBe(7);
  expect(readFileSync(join(root, 'command.log'), 'utf8')).toContain('fixture output');
  const observations = readFileSync(join(root, 'resources.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(observations[0].totalMemory).toBeGreaterThan(0);
  expect(observations[0].cpuCount).toBeGreaterThan(0);
  expect(observations[0].timestamp).toBeTruthy();
  expect(JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'))).toMatchObject({
    code: 7,
    signal: null,
    interruptedBy: null,
  });
});

it('captures only bounded macOS numeric fields ordered by numeric CPU then RSS', () => {
  const run = vi.fn(() =>
    Array.from(
      { length: 20 },
      (_, index) => `${index + 1} 2 3 ${index === 19 ? 90 : 9}.0 ${index * 100} 00:01.20 R`,
    ).join('\n'),
  );
  const rows = readMacProcessDiagnostics(run);
  expect(run).toHaveBeenCalledWith(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,pgid=,%cpu=,rss=,time=,state='],
    expect.objectContaining({ timeout: 2000, maxBuffer: 128 * 1024 }),
  );
  expect(rows).toHaveLength(16);
  expect(rows[0]).toContain('20 2 3 90.0');
  expect(rows[1]).toContain('19 2 3 9.0');
  expect(rows.at(-1)).toContain('5 2 3 9.0');
  expect(rows.some((row: string) => row.startsWith('1 '))).toBe(false);
});

it('rejects malformed or extra process columns without retaining their contents', () => {
  const rows = readMacProcessDiagnostics(() =>
    [
      '1 2 3 4.5 600 00:01.20 Ss',
      '2 2 3 4.5 600 00:01.20 Rs',
      '1 2 3 4.5 600 00:01.20 S synthetic-secret-canary',
      'bad 2 3 4.5 600 00:01.20 S',
      '1 2 3 NaN 600 00:01.20 S',
      '1 2 3 4.5 -600 00:01.20 S',
      '1 2 3 4.5 600 bad S',
      '1 2 3 4.5 600 00:01.20 --api-key',
    ].join('\n'),
  );
  expect(rows).toEqual(['1 2 3 4.5 600 00:01.20 Ss', '2 2 3 4.5 600 00:01.20 Rs']);
});

it.skipIf(process.platform !== 'darwin')(
  'does not collect an owned process credential-bearing title',
  async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.title='mitzo-title-canary --api-key synthetic-secret-canary';process.send('ready');setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', () => reject(Error('Owned canary exited before readiness')));
      });
      const rows = readMacProcessDiagnostics((file, args, options) => {
        expect(args[0]).toBe('-axo');
        return actual.execFileSync(
          file,
          ['-p', String(child.pid), '-o', ...args.slice(1)],
          options,
        );
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].split(/\s+/)).toHaveLength(7);
      expect(rows[0].split(/\s+/)[0]).toBe(String(child.pid));
      expect(rows[0].split(/\s+/)[6]).toContain('s');
      expect(JSON.stringify(rows)).not.toMatch(
        /mitzo-title-canary|api-key|synthetic-secret-canary/,
      );
    } finally {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  },
);

it('preserves command identity and failure exit when process diagnostics are unavailable', async () => {
  vi.mocked(childProcess.execFileSync).mockImplementation(() => {
    throw Error('Synthetic ps unavailable');
  });
  const root = directory();
  const code = await runBrowserCommand({
    command: process.execPath,
    args: ['-e', 'console.log(process.pid);process.exitCode=7'],
    directory: root,
  });
  expect(code).toBe(7);
  expect(childProcess.execFileSync).toHaveBeenCalled();
  const pid = Number(readFileSync(join(root, 'stdout.log'), 'utf8').trim());
  expect(JSON.parse(readFileSync(join(root, 'command-process.json'), 'utf8'))).toEqual({
    pid,
    pgid: pid,
  });
  const records = readFileSync(join(root, 'resources.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records.at(-1).commandProcess).toEqual({ pid, pgid: pid });
  expect(JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')).code).toBe(7);
});

it('drops unavailable macOS process observations without throwing', () => {
  expect(
    readMacProcessDiagnostics(() => {
      throw Error('Synthetic ps unavailable');
    }),
  ).toBeUndefined();
});
it('fails a missing executable and records that launch failure', async () => {
  const root = directory();
  writeFileSync(join(root, 'command-process.json'), JSON.stringify({ pid: 123, pgid: 123 }));
  expect(
    await runBrowserCommand({ command: join(root, 'missing'), args: [], directory: root }),
  ).toBe(127);
  expect(JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')).error).toContain('ENOENT');
  expect(JSON.parse(readFileSync(join(root, 'command-process.json'), 'utf8'))).toBeNull();
});

it('preserves a joined case working directory, private environment and separate output streams', async () => {
  const root = directory();
  const env = { ...process.env, JOINED_CASE_ID: 'private-case' };
  expect(
    await runBrowserCommand({
      command: process.execPath,
      args: [
        '-e',
        'console.log(process.cwd());console.log(process.env.JOINED_CASE_ID);console.error("case stderr");process.exitCode=7',
      ],
      directory: join(root, 'diagnostics'),
      cwd: root,
      env,
    }),
  ).toBe(7);
  expect(readFileSync(join(root, 'diagnostics', 'stdout.log'), 'utf8')).toBe(
    realpathSync(root) + '\nprivate-case\n',
  );
  expect(readFileSync(join(root, 'diagnostics', 'stderr.log'), 'utf8')).toBe('case stderr\n');
  expect(process.env.JOINED_CASE_ID).toBeUndefined();
});

it.each(['ignore', 'inherit'] as const)(
  'retires a descendant that ignores SIGTERM after its direct parent exits with %s stdio',
  async (stdio) => {
    const root = directory();
    const pidFile = join(root, 'descendant.pid');
    const parentPidFile = join(root, 'parent.pid');
    const childSource = `process.on('SIGTERM',()=>{});console.log('descendant stdout');console.error('descendant stderr');require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
    const parentSource = `require('fs').writeFileSync(${JSON.stringify(parentPidFile)},String(process.pid));require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:${JSON.stringify(stdio)}});const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.exit(0)}},10);`;
    let completed = false;
    const running = runBrowserCommand({
      command: process.execPath,
      args: ['-e', parentSource],
      directory: root,
    }).then((code: number) => {
      completed = true;
      return code;
    });
    try {
      await expect.poll(() => completed, { timeout: 1500 }).toBe(true);
      expect(await running).toBe(0);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 1000 },
        )
        .toBe(false);
      if (stdio === 'inherit') {
        const output = readFileSync(join(root, 'command.log'), 'utf8');
        expect(output).toContain('descendant stdout');
        expect(output).toContain('descendant stderr');
      }
    } finally {
      // Bound the red regression too: retire only this fixture's detached group
      // if the implementation remains blocked waiting for inherited pipes.
      if (existsSync(parentPidFile)) {
        try {
          process.kill(-Number(readFileSync(parentPidFile, 'utf8')), 'SIGKILL');
        } catch {
          /* Already retired. */
        }
      }
      await running;
    }
  },
);
it('forwards cancellation to the owned process group and retains a failing signal exit', async () => {
  const root = directory();
  const script = resolve('scripts/ci-browser-run.mjs');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { runBrowserCommand } from ${JSON.stringify('file://' + script)};
    process.exitCode = await runBrowserCommand({ command: process.execPath, args: ['-e', 'console.log("READY");setInterval(()=>{},1000)'], directory: ${JSON.stringify(root)} });
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = new Promise<number | null>((res, reject) => {
    child.once('error', reject);
    child.once('exit', res);
  });
  try {
    await new Promise<void>((res, reject) => {
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
        if (output.includes('READY')) res();
      });
      child.once('exit', () => reject(Error('Fixture exited before readiness: ' + output)));
    });
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    expect(JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'))).toMatchObject({
      interruptedBy: 'SIGTERM',
    });
  } finally {
    child.kill('SIGKILL');
  }
});
