import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runBrowserCommand } from '../ci-browser-run.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
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
  expect(observations[0].timestamp).toBeTruthy();
  expect(JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'))).toMatchObject({
    code: 7,
    signal: null,
    interruptedBy: null,
  });
});
it('fails a missing executable and records that launch failure', async () => {
  const root = directory();
  expect(
    await runBrowserCommand({ command: join(root, 'missing'), args: [], directory: root }),
  ).toBe(127);
  expect(JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')).error).toContain('ENOENT');
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
