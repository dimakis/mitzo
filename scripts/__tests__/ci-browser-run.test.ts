import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
