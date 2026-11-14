import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import { resolvePending } from '../permissions.js';

const { decide, real } = vi.hoisted(() => ({ decide: vi.fn(), real: { use: false } }));
vi.mock('@mitzo/harness', async (original) => {
  const harness = await original<typeof import('@mitzo/harness')>();
  return {
    ...harness,
    buildPermissionHandler: (...args: Parameters<typeof harness.buildPermissionHandler>) =>
      real.use ? harness.buildPermissionHandler(...args) : decide,
  };
});

const { classifyGwsArgv, gwsBrokerForSession, gwsShimPath, isGwsShimCommand, gwsShimInvocation } =
  await import('../gws-broker.js');

// Short root: Unix socket paths are limited to ~104 bytes on macOS.
const root = realpathSync(mkdtempSync('/tmp/mgws-'));
const previous = { dir: process.env.MITZO_GWS_BROKER_DIR, path: process.env.PATH };
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
beforeAll(() => {
  process.env.MITZO_GWS_BROKER_DIR = join(root, 'b');
  // Fake host gws: echoes argv, reads an uploaded file, writes --output and can block.
  const bin = join(root, 'host');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gws'),
    `#!/bin/sh
printf 'argv:%s\\n' "$*"
prev=""
for arg in "$@"; do
  case "$prev" in --upload) printf 'upload:%s\\n' "$(cat "$arg")";; --output|-o) printf 'exported' > "$arg";; esac
  case "$arg" in -o/*) printf 'exported' > "\${arg#-o}";; slow) echo $$ > "${root}/slow.pid"; exec sleep 30;; esac
  prev="$arg"
done
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${previous.path}`;
});
afterAll(() => {
  restore('MITZO_GWS_BROKER_DIR', previous.dir);
  restore('PATH', previous.path);
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  decide.mockReset();
  real.use = false;
});

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

/** Raw protocol access, as any same-UID process could attempt. */
function raw(socket: string, body: unknown, hold = false) {
  return new Promise<{ reply: string; destroy(): void }>((resolve) => {
    const client = createConnection(socket);
    const chunks: Buffer[] = [];
    client.on('data', (chunk) => chunks.push(chunk));
    client.on('end', () => resolve({ reply: Buffer.concat(chunks).toString(), destroy() {} }));
    client.on('error', () => resolve({ reply: '', destroy() {} }));
    client.write(JSON.stringify(body) + '\n');
    if (hold) resolve({ reply: '', destroy: () => client.destroy() });
  });
}

async function broker(
  mode: 'ask' | 'agent' | 'auto' = 'agent',
  assertCurrent?: (signal: AbortSignal) => Promise<void>,
) {
  const f = capabilityFixture();
  f.session.mode = mode;
  const lifetime = new AbortController();
  const b = await gwsBrokerForSession({
    key: `test:${Math.random()}`,
    registry: f.registry,
    lifetime: lifetime.signal,
    ...(assertCurrent ? { assertCurrent } : {}),
    resolve: () => ({ clientId: 'one', session: f.session }),
  });
  if (!b) throw Error('broker unavailable');
  return { f, broker: b, lifetime };
}

describe('gws argv classification', () => {
  it('treats only provable reads as reads', () => {
    for (const argv of [
      ['drive', 'files', 'list', '--params', '{}'],
      ['gmail', 'users', 'messages', 'get'],
      ['calendar', 'freebusy', 'query', '--json', '{}'],
      ['gmail', '+triage'],
      ['schema', 'drive.files.list'],
    ])
      expect(classifyGwsArgv(argv), argv.join(' ')).toBe('read');
    for (const argv of [
      ['docs', 'documents', 'create', '--json', '{}'],
      ['docs', 'documents', 'create', '--dry-run'],
      ['gmail', '+watch', '--project', 'p', '--once', '--dry-run'],
      ['docs', 'documents', 'batchUpdate', '--help'],
      ['gmail', '+send', '--to', 'a@example.test'],
      ['calendar', 'events', 'insert'],
      ['sheets', 'spreadsheets', 'values', 'update'],
      ['unknown'],
    ])
      expect(classifyGwsArgv(argv), argv.join(' ')).toBe('write');
  });

  it('recognises only one literal client invocation as a shim command', () => {
    const shimPath = gwsShimPath();
    expect(gwsShimInvocation(`${shimPath} drive files list --params '{"q":"a;b"}'`)).toEqual([
      'drive',
      'files',
      'list',
      '--params',
      '{"q":"a;b"}',
    ]);
    expect(isGwsShimCommand(`/bin/zsh -lc "${shimPath} drive files list"`)).toBe(true);
    expect(isGwsShimCommand(`/bin/zsh -lc '${shimPath} drive files list '"'"'$(x)'"'"''`)).toBe(
      true,
    );
    for (const command of [
      'gws drive files list',
      `/bin/zsh -lc "${shimPath} drive files list '$(curl https://example.test)'"`,
      `/bin/zsh -lc '${shimPath} drive files list "$(curl https://example.test)"'`,
      `${shimPath} drive files list; curl example.test`,
      `${shimPath} drive files list | sh`,
      `${shimPath} $(cat x)`,
      `${shimPath} "$HOME"`,
      `${shimPath}x drive`,
      `FOO=1 ${shimPath} drive files list`,
      `${shimPath} drive files list\ncurl example.test`,
    ])
      expect(isGwsShimCommand(command), command).toBe(false);
  });
});

describe('gws broker', () => {
  it('runs changes without prompts in Auto, staging files inside the caller', async () => {
    const { broker: b } = await broker('auto');
    writeFileSync(join(root, 'body.txt'), 'hello');
    const result = await shim(b.env(), [
      'drive',
      'files',
      'create',
      '--upload',
      'body.txt',
      '-oout.bin',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('upload:hello');
    expect(result.stdout).not.toContain(join(root, 'body.txt'));
    expect(readFileSync(join(root, 'out.bin'), 'utf8')).toBe('exported');
    expect(decide).not.toHaveBeenCalled();
    b.close();
  });

  it('asks with a chat-scoped grant for reads and a single-request approval for changes in Agent', async () => {
    const { broker: b } = await broker('agent');
    decide.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
    expect((await shim(b.env(), ['drive', 'files', 'list'])).code).toBe(0);
    expect(decide.mock.calls[0]![0]).toBe('GwsRead');
    expect(decide.mock.calls[0]![2]).toMatchObject({
      forcePrompt: true,
      allowSessionGrant: true,
      approvalScope: 'session',
      sessionGrantKey: expect.stringMatching(/^gws-read-v1:/),
    });
    // A staged output value cannot smuggle --dry-run into a read classification.
    expect(
      (await shim(b.env(), ['docs', 'documents', 'create', '--output', '--dry-run'])).code,
    ).toBe(0);
    expect(decide.mock.calls[1]![0]).toBe('Bash');
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

  it('prompts for reads in Ask through the real handler and refuses changes', async () => {
    real.use = true;
    const { f, broker: b } = await broker('ask');
    const read = shim(b.env(), ['drive', 'files', 'list']);
    await vi.waitFor(() => expect(f.sent.find((m) => m.permId)).toBeDefined());
    resolvePending(f.sent.find((m) => m.permId)!.permId as string, 'always', undefined, 'one');
    const result = await read;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('argv:drive files list');
    // Allow for session covers later reads in this chat without a prompt.
    expect((await shim(b.env(), ['gmail', 'users', 'messages', 'list'])).code).toBe(0);
    const change = await shim(b.env(), ['docs', 'documents', 'create']);
    expect(change.code).toBe(2);
    expect(change.stderr).toContain('Ask mode');
    expect(f.sent.filter((m) => m.type === 'permission_request')).toHaveLength(1);
    b.close();
  });

  it('enforces the shell skill ceiling even in Auto', async () => {
    const { f, broker: b } = await broker('auto');
    f.session.activeSkillPolicy = new Set(['Read']);
    const result = await shim(b.env(), ['drive', 'files', 'list']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    b.close();
  });

  it('refuses other chats, forged staging, unstaged host paths and gws auth', async () => {
    const { broker: b } = await broker('auto');
    const { broker: other } = await broker('auto');
    const forged = await raw(b.socketPath, {
      v: 1,
      token: other.env().MITZO_GWS_TOKEN,
      argv: ['drive', 'files', 'list'],
      files: [],
      outputs: [],
    });
    expect(forged.reply).toContain('not authorized');
    const misplaced = await raw(b.socketPath, {
      v: 1,
      token: b.env().MITZO_GWS_TOKEN,
      argv: ['docs', 'documents', 'create', '--title', 'x'],
      files: [],
      outputs: [{ index: 4, prefix: '' }],
    });
    expect(misplaced.reply).toContain('invalid file arguments');
    for (const argv of [
      ['drive', 'files', 'get', `-o${join(root, 'clobber')}`],
      ['drive', 'files', 'create', '-a/etc/hosts'],
      ['drive', 'files', 'create', '--upload', '/etc/hosts'],
    ]) {
      const unstaged = await raw(b.socketPath, {
        v: 1,
        token: b.env().MITZO_GWS_TOKEN,
        argv,
        files: [],
        outputs: [],
      });
      expect(unstaged.reply, argv.join(' ')).toContain('invalid file arguments');
    }
    expect(existsSync(join(root, 'clobber'))).toBe(false);
    const path = await shim(b.env(), ['gmail', '+send', '--body', '/etc/hosts']);
    expect(path.code).toBe(2);
    expect(path.stderr).toContain('host file paths are unavailable');
    const auth = await shim(b.env(), ['auth', 'export']);
    expect(auth.code).toBe(2);
    expect(auth.stdout).toBe('');
    b.close();
    other.close();
  });

  it("refuses when the owning runtime's authorization fails", async () => {
    let allowed = true;
    const { broker: b } = await broker('auto', async () => {
      if (!allowed) throw Error('workspace changed');
    });
    expect((await shim(b.env(), ['drive', 'files', 'list'])).code).toBe(0);
    allowed = false;
    const refused = await shim(b.env(), ['drive', 'files', 'list']);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('runtime authorization changed');
    b.close();
  });

  it('cancels the host command when the client goes away and closes with the chat', async () => {
    const { broker: b, lifetime } = await broker('auto');
    const held = await raw(
      b.socketPath,
      { v: 1, token: b.env().MITZO_GWS_TOKEN, argv: ['slow'], files: [], outputs: [] },
      true,
    );
    await vi.waitFor(() => expect(existsSync(join(root, 'slow.pid'))).toBe(true));
    const pid = Number(readFileSync(join(root, 'slow.pid'), 'utf8'));
    held.destroy();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    lifetime.abort();
    expect(existsSync(b.socketPath)).toBe(false);
    expect((await shim(b.env(), ['drive', 'files', 'list'])).stderr).toContain('cannot reach');
  }, 20_000);

  it('reports an unusable socket path without throwing', async () => {
    const f = capabilityFixture();
    process.env.MITZO_GWS_BROKER_DIR = join(root, 'x'.repeat(120));
    try {
      await expect(
        gwsBrokerForSession({
          key: 'long',
          registry: f.registry,
          lifetime: new AbortController().signal,
          resolve: () => ({ clientId: 'one', session: f.session }),
        }),
      ).resolves.toBeUndefined();
    } finally {
      process.env.MITZO_GWS_BROKER_DIR = join(root, 'b');
    }
  });
});
