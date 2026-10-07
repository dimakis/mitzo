import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialSdkBoundary } from '../credential-sdk-boundary.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('protects configured private storage and canonical symlinks with an outer SDK spawn boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-sdk-boundary-'));
  roots.push(root);
  const privateRoot = join(root, 'private');
  const alias = join(root, 'alias');
  mkdirSync(privateRoot);
  symlinkSync(privateRoot, alias);
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_DIR', alias);
  const boundary = credentialSdkBoundary();
  expect(boundary).toBeDefined();
  expect(boundary!.deniedRoots).toContain(realpathSync(privateRoot));
  expect(boundary!.spawnClaudeCodeProcess).toBeTypeOf('function');
});
it('protects storage when explicitly enabled before the controller files are created', () => {
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  expect(credentialSdkBoundary()).toBeDefined();
});

it.runIf(process.env.MITZO_TEST_OS_SANDBOX === '1')(
  'runs untrusted SDK read and arbitrary child shell inside an immutable OS boundary',
  async () => {
    const { writeFileSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    const dependencies = SandboxManager.checkDependencies();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-sdk-os-probe-')));
    roots.push(root);
    const secretRoot = join(root, 'private');
    mkdirSync(secretRoot);
    writeFileSync(join(secretRoot, 'controller.json'), 'DISPOSABLE_SECRET');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: root,
          paths: { '@anthropic-ai/sandbox-runtime': ['./evil.js'] },
        },
      }),
    );
    writeFileSync(
      join(root, 'evil.js'),
      'process.stdout.write("UNSANDBOXED_BOOTSTRAP");process.exit(0);',
    );
    vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_DIR', secretRoot);
    const boundary = credentialSdkBoundary()!;
    const script = `
    const fs=require('node:fs'),cp=require('node:child_process');
    const target=${JSON.stringify(join(secretRoot, 'controller.json'))};
    try { fs.readFileSync(target); process.exit(70); } catch {}
    try { cp.execFileSync('/bin/sh',['-c', 'cat "$1"','probe',target],{stdio:'pipe'}); process.exit(71); } catch {}
    try { fs.writeFileSync(target,'bad'); process.exit(72); } catch {}
    try { fs.renameSync(${JSON.stringify(root)},${JSON.stringify(root + '-moved')}); process.exit(73); } catch {}
    if (fs.readFileSync(0,'utf8') !== 'fixture user prompt') process.exit(74);
    if (process.env.LARGE_FIXTURE.length !== 100000) process.exit(75);
    process.stdout.write('sdk-stdio-ok');
  `;
    if (dependencies.errors.length || dependencies.warnings.length) {
      expect(() =>
        boundary.spawnClaudeCodeProcess({
          command: process.execPath,
          args: ['-e', script],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        }),
      ).toThrow(/complete OS sandbox dependencies/);
      return;
    }
    const processHandle = boundary.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ['-e', script],
      cwd: root,
      env: {
        PATH: process.env.PATH,
        NODE_PATH: '/untrusted',
        DYLD_INSERT_LIBRARIES: '/untrusted',
        LARGE_FIXTURE: 'x'.repeat(100_000),
      },
      signal: new AbortController().signal,
    });
    processHandle.stdin.end('fixture user prompt');
    const output: Buffer[] = [];
    processHandle.stdout.on('data', (data) => output.push(data));
    const exit = await new Promise<number | null>((resolve, reject) => {
      processHandle.once('error', reject);
      processHandle.once('exit', resolve);
    });
    expect(exit).toBe(0);
    expect(Buffer.concat(output).toString()).toBe('sdk-stdio-ok');
    expect(
      execFileSync('/bin/cat', [join(secretRoot, 'controller.json')], { encoding: 'utf8' }),
    ).toBe('DISPOSABLE_SECRET');
    const cancelled = new AbortController();
    const waiting = boundary.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      cwd: root,
      env: { PATH: process.env.PATH },
      signal: cancelled.signal,
    });
    waiting.stdout.once('data', () => cancelled.abort());
    const stopped = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      waiting.once('error', reject);
      waiting.once('exit', (_code, signal) => resolve(signal));
    });
    expect(stopped).toBe('SIGKILL');
    expect(waiting.killed).toBe(true);
  },
  30_000,
);
