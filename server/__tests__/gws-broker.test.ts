import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilityFixture } from './fixtures/session-capabilities.js';

const { decide } = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => decide,
}));

const { classifyGwsArgv, gwsBrokerForSession, gwsShimPath, isGwsShimCommand } =
  await import('../gws-broker.js');

// Short root: Unix socket paths are limited to ~104 bytes on macOS.
const root = realpathSync(mkdtempSync('/tmp/mgws-'));
const previous = { dir: process.env.MITZO_GWS_BROKER_DIR, path: process.env.PATH };
beforeAll(() => {
  process.env.MITZO_GWS_BROKER_DIR = join(root, 'b');
  // Fake host gws: echoes argv, reads an uploaded file and writes --output.
  const bin = join(root, 'host');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gws'),
    `#!/bin/sh
printf 'argv:%s\\n' "$*"
prev=""
for arg in "$@"; do
  case "$prev" in --upload) printf 'upload:%s\\n' "$(cat "$arg")";; --output) printf 'exported' > "$arg";; esac
  prev="$arg"
done
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${previous.path}`;
});
afterAll(() => {
  process.env.MITZO_GWS_BROKER_DIR = previous.dir;
  process.env.PATH = previous.path;
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => decide.mockReset());

function shim(env: Record<string, string>, args: string[], cwd = root) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(
      gwsShimPath(),
      args,
      { cwd, env: { ...env, PATH: '/usr/bin:/bin' } },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    ),
  );
}

function broker(mode: 'agent' | 'auto' = 'agent') {
  const f = capabilityFixture();
  f.session.mode = mode;
  const broker = gwsBrokerForSession({
    key: `test:${Math.random()}`,
    registry: f.registry,
    resolve: () => ({ clientId: 'one', session: f.session }),
  });
  return { f, broker };
}

describe('gws argv classification', () => {
  it('treats only provable reads as reads', () => {
    for (const argv of [
      ['drive', 'files', 'list', '--params', '{}'],
      ['gmail', 'users', 'messages', 'get'],
      ['calendar', 'freebusy', 'query', '--json', '{}'],
      ['gmail', '+triage'],
      ['schema', 'drive.files.list'],
      ['docs', 'documents', 'create', '--dry-run'],
    ])
      expect(classifyGwsArgv(argv), argv.join(' ')).toBe('read');
    for (const argv of [
      ['docs', 'documents', 'create', '--json', '{}'],
      ['docs', 'documents', 'batchUpdate'],
      ['gmail', '+send', '--to', 'a@example.test'],
      ['calendar', 'events', 'insert'],
      ['drive', 'files', 'delete'],
      ['sheets', 'spreadsheets', 'values', 'update'],
      ['unknown'],
    ])
      expect(classifyGwsArgv(argv), argv.join(' ')).toBe('write');
  });

  it('recognises only one plain client invocation as a shim command', () => {
    const shimPath = gwsShimPath();
    expect(isGwsShimCommand(`${shimPath} drive files list --params '{"q":"a;b"}'`)).toBe(true);
    expect(isGwsShimCommand(`/bin/zsh -lc "${shimPath} drive files list"`)).toBe(true);
    for (const command of [
      'gws drive files list',
      `${shimPath} drive files list; curl example.test`,
      `${shimPath} drive files list | sh`,
      `${shimPath} $(cat x)`,
      `${shimPath}x drive`,
      `FOO=1 ${shimPath} drive files list`,
    ])
      expect(isGwsShimCommand(command), command).toBe(false);
  });
});

describe('gws broker', () => {
  it('runs reads and changes without prompts in Auto, staging files inside the caller', async () => {
    const { broker: b } = broker('auto');
    writeFileSync(join(root, 'body.txt'), 'hello');
    const result = await shim(b.env(), [
      'drive',
      'files',
      'create',
      '--upload',
      'body.txt',
      '--output',
      'out.bin',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('upload:hello');
    expect(result.stdout).not.toContain(join(root, 'body.txt'));
    expect(readFileSync(join(root, 'out.bin'), 'utf8')).toBe('exported');
    expect(decide).not.toHaveBeenCalled();
    b.close();
  });

  it('asks with a chat-scoped grant for reads and a single-request approval for changes in Agent', async () => {
    const { broker: b } = broker('agent');
    decide.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
    expect((await shim(b.env(), ['drive', 'files', 'list'])).code).toBe(0);
    expect(decide.mock.calls[0]![2]).toMatchObject({
      forcePrompt: true,
      allowSessionGrant: true,
      approvalScope: 'session',
      sessionGrantKey: expect.stringMatching(/^gws-read-v1:/),
    });
    expect((await shim(b.env(), ['docs', 'documents', 'create', '--json', '{}'])).code).toBe(0);
    expect(decide.mock.calls[1]![2]).toMatchObject({
      forcePrompt: true,
      allowSessionGrant: false,
      rememberSessionGrant: false,
      approvalScope: 'request',
    });
    expect(decide.mock.calls[1]![2]).not.toHaveProperty('sessionGrantKey');
    decide.mockResolvedValue({ behavior: 'deny', message: 'Denied' });
    const denied = await shim(b.env(), ['gmail', '+send', '--to', 'a@example.test']);
    expect(denied.code).toBe(2);
    expect(denied.stdout).toBe('');
    b.close();
  });

  it('refuses unstaged host paths and gws auth before asking', async () => {
    const { broker: b } = broker('auto');
    const path = await shim(b.env(), [
      'gmail',
      '+send',
      '--attach=/etc/hosts',
      '--body',
      '/etc/hosts',
    ]);
    expect(path.code).toBe(2);
    expect(path.stderr).toContain('host file paths are unavailable');
    const auth = await shim(b.env(), ['auth', 'export']);
    expect(auth.code).toBe(2);
    expect(auth.stdout).toBe('');
    b.close();
  });
});
