import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { credentialSdkBoundary, runtimeFilesystemSdkBoundary } from '../credential-sdk-boundary.js';
import {
  createProtectedSdkCommandRunner,
  createWorkspaceRuntimeCommandRunner,
} from '../protected-sdk-command.js';

vi.mock('../credential-connections-runtime.js', () => ({
  getCredentialConnectionsRuntime: () => undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, existsSync: vi.fn(fs.existsSync) };
});
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: { checkDependencies: () => ({ errors: [], warnings: [] }) },
}));
vi.mock('node:child_process', async (original) => {
  const process = await original<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    ...process,
    spawn: vi.fn(() =>
      Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }),
    ),
  };
});

let root: string;
let enrollment: string;
let config: string;
let interpreter: string;
beforeEach(async () => {
  const temporaryBase = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
  root = realpathSync(mkdtempSync(join(temporaryBase, 'mitzo-sdk-runtime-policy-')));
  mkdirSync(join(root, 'operator'));
  mkdirSync(join(root, 'environment', 'bin'), { recursive: true });
  mkdirSync(join(root, 'work'));
  writeFileSync(join(root, 'environment', 'pyvenv.cfg'), 'synthetic environment');
  interpreter = join(root, 'environment', 'bin', 'python');
  writeFileSync(interpreter, 'synthetic interpreter');
  config = join(root, 'operator', 'runtime.json');
  enrollment = join(root, 'operator', 'enrollment.json');
  writeFileSync(
    config,
    JSON.stringify({ gwsExecutable: join(root, 'gws'), jiraLibPath: join(root, 'jira') }),
    { mode: 0o600 },
  );
  writeFileSync(
    enrollment,
    JSON.stringify({
      kind: 'workspace-runtime-v1',
      config,
      release: join(root, 'release'),
      python: interpreter,
    }),
    { mode: 0o600 },
  );
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', enrollment);
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '0');
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_DIR', join(root, 'missing-keychain'));
  vi.stubEnv('PATH', '/usr/bin:/bin:/opt/homebrew/bin');
  // Simulate a host with no Keychain feature/storage. Runtime fixtures still
  // expose their synthetic venv metadata; no host secrets are read.
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(existsSync).mockImplementation(
    (path) => String(path).startsWith(root + '/') && actual.existsSync(path),
  );
  vi.mocked(spawn).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function sdkPayload(env: NodeJS.ProcessEnv = {}) {
  const boundary = credentialSdkBoundary('darwin');
  expect(boundary).toBeDefined();
  boundary!.spawnClaudeCodeProcess({
    command: process.execPath,
    args: ['-e', "throw new Error('fixture must never execute')"],
    cwd: join(root, 'work'),
    env,
    signal: new AbortController().signal,
  });
  const argv = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
  const payload = JSON.parse(readFileSync(argv.at(-1)!, 'utf8'));
  const fixtureChild = vi.mocked(spawn).mock.results.at(-1)!
    .value as import('node:events').EventEmitter;
  fixtureChild.emit('close', 0, null);
  return payload as import('../sandboxed-command-worker.js').SandboxWorkerPayload;
}
function policy() {
  return sdkPayload().config.filesystem as {
    denyRead: string[];
    denyWrite: string[];
    allowWrite: string[];
  };
}

it('activates the outer SDK boundary without Keychain and fences enrolled authority before any runtime use', () => {
  expect(credentialSdkBoundary('darwin')!.credentialIsolation).toBe(false);
  const filesystem = policy();
  expect(filesystem.denyRead).toContain(enrollment);
  expect(filesystem.denyRead).toContain(config);
  expect(filesystem.denyWrite).toContain(dirname(enrollment));
  expect(filesystem.denyWrite).toContain(join(root, 'release'));
  expect(filesystem.denyWrite).toContain(join(root, 'jira'));
  expect(filesystem.denyWrite).toContain(join(root, 'environment'));
});
it('retains operator fences after enrollment removal while leaving interpreter reads and ordinary work available', () => {
  policy();
  delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
  const filesystem = policy();
  expect(filesystem.denyRead).toContain(config);
  expect(filesystem.denyRead).not.toContain(interpreter);
  expect(filesystem.denyRead).not.toContain(join(root, 'environment'));
  expect(filesystem.denyWrite).toContain(dirname(config));
  expect(filesystem.denyWrite).not.toContain(join(root, 'work'));
  expect(filesystem.denyWrite).not.toContain('/private/tmp');
});
it('protects selector pointer entries without denying their shared target subtree', () => {
  const alias = join(root, 'provider-link');
  symlinkSync('/private/tmp', alias);
  writeFileSync(
    config,
    JSON.stringify({
      gwsExecutable: join(alias, 'synthetic-gws'),
      jiraLibPath: join(root, 'jira'),
    }),
  );
  const filesystem = policy();
  expect(filesystem.denyWrite.some((path) => path.includes('provider-lin[k]'))).toBe(true);
  expect(filesystem.denyWrite).not.toContain('/private/tmp');
});
it('fails closed on malformed runtime authority before starting an SDK process', () => {
  writeFileSync(config, '{malformed');
  expect(() => credentialSdkBoundary()).toThrow();
  expect(spawn).not.toHaveBeenCalled();
});

async function installedMacSrt() {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve('@anthropic-ai/sandbox-runtime'));
  return import(pathToFileURL(join(directory, 'sandbox', 'macos-sandbox-utils.js')).href);
}

function selectorFixture() {
  const directory = join(root, 'selector-box');
  mkdirSync(directory);
  const target = join(root, 'gws');
  writeFileSync(target, 'synthetic provider');
  const link = join(directory, 'link');
  symlinkSync(target, link);
  const selected = root.startsWith('/private/tmp/') ? link.replace('/private/tmp/', '/tmp/') : link;
  writeFileSync(
    config,
    JSON.stringify({ gwsExecutable: selected, jiraLibPath: join(root, 'jira') }),
  );
  return { directory, target, link };
}

it('uses installed pinned SRT exact-glob and ancestor move rules without denying the temporary subtree', async () => {
  const selector = selectorFixture();
  const filesystem = policy();
  const { wrapCommandWithSandboxMacOS } = await installedMacSrt();
  const wrapped: string = wrapCommandWithSandboxMacOS({
    command: 'true',
    needsNetworkRestriction: false,
    binShell: '/bin/sh',
    readConfig: { denyOnly: filesystem.denyRead },
    writeConfig: { allowOnly: filesystem.allowWrite, denyWithinAllow: filesystem.denyWrite },
  });
  // This is the installed SRT profile, not a hand-written matcher. Its move
  // rules protect selector ancestors even after the provider is running.
  expect(wrapped).toContain('file-write-unlink file-write-create');
  expect(wrapped).toContain(`literal "${selector.directory}"`);
  expect(wrapped).not.toContain('subpath "/private/tmp"');
  if (root.startsWith('/private/tmp/')) {
    expect(filesystem.denyWrite).toContain('/tm[p]');
    expect(wrapped).toContain('^/tm[p](/.*)?$');
  }
});

it.runIf(process.platform === 'darwin' && process.env.MITZO_TEST_OS_SANDBOX === '1')(
  'physically fences SDK authority and selector-parent replacement while permitting unrelated temporary work',
  async () => {
    const selector = selectorFixture();
    const filesystem = policy();
    const { wrapCommandWithSandboxMacOS } = await installedMacSrt();
    const paths = { enrollment, config, interpreter, selector, work: join(root, 'work') };
    const probe = `
      const fs=require('node:fs'),p=${JSON.stringify(paths)};
      function denied(action,code){try{action();process.exit(code)}catch{}}
      denied(()=>fs.readFileSync(p.enrollment),70);
      denied(()=>fs.writeFileSync(p.config,'changed metadata'),71);
      denied(()=>fs.renameSync(require('node:path').dirname(p.config),p.work+'/moved-operator'),72);
      denied(()=>fs.writeFileSync(p.selector.target,'changed provider'),73);
      denied(()=>fs.unlinkSync(p.selector.link),74);
      denied(()=>fs.renameSync(p.selector.directory,p.work+'/moved-selector'),75);
      if(fs.readFileSync(p.interpreter,'utf8')!=='synthetic interpreter')process.exit(76);
      fs.writeFileSync(p.work+'/report.md','synthetic report');
      const temporary=fs.mkdtempSync('/private/tmp/sdk-unrelated-work-');
      fs.writeFileSync(temporary+'/analysis.txt','synthetic analysis');
      fs.rmSync(temporary,{recursive:true});
      process.stdout.write('sdk-authority-os-ok');
    `;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const wrapped: string = wrapCommandWithSandboxMacOS({
      command: [process.execPath, '-e', probe].map(quote).join(' '),
      needsNetworkRestriction: false,
      binShell: '/bin/sh',
      readConfig: { denyOnly: filesystem.denyRead },
      writeConfig: { allowOnly: filesystem.allowWrite, denyWithinAllow: filesystem.denyWrite },
    });
    expect(
      execFileSync('/bin/sh', ['-c', wrapped], {
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 5000,
      }),
    ).toBe('sdk-authority-os-ok');
    expect(readFileSync(join(root, 'work', 'report.md'), 'utf8')).toBe('synthetic report');
    expect(readFileSync(selector.target, 'utf8')).toBe('synthetic provider');
  },
);

it('keeps original Keychain activation distinct from runtime-only filesystem isolation', () => {
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  expect(credentialSdkBoundary('darwin')!.credentialIsolation).toBe(true);
});

it('fences enrolled controller commands independently of Keychain while preserving their network and environment mode', async () => {
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9999');
  expect(runtimeFilesystemSdkBoundary('darwin')!.credentialIsolation).toBe(false);
  const runner = createWorkspaceRuntimeCommandRunner('darwin')!;
  const promise = runner('synthetic-command', ['synthetic-argument'], {
    cwd: join(root, 'work'),
    env: { AUTH_SECRET: 'synthetic retained environment' },
    timeout: 1000,
  });
  const argv = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
  const payload = JSON.parse(readFileSync(argv.at(-1)!, 'utf8'));
  expect(payload.filesystemOnly).toBe(true);
  expect(payload.env.AUTH_SECRET).toBe('synthetic retained environment');
  expect(payload.config.filesystem.denyRead).toContain(config);
  expect(payload.config.filesystem.denyWrite).toContain(join(root, 'release'));
  const child = vi.mocked(spawn).mock.results.at(-1)!.value as import('node:events').EventEmitter;
  child.emit('close', 0, null);
  await expect(promise).resolves.toEqual({ stdout: '', stderr: '' });
});

it('retains runtime-only project credentials and custom endpoint behavior while Keychain mode keeps credential restrictions', () => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9999');
  const env = {
    AUTH_SECRET: 'synthetic project value',
    GH_TOKEN: 'synthetic project token',
    MITZO_CUSTOM_TOKEN: 'synthetic project token',
  };
  const payload = sdkPayload(env);
  expect(payload.filesystemOnly).toBe(true);
  expect(payload.env).toEqual(env);
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  expect(() => credentialSdkBoundary('darwin')).toThrow(/hostname provider endpoint/);
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://synthetic-provider.example');
  const credentialPayload = sdkPayload(env);
  expect(credentialPayload.filesystemOnly).toBeUndefined();
  expect(credentialPayload.env).toEqual({});
  expect(credentialPayload.config.network.allowedDomains).toContain('synthetic-provider.example');
});

it.runIf(process.platform === 'darwin' && process.env.MITZO_TEST_OS_SANDBOX === '1')(
  'physically fences restored controller commands through the protected SDK worker with stdin and environment preserved',
  async () => {
    const selector = selectorFixture();
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const previous = vi.mocked(spawn).getMockImplementation()!;
    vi.mocked(spawn).mockImplementation(actual.spawn as never);
    try {
      const run = createProtectedSdkCommandRunner(credentialSdkBoundary('darwin')!);
      const script = `
        const fs=require('node:fs'),p=${JSON.stringify({ config, enrollment, selector, work: join(root, 'work') })};
        function denied(action,code){try{action();process.exit(code)}catch{}}
        denied(()=>fs.readFileSync(p.enrollment),70);
        denied(()=>fs.writeFileSync(p.config,'changed metadata'),71);
        denied(()=>fs.writeFileSync(p.selector.target,'changed provider'),72);
        denied(()=>fs.renameSync(p.selector.directory,p.work+'/moved-selector'),73);
        if(process.env.AUTH_SECRET!=='synthetic project value')process.exit(74);
        if(fs.readFileSync(0,'utf8')!=='synthetic-hook-input')process.exit(75);
        fs.writeFileSync(p.work+'/callback-report.md','synthetic callback report');
        process.stderr.write('synthetic diagnostic');
        process.stdout.write('protected-callback-os-ok');
      `;
      expect(
        await run(process.execPath, ['-e', script], {
          cwd: join(root, 'work'),
          env: { PATH: '/usr/bin:/bin', AUTH_SECRET: 'synthetic project value' },
          timeout: 5000,
          input: 'synthetic-hook-input',
        }),
      ).toEqual({ stdout: 'protected-callback-os-ok', stderr: 'synthetic diagnostic' });
      expect(readFileSync(join(root, 'work', 'callback-report.md'), 'utf8')).toBe(
        'synthetic callback report',
      );
    } finally {
      vi.mocked(spawn).mockImplementation(previous);
    }
  },
);
