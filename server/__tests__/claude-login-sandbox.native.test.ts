import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import * as boundaries from '../credential-sdk-boundary.js';
import { createClaudeLoginProcess } from '../claude-login-process.js';
import { claudeSdkExecutable } from '../claude-subscription-custody.js';

const roots: string[] = [];
const native = it.runIf(process.env.MITZO_TEST_CLAUDE_LOGIN_SANDBOX === '1');
beforeEach(() => {
  resetOfflineUserEnvironment();
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function disposableAccount() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-login-sandbox-')));
  roots.push(root);
  const config = join(root, 'config');
  mkdirSync(config, { mode: 0o700 });
  vi.stubEnv('HOME', root);
  return { root, config };
}

native(
  'keeps callback listeners denied in ordinary model sessions',
  async () => {
    expect(process.platform).toBe('darwin');
    const { root } = disposableAccount();
    const controller = new AbortController();
    const child = boundaries.credentialSdkBoundary()!.spawnClaudeCodeProcess({
      command: process.execPath,
      args: [
        '-e',
        "require('node:net').createServer().on('error',e=>process.exit(['EPERM','EACCES'].includes(e.code)?73:74)).listen(0,'127.0.0.1',()=>process.exit(75))",
      ],
      cwd: root,
      env: { HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      signal: controller.signal,
      captureStderr: true,
    });
    child.stdout.resume();
    child.stderr.resume();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.once('close', resolve);
      });
      expect(code).toBe(73);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  },
  20_000,
);

native(
  'reproduces native sign-in failure with the former piped-input launch',
  async () => {
    expect(process.platform).toBe('darwin');
    const { root, config } = disposableAccount();
    const controller = new AbortController();
    const child = boundaries.credentialSdkBoundary()!.spawnClaudeCodeProcess({
      command: claudeSdkExecutable(),
      args: ['auth', 'login', '--claudeai'],
      cwd: config,
      env: {
        HOME: root,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        CLAUDE_CONFIG_DIR: config,
        BROWSER: '/usr/bin/false',
        DISABLE_AUTOUPDATER: '1',
      },
      signal: controller.signal,
      captureStderr: true,
    });
    child.stdout.resume();
    child.stderr.resume();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.once('close', resolve);
      });
      expect(code).toBe(1);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  },
  25_000,
);

native(
  'keeps local controller connections denied in the login sandbox',
  async () => {
    expect(process.platform).toBe('darwin');
    const { root } = disposableAccount();
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as import('node:net').AddressInfo).port;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const child = boundaries.claudeLoginSdkBoundary()!.spawnClaudeCodeProcess({
        command: process.execPath,
        args: [
          '-e',
          `require('node:net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(75)).on('error',e=>process.exit(['EPERM','EACCES'].includes(e.code)?73:74))`,
        ],
        cwd: root,
        env: { HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        signal: controller.signal,
        captureStderr: true,
      });
      child.stdout.resume();
      child.stderr.resume();
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.once('close', resolve);
      });
      expect(code).toBe(73);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  20_000,
);

native(
  'gets a real native sign-in link inside the protected launcher with an empty account',
  async () => {
    expect(process.platform).toBe('darwin');
    const { config } = disposableAccount();
    // No code is submitted, no real account is used, and no model request is made.
    const controller = new AbortController();
    const login = await createClaudeLoginProcess(config, controller.signal);
    try {
      expect(new URL(login.url).origin).toBe('https://claude.com');
      expect(new URL(login.url).searchParams.get('code_challenge_method')).toBe('S256');
    } finally {
      await login.cancel();
    }
    expect(await login.completion).toMatchObject({ ok: false });
  },
  30_000,
);
