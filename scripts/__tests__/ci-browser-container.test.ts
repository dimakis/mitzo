import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const script = resolve('scripts/ci-browser-container.sh');
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(docker: string) {
  const root = mkdtempSync(join(tmpdir(), 'ci-browser-container-'));
  roots.push(root);
  const tools = join(root, 'tools');
  mkdirSync(tools);
  symlinkSync(process.execPath, join(tools, 'node'));
  writeFileSync(join(tools, 'docker'), `#!/bin/bash\n${docker}`, { mode: 0o755 });
  return {
    root,
    env: {
      ...process.env,
      PATH: `${tools}:/usr/bin:/bin`,
      RUNNER_OS: 'Linux',
      RUNNER_TOOL_CACHE: tools,
      RUNNER_TEMP: root,
      GITHUB_WORKSPACE: process.cwd(),
      GITHUB_RUN_ID: '123',
      TRACE: join(root, 'trace'),
      GITHUB_TOKEN: 'must-not-be-forwarded',
    },
  };
}

it('retains command arguments, narrow mounts and the real failing container exit', () => {
  const { env } = fixture('printf "%s\\n" "$@" > "$TRACE"\nexit 23\n');
  const result = spawnSync('bash', [script, 'node', 'test.js', 'argument with spaces'], { env });
  expect(result.status).toBe(23);
  const args = readFileSync(env.TRACE, 'utf8').trim().split('\n');
  expect(args.slice(-3)).toEqual(['node', 'test.js', 'argument with spaces']);
  expect(args).toContain(`${env.RUNNER_TOOL_CACHE}:${env.RUNNER_TOOL_CACHE}:ro`);
  expect(args).not.toContain(`${env.RUNNER_TEMP}:${env.RUNNER_TEMP}`);
  expect(args).not.toContain('GITHUB_TOKEN');
  expect(args.join(' ')).not.toContain('must-not-be-forwarded');
  expect(args).toContain('--pull=never');
});

it('refuses Node outside the selected tool cache before starting Docker', () => {
  const { env } = fixture('touch "$TRACE"\n');
  const result = spawnSync('bash', [script, 'node', 'test.js'], {
    env: { ...env, RUNNER_TOOL_CACHE: '/different-tool-cache' },
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('CI_BROWSER_NODE_CUSTODY');
});

it('stops its container promptly on cancellation and retains the signal exit', async () => {
  const { env } = fixture(`
case "$1" in
  run) echo $$ > "$TRACE.pid"; echo ready; exec sleep 60 ;;
  stop) echo stopped > "$TRACE"; kill -TERM "$(cat "$TRACE.pid")" ;;
esac
`);
  const child = spawn('bash', [script, 'node', 'test.js'], { env });
  const finished = new Promise<number | null>((resolve) => child.once('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve());
  });
  child.kill('SIGTERM');
  expect(await finished).toBe(143);
  expect(readFileSync(env.TRACE, 'utf8').trim()).toBe('stopped');
});
