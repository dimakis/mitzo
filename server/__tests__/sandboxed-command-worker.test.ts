import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { execFileSync, spawn as realSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { PassThrough } from 'node:stream';
import { AuthoritySnapshot } from '../sandbox-authority.js';
import {
  admitHostGithubToken,
  runSandboxedWorker,
  takeHostGithubTransfer,
  wrapSdkGitMetadata,
  type SandboxWorkerPayload,
} from '../sandboxed-command-worker.js';
import { HOST_GITHUB_TOKEN_TRANSFER } from '../host-github-credential.js';
import { HOST_GITHUB_TOKEN_TRANSFER as WORKER_HOST_GITHUB_TOKEN_TRANSFER } from '../sandboxed-command-worker.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-worker-test-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(root + '-old', { recursive: true, force: true });
});

function fixture() {
  const authority = new AuthoritySnapshot();
  authority.capture(root);
  const payload: SandboxWorkerPayload = {
    cwd: root,
    command: 'true',
    authority: JSON.parse(JSON.stringify(authority.serialize())),
    config: {
      filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    },
  };
  const manager = {
    checkDependencies: vi.fn(() => ({ errors: [], warnings: [] })),
    initialize: vi.fn<typeof SandboxManager.initialize>().mockResolvedValue(undefined),
    wrapWithSandbox: vi
      .fn<typeof SandboxManager.wrapWithSandbox>()
      .mockResolvedValue('wrapped command'),
    reset: vi.fn(async () => {}),
  };
  const spawn = vi.fn<
    (command: string, args: readonly string[], options: SpawnOptions) => EventEmitter
  >(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  return { payload, manager, spawn };
}

async function sdkWrapper(command = 'retained target') {
  const directory = dirname(
    createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime'),
  );
  const { wrapCommandWithSandboxMacOS } = await import(
    pathToFileURL(join(directory, 'sandbox/macos-sandbox-utils.js')).href
  );
  return wrapCommandWithSandboxMacOS({
    command,
    commandId: 'synthetic-sdk-git',
    binShell: '/bin/sh',
    needsNetworkRestriction: true,
    unsetEnvVars: ['SDK_REMOVE'],
    setEnvVars: { SDK_TEST_VALUE: "a'b ! \\ $()" },
    allowGitConfig: true,
    readConfig: { denyOnly: [join(root, 'private')], allowWithinDeny: [] },
    writeConfig: { allowOnly: ['/'], denyWithinAllow: [join(root, 'private')] },
  });
}

it.each([true, false])(
  'physically fences SDK Git metadata around both filesystemOnly modes (%s)',
  async (filesystemOnly) => {
    const { payload, manager, spawn } = fixture();
    payload.filesystemOnly = filesystemOnly;
    payload.sdkGitWorkRoot = root;
    const inner = await sdkWrapper();
    manager.wrapWithSandbox.mockResolvedValue(inner);
    await expect(
      runSandboxedWorker(payload, {
        manager,
        spawn: spawn as never,
        platform: 'darwin',
        wrapFilesystem: async () => inner,
      }),
    ).resolves.toBe(0);
    expect(spawn.mock.calls[0][1]).toEqual(['-c', wrapSdkGitMetadata(inner, root)]);
    const wrapped = spawn.mock.calls[0][1][1];
    expect(wrapped).toContain(
      '(deny file-write* file-write-unlink file-write-create (require-all (regex ',
    );
    expect(wrapped).toContain('(require-not (subpath ' + JSON.stringify(root) + '))');
    expect(wrapped).not.toContain(
      '(deny file-write* file-write-unlink file-write-create (subpath ' +
        JSON.stringify(join(root, '.git')) +
        '))',
    );
    expect(wrapped).toContain(
      '(deny file-write-unlink file-write-create (literal ' + JSON.stringify(root) + '))',
    );
  },
);

it('retains every SRT argument and original policy using one sandbox application', async () => {
  const target = `printf '%s' "a'b ! \\ $()"\ntrue`;
  const original = await sdkWrapper(target);
  const restricted = wrapSdkGitMetadata(original, root);
  expect(restricted).toContain("'env' '-u' 'SDK_REMOVE' 'SDK_TEST_VALUE=");
  // Replace only the fixed executable with a harmless argv recorder. The shell
  // consumer verifies literal transfer without applying any kernel sandbox.
  const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";
  const recorder = [
    process.execPath,
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    '--',
  ]
    .map(quote)
    .join(' ');
  const argv = (command: string): string[] =>
    JSON.parse(
      execFileSync(
        '/bin/sh',
        [
          '-c',
          command.replace(/(?:'\/usr\/bin\/sandbox-exec'|\/usr\/bin\/sandbox-exec)/, recorder),
        ],
        { encoding: 'utf8' },
      ),
    );
  const before = argv(original),
    after = argv(restricted);
  expect(after.slice(0, 1)).toEqual(before.slice(0, 1));
  expect(after.slice(2)).toEqual(before.slice(2));
  expect(after[1]!.startsWith(before[1]! + '\n')).toBe(true);
  expect(after[1]).not.toContain('(allow default)');
  expect(after.at(-1)).toBe(target);
  expect(restricted.match(/\/usr\/bin\/sandbox-exec/g)).toHaveLength(1);
});

it.each([
  'unwrapped command',
  'env /usr/bin/sandbox-exec -p "$(touch injected)" /bin/sh -c true',
  "env /usr/bin/sandbox-exec -p '(version 1)\n(allow default)' /bin/sh -c true",
  "env /usr/bin/sandbox-exec -p '(version 1)\n(deny default)' /bin/sh -c true; touch injected",
  "env /usr/bin/sandbox-exec -p '(version 1)\n(deny default)' /bin/sh -c 'unterminated",
  ...[
    'env /bin/echo RECORDER_ONLY',
    'env --split-string=echo',
    'env -i',
    'env -u SDK_REMOVE NAME=VALUE /bin/echo RECORDER_ONLY',
    'env NAME=VALUE -u SDK_REMOVE',
    'env -u INVALID-NAME',
    'env -u',
  ].map(
    (prefix) => `${prefix} /usr/bin/sandbox-exec -p '(version 1)\n(deny default)' /bin/sh -c true`,
  ),
  "env /usr/bin/sandbox-exec -p '(version 1)\n(deny default)' /bin/echo -c true",
])('fails closed for an unsupported SRT invocation: %s', (command) => {
  expect(() => wrapSdkGitMetadata(command, root)).toThrow('Unsupported SRT SDK sandbox invocation');
});

it.each(['different-cwd', 'uncaptured', 'noncanonical', 'unsupported-platform'])(
  'rejects invalid SDK Git authority before any spawn (%s)',
  async (kind) => {
    const { payload, manager, spawn } = fixture();
    payload.sdkGitWorkRoot = kind === 'noncanonical' ? root + '/..' : root;
    if (kind === 'different-cwd') payload.cwd = dirname(root);
    if (kind === 'uncaptured') payload.authority = [];
    await expect(
      runSandboxedWorker(payload, {
        manager,
        spawn: spawn as never,
        platform: kind === 'unsupported-platform' ? 'linux' : 'darwin',
      }),
    ).rejects.toThrow(/SDK Git workspace authority|Sandbox roots/);
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.initialize).not.toHaveBeenCalled();
  },
);

async function privateFileFixture() {
  const f = fixture();
  const request = {
    operation: 'CreateDirectory',
    file_path: root + '/child',
    rootAnchor: { rootPath: root, identity: { dev: '1', ino: '2' } },
    parentIdentity: { dev: '1', ino: '2' },
    expectedAbsent: true,
    deniedRoots: [],
    identity: null,
    limit: 1,
    timeoutMs: 1000,
  };
  const { privateNativeFileHelperCommand } = await import('../native-file-operation.js');
  f.payload.privateNativeFileRequestJson = JSON.stringify(request);
  f.payload.command = privateNativeFileHelperCommand(f.payload.privateNativeFileRequestJson);
  return f;
}

it('uses a network-denying macOS wrapper for fixed file helpers without proxy initialization', async () => {
  const { payload, manager, spawn } = await privateFileFixture();
  const wrapPrivateFile = vi.fn(async () => 'fixed file sandbox');
  const dependencies = {
    manager,
    spawn: spawn as never,
    platform: 'darwin' as const,
    wrapPrivateFile,
  };
  expect(await runSandboxedWorker(payload, dependencies)).toBe(0);
  expect(wrapPrivateFile).toHaveBeenCalledWith(
    payload.command,
    expect.objectContaining({
      filesystem: expect.objectContaining({ allowWrite: [root] }),
      network: expect.objectContaining({ allowedDomains: [] }),
    }),
  );
  expect(manager.initialize).not.toHaveBeenCalled();
  expect(manager.wrapWithSandbox).not.toHaveBeenCalled();
  expect(manager.reset).not.toHaveBeenCalled();
  expect(spawn.mock.calls[0][1]).toEqual(['-c', 'fixed file sandbox']);
});

it('retains actual network and file restrictions in the fixed macOS helper policy', async () => {
  const { payload, manager, spawn } = await privateFileFixture();
  const secret = join(root, 'synthetic-private.json');
  await writeFile(secret, 'SYNTHETIC PRIVATE BYTES');
  payload.config.filesystem.denyRead = [secret];
  payload.config.filesystem.denyWrite = [secret];
  expect(
    await runSandboxedWorker(payload, { manager, spawn: spawn as never, platform: 'darwin' }),
  ).toBe(0);
  const command = spawn.mock.calls[0][1][1];
  expect(command).toContain('/usr/bin/sandbox-exec');
  expect(command).toMatch(/\(deny default(?:\s|\))/);
  expect(command).not.toContain('(allow network');
  expect(command).not.toContain('(allow system-socket (socket-domain AF_UNIX))');
  expect(command).not.toContain('(allow appleevent-send)');
  expect(command).not.toContain('(allow pseudo-tty)');
  expect(command).toContain(secret);
  expect(manager.initialize).not.toHaveBeenCalled();
});

it.each(['denyRead', 'allowRead', 'denyWrite', 'allowWrite', 'root-deny'] as const)(
  'generates the same complete fixed-helper policy for trailing /** and its literal %s directory',
  async (field) => {
    const { payload, manager, spawn } = await privateFileFixture();
    const path = field === 'root-deny' ? '/' : join(root, field);
    const key = field === 'root-deny' ? 'denyRead' : field;
    // Exercise a real allowRead carve-out rather than an unused allow entry.
    if (key === 'allowRead') payload.config.filesystem.denyRead = [root];
    payload.config.filesystem[key] = [path === '/' ? '/**' : path + '/**'];
    const dependencies = { manager, spawn: spawn as never, platform: 'darwin' as const };
    await expect(runSandboxedWorker(payload, dependencies)).resolves.toBe(0);
    const globCommand = spawn.mock.calls[0][1][1];
    payload.config.filesystem[key] = [path];
    await expect(runSandboxedWorker(payload, dependencies)).resolves.toBe(0);
    const literalCommand = spawn.mock.calls[1][1][1];
    // The command attribution token is the only per-invocation difference.
    const profile = (command: string) =>
      command.replace(/CMD64_[A-Za-z0-9+/=]+_END_/g, 'CMD64_<command-id>_END_');
    expect(profile(globCommand)).toBe(profile(literalCommand));
    expect(globCommand).toContain(`(subpath "${path}")`);
    expect(manager.initialize).not.toHaveBeenCalled();
  },
);

it('rechecks original fixed-helper authority after direct macOS wrapping before spawn', async () => {
  const { payload, manager, spawn } = await privateFileFixture();
  const wrapPrivateFile = vi.fn(async () => {
    renameSync(root, root + '-old');
    mkdirSync(root);
    return 'fixed file sandbox';
  });
  const dependencies = {
    manager,
    spawn: spawn as never,
    platform: 'darwin' as const,
    wrapPrivateFile,
  };
  await expect(runSandboxedWorker(payload, dependencies)).rejects.toThrow(
    'Sandbox authority changed',
  );
  expect(spawn).not.toHaveBeenCalled();
  expect(manager.initialize).not.toHaveBeenCalled();
});

it.each(['domains', 'local-binding', 'unix-sockets', 'environment'] as const)(
  'refuses fixed-helper %s expansion before selecting a direct wrapper',
  async (change) => {
    const { payload, manager, spawn } = await privateFileFixture();
    if (change === 'domains') payload.config.network.allowedDomains = ['example.test'];
    if (change === 'local-binding') payload.config.network.allowLocalBinding = true;
    if (change === 'unix-sockets') payload.config.network.allowAllUnixSockets = true;
    if (change === 'environment') payload.env = { SYNTHETIC: 'PRIVATE' };
    await expect(
      runSandboxedWorker(payload, { manager, spawn: spawn as never, platform: 'darwin' }),
    ).rejects.toThrow('Invalid private native file isolation');
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  },
);

it('keeps the existing proxy-backed Linux fixed-helper path', async () => {
  const { payload, manager, spawn } = await privateFileFixture();
  const wrapPrivateFile = vi.fn();
  const dependencies = {
    manager,
    spawn: spawn as never,
    platform: 'linux' as const,
    wrapPrivateFile,
  };
  expect(await runSandboxedWorker(payload, dependencies)).toBe(0);
  expect(wrapPrivateFile).not.toHaveBeenCalled();
  expect(manager.initialize).toHaveBeenCalledOnce();
  expect(manager.reset).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'preserves actual command termination with environment transfer %s',
  async (transferEnvironment) => {
    const { payload, manager } = fixture();
    // The OS wrapper is a fixture; execute the real worker, launcher and command
    // processes to verify termination propagation independently of kernel isolation.
    manager.wrapWithSandbox.mockImplementation(async (command) => command);
    if (transferEnvironment) payload.env = { PATH: '/usr/bin:/bin' };
    for (const [command, expected] of [
      ['exit 1', 1],
      ['kill -KILL $$', 255],
      ['exit 137', 137],
    ] as const) {
      expect(await runSandboxedWorker({ ...payload, command }, { manager, spawn: realSpawn })).toBe(
        expected,
      );
    }
  },
);

it.each([false, true])(
  'creates target scratch through the actual launcher with an explicit directory %s',
  async (explicit) => {
    const { payload, manager } = fixture();
    const selected = join(root, 'selected');
    const fallback = join(root, 'runtime');
    for (const directory of [selected, fallback]) mkdirSync(directory);
    const result = join(root, 'scratch-result');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const script = `const fs = require('node:fs'), path = require('node:path');
      const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR, 'child-'));
      fs.writeFileSync(${JSON.stringify(result)}, scratch);`;
    payload.command = [process.execPath, '-e', script].map(quote).join(' ');
    payload.env = { PATH: '/usr/bin:/bin', ...(explicit ? { TMPDIR: selected } : {}) };
    manager.wrapWithSandbox.mockImplementation(
      async (command) => `TMPDIR=${quote(fallback)} ${command}`,
    );
    expect(await runSandboxedWorker(payload, { manager, spawn: realSpawn })).toBe(0);
    expect(dirname(await readFile(result, 'utf8'))).toBe(explicit ? selected : fallback);
  },
);

it('enables proxy egress only for an explicitly approved network command', async () => {
  const { payload, manager, spawn } = fixture();
  payload.networkAccess = 'approved-command';
  expect(await runSandboxedWorker(payload, { manager, spawn: spawn as never })).toBe(0);
  const approve = manager.initialize.mock.calls[0][1];
  expect(approve).toBeTypeOf('function');
  expect(await approve!({ host: 'registry.npmjs.org', port: 443 })).toBe(true);
  expect(manager.initialize.mock.calls[0][0].network.allowedDomains).toEqual([]);
  expect(manager.reset).toHaveBeenCalledOnce();
});

it('keeps networking denied by default and rejects an invalid network authorization', async () => {
  const { payload, manager, spawn } = fixture();
  expect(await runSandboxedWorker(payload, { manager, spawn: spawn as never })).toBe(0);
  expect(manager.initialize.mock.calls[0][1]).toBeUndefined();
  manager.initialize.mockClear();
  spawn.mockClear();
  payload.networkAccess = 'allow' as never;
  await expect(runSandboxedWorker(payload, { manager, spawn: spawn as never })).rejects.toThrow(
    /network authorization/,
  );
  expect(manager.initialize).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it('keeps a loopback task grant out of the general network approval callback', async () => {
  const { payload, manager, spawn } = fixture();
  payload.networkAccess = 'loopback';
  expect(await runSandboxedWorker(payload, { manager, spawn: spawn as never })).toBe(0);
  expect(manager.initialize.mock.calls[0][1]).toBeUndefined();
});

it('rejects replacement during SRT initialization before constructing the sandbox', async () => {
  const { payload, manager, spawn } = fixture();
  let finish!: () => void;
  manager.initialize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const result = runSandboxedWorker(payload, { manager, spawn: spawn as never });
  renameSync(root, root + '-old');
  mkdirSync(root);
  finish();
  await expect(result).rejects.toThrow(/Sandbox authority changed/);
  expect(manager.wrapWithSandbox).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(manager.reset).toHaveBeenCalledOnce();
});

it('revalidates Git authority after asynchronous sandbox construction before inner spawn', async () => {
  const { payload, manager, spawn } = fixture();
  const marker = join(root, '.git');
  await writeFile(marker, 'gitdir: /original');
  const authority = new AuthoritySnapshot();
  authority.capture(root);
  authority.capture(marker, true);
  payload.authority = JSON.parse(JSON.stringify(authority.serialize()));
  let finish!: (command: string) => void;
  manager.wrapWithSandbox.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const result = runSandboxedWorker(payload, { manager, spawn: spawn as never });
  await vi.waitFor(() => expect(manager.wrapWithSandbox).toHaveBeenCalled());
  writeFileSync(marker, 'gitdir: /replacement');
  finish('wrapped command');
  await expect(result).rejects.toThrow(/Sandbox authority changed/);
  expect(spawn).not.toHaveBeenCalled();
  expect(manager.reset).toHaveBeenCalledOnce();
});

it('spawns the wrapped command in the worker process group only after validation', async () => {
  const { payload, manager, spawn } = fixture();
  expect(await runSandboxedWorker(payload, { manager, spawn: spawn as never })).toBe(0);
  expect(spawn).toHaveBeenCalledWith(
    '/bin/sh',
    ['-c', 'wrapped command'],
    expect.objectContaining({ cwd: root, detached: false, stdio: 'inherit' }),
  );
  expect(manager.reset).toHaveBeenCalledOnce();
});

it('transfers target environment over a pipe only after the OS sandbox, never through arguments or bootstrap', async () => {
  const { payload, manager, spawn } = fixture();
  const transfer = new PassThrough();
  const chunks: Buffer[] = [];
  transfer.on('data', (data) => chunks.push(data));
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, transfer] });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  payload.env = { LD_PRELOAD: '/untrusted/preload.so', PATH: '/untrusted/bin', VALUE: "a'b" };
  expect(await runSandboxedWorker(payload, { manager, spawn: spawn as never })).toBe(0);
  const wrappedCommand = manager.wrapWithSandbox.mock.calls[0][0];
  expect(wrappedCommand).toContain('fd: 3');
  expect(wrappedCommand).not.toContain('/untrusted');
  expect(manager.wrapWithSandbox.mock.calls[0][4]).toMatchObject({ commandId: expect.any(String) });
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
    command: payload.command,
    env: payload.env,
  });
  expect(spawn.mock.calls[0][2].env).toBe(process.env);
});

it('uses a filesystem-only OS wrapper without initializing network proxies and preserves target environment transfer', async () => {
  const { payload, manager, spawn } = fixture();
  payload.filesystemOnly = true;
  payload.env = {
    AUTH_SECRET: 'synthetic project secret',
    CUSTOM_MCP_TOKEN: 'synthetic MCP token',
  };
  const transfer = new PassThrough();
  const chunks: Buffer[] = [];
  transfer.on('data', (data) => chunks.push(data));
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, transfer] });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  const wrapFilesystem = vi.fn().mockResolvedValue('filesystem-only command');
  expect(
    await runSandboxedWorker(payload, {
      manager,
      spawn: spawn as never,
      platform: 'darwin',
      wrapFilesystem,
    }),
  ).toBe(0);
  expect(manager.initialize).not.toHaveBeenCalled();
  expect(manager.wrapWithSandbox).not.toHaveBeenCalled();
  expect(wrapFilesystem).toHaveBeenCalledWith(expect.stringContaining('fd: 3'), payload.config);
  expect(spawn.mock.calls[0][1]).toEqual(['-c', 'filesystem-only command']);
  expect(JSON.parse(Buffer.concat(chunks).toString()).env).toEqual(payload.env);
});

it('rejects malformed filesystem-only mode and unsupported platforms before executing a child', async () => {
  const { payload, manager, spawn } = fixture();
  payload.filesystemOnly = 'true' as never;
  await expect(runSandboxedWorker(payload, { manager, spawn: spawn as never })).rejects.toThrow(
    /filesystem-only/,
  );
  payload.filesystemOnly = true;
  await expect(
    runSandboxedWorker(payload, { manager, spawn: spawn as never, platform: 'linux' }),
  ).rejects.toThrow(/macOS/);
  expect(manager.initialize).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it('rechecks filesystem-only authority after wrapper preparation and before child spawn', async () => {
  const { payload, manager, spawn } = fixture();
  payload.filesystemOnly = true;
  const wrapFilesystem = vi.fn(async () => {
    renameSync(root, root + '-old');
    mkdirSync(root);
    return 'filesystem-only command';
  });
  await expect(
    runSandboxedWorker(payload, {
      manager,
      spawn: spawn as never,
      platform: 'darwin',
      wrapFilesystem,
    }),
  ).rejects.toThrow(/Sandbox authority changed/);
  expect(spawn).not.toHaveBeenCalled();
});

it('builds runtime-only policy with unrestricted networking and filesystem fencing while denying AppleEvents delegation', async () => {
  const { payload, manager, spawn } = fixture();
  payload.filesystemOnly = true;
  const secret = join(root, 'operator.json');
  await writeFile(secret, 'synthetic metadata');
  payload.config.filesystem.denyRead = [secret];
  payload.config.filesystem.denyWrite = [secret];
  expect(
    await runSandboxedWorker(payload, { manager, spawn: spawn as never, platform: 'darwin' }),
  ).toBe(0);
  const command = spawn.mock.calls[0][1][1];
  expect(command).toContain('(allow network*)');
  expect(command).not.toContain('(deny network');
  expect(command).toContain('(global-name-prefix "")');
  expect(command).not.toContain('(allow appleevent-send)');
  expect(command).toMatch(/\(deny default(?:\s|\))/);
  expect(command).toContain(secret);
  expect(manager.initialize).not.toHaveBeenCalled();
});

it.each(['program', 'operation', 'network'] as const)(
  'rejects a private helper %s substitution before initializing policy or spawning',
  async (change) => {
    const { payload, manager, spawn } = fixture();
    const request = {
      operation: 'CreateDirectory',
      file_path: root + '/child',
      rootAnchor: { rootPath: root, identity: { dev: '1', ino: '2' } },
      parentIdentity: { dev: '1', ino: '2' },
      expectedAbsent: true,
      deniedRoots: [],
      identity: null,
      limit: 1,
      timeoutMs: 1000,
    };
    const { privateNativeFileHelperCommand } = await import('../native-file-operation.js');
    payload.privateNativeFileRequestJson = JSON.stringify(request);
    payload.command = privateNativeFileHelperCommand(payload.privateNativeFileRequestJson);
    if (change === 'program') payload.command = 'arbitrary shell text';
    if (change === 'operation')
      payload.privateNativeFileRequestJson = JSON.stringify({ ...request, operation: 'Write' });
    if (change === 'network') payload.networkAccess = 'approved-command';
    await expect(runSandboxedWorker(payload, { manager, spawn: spawn as never })).rejects.toThrow();
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  },
);

it.each(['config', 'private-root'] as const)(
  'refuses private checkout %s replacement across SRT wrapping before spawn',
  async (change) => {
    const { payload, manager, spawn } = fixture();
    const git = join(root, 'git-admin');
    mkdirSync(git);
    const config = join(git, 'config');
    writeFileSync(config, 'SYNTHETIC CONFIG');
    const authority = new AuthoritySnapshot();
    authority.capture(root);
    authority.capture(config, true);
    payload.authority = authority.serialize();
    payload.privateRepositoryCheckoutJson = JSON.stringify({
      scratch: root,
      baseOid: 'a'.repeat(40),
      objectFormat: 'sha1',
    });
    const { privateRepositoryCheckoutCommand } = await import('../private-repository-checkout.js');
    payload.command = privateRepositoryCheckoutCommand(payload.privateRepositoryCheckoutJson);
    manager.wrapWithSandbox.mockImplementation(async () => {
      if (change === 'config') writeFileSync(config, 'REPLACEMENT CONFIG');
      else {
        renameSync(git, git + '-retained');
        mkdirSync(git);
        writeFileSync(config, 'SYNTHETIC CONFIG');
      }
      return 'wrapped';
    });
    await expect(runSandboxedWorker(payload, { manager, spawn: spawn as never })).rejects.toThrow(
      'Sandbox authority changed',
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.reset).toHaveBeenCalledOnce();
  },
);
it('rejects substituted private checkout commands before sandbox setup', async () => {
  const { payload, manager, spawn } = fixture();
  payload.privateRepositoryCheckoutJson = JSON.stringify({
    scratch: root,
    baseOid: 'a'.repeat(40),
    objectFormat: 'sha1',
  });
  payload.command = 'git -C /synthetic/forbidden-source status';
  await expect(runSandboxedWorker(payload, { manager, spawn: spawn as never })).rejects.toThrow(
    'Invalid private repository checkout',
  );
  expect(manager.initialize).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
it.each(['linux', 'darwin'] as const)(
  'validates fixed private program and request bytes again after asynchronous %s wrapping',
  async (platform) => {
    const {
      nativeFileHelperProgram,
      privateNativeFileProgramCommand,
      projectPrivateNativeFileHelperRequest,
    } = await import('../native-file-operation.js');
    const { payload, manager, spawn } = fixture();
    vi.stubEnv('HOME', join(root, 'home'));
    const programPath = join(root, 'helper.py'),
      requestPath = join(root, 'request.json');
    const rootInfo = new AuthoritySnapshot();
    rootInfo.capture(root);
    const rootIdentity = rootInfo.serialize().find((item) => item.path === root)!.stat!;
    const requestJson = projectPrivateNativeFileHelperRequest(
      JSON.stringify({
        operation: 'CreateDirectory',
        identity: null,
        limit: 1,
        timeoutMs: 1000,
        file_path: join(root, 'target'),
        rootAnchor: { rootPath: root, identity: { dev: rootIdentity.dev, ino: rootIdentity.ino } },
        parentIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        expectedAbsent: true,
        deniedRoots: [],
      }),
    );
    await writeFile(programPath, nativeFileHelperProgram);
    await writeFile(requestPath, requestJson);
    rootInfo.capture(programPath, true);
    rootInfo.capture(requestPath, true);
    payload.authority = rootInfo.serialize();
    payload.privateNativeFileRequestJson = requestJson;
    payload.privateNativeFileProgram = { programPath, requestPath };
    payload.command = privateNativeFileProgramCommand(programPath, requestPath);
    const wrapPrivateFile = vi.fn(async () => 'fixed file sandbox');
    const dependencies = { manager, spawn: spawn as never, platform, wrapPrivateFile };
    try {
      expect(await runSandboxedWorker(payload, dependencies)).toBe(0);
      spawn.mockClear();
      const substitute = async () => {
        writeFileSync(programPath, 'FOREIGN PROGRAM');
        return 'wrapped';
      };
      manager.wrapWithSandbox.mockImplementation(substitute);
      wrapPrivateFile.mockImplementation(substitute);
      await expect(runSandboxedWorker(payload, dependencies)).rejects.toThrow(
        'Sandbox authority changed',
      );
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('moves an opted-in host GitHub login from bootstrap into only the target environment', () => {
  const bootstrap: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    [HOST_GITHUB_TOKEN_TRANSFER]: 'gho_syntheticHostLogin',
  };
  const payload: Pick<SandboxWorkerPayload, 'env' | 'hostGithubToken'> = {
    env: { HOME: '/home' },
    hostGithubToken: true,
  };
  const transfer = takeHostGithubTransfer(bootstrap);
  expect(bootstrap).not.toHaveProperty(HOST_GITHUB_TOKEN_TRANSFER);
  admitHostGithubToken(payload, transfer);
  expect(payload.env).toEqual({ HOME: '/home', GH_TOKEN: 'gho_syntheticHostLogin' });

  const plain: Pick<SandboxWorkerPayload, 'env'> = { env: { HOME: '/home' } };
  admitHostGithubToken(plain, takeHostGithubTransfer({}));
  expect(plain.env).toEqual({ HOME: '/home' });
  // Neither side may supply the credential alone.
  expect(() => admitHostGithubToken(plain, 'gho_unrequested')).toThrow();
  expect(() => admitHostGithubToken({ env: {}, hostGithubToken: true }, undefined)).toThrow();
  expect(() => admitHostGithubToken({ hostGithubToken: true }, 'gho_x')).toThrow();
});

it('keeps the worker and controller names for the host GitHub transfer identical', () => {
  expect(WORKER_HOST_GITHUB_TOKEN_TRANSFER).toBe(HOST_GITHUB_TOKEN_TRANSFER);
});
