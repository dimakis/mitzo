/** No model calls. Run outside an existing macOS Seatbelt sandbox.
 * Usage: node scripts/qualify-codex-native-permissions.mjs /absolute/pinned/codex
 * Only an official pinned digest is accepted. Every file/home is synthetic.
 * This proves named profile union enforcement, not a model approval round trip.
 */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

assert.equal(process.platform, 'darwin', 'This fixture qualifies macOS Seatbelt only');
const binary = process.argv[2];
assert.ok(binary && isAbsolute(binary), 'Supply the pinned executable absolute path');
const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
assert.equal(digest, '112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b');
const root = mkdtempSync(join(tmpdir(), 'mitzo-native-enforcement-'));
const home = join(root, 'private-home');
const workspace = join(root, 'work');
const extra = join(root, 'extra');
const secrets = join(home, 'credentials');
const runtime = join(home, 'tmp', 'arg0');
for (const path of [home, workspace, extra, secrets, runtime]) mkdirSync(path, { recursive: true });
const secret = join(secrets, 'synthetic-auth.txt');
writeFileSync(secret, 'synthetic credential marker');
const helper = join(runtime, 'synthetic-execve-wrapper');
writeFileSync(helper, '#!/bin/sh\nprintf helper-executed');
chmodSync(helper, 0o700);
const base = { '/': 'read', [workspace]: 'write', [secrets]: 'deny' };
const profiles = {
  base,
  granted: { ...base, [extra]: 'write' },
  broadPrivateHomeDenyWithoutException: { ...base, [home]: 'deny' },
  broadPrivateHomeDeny: { ...base, [home]: 'deny', [runtime]: 'read' },
  hostileCredentialChildGrant: { ...base, [secret]: 'read' },
};
// JSON string keys and simple access strings are also valid TOML inline tables.
const table = (entries) =>
  `{ ${Object.entries(entries)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(', ')} }`;
writeFileSync(
  join(home, 'config.toml'),
  [
    'default_permissions = "base"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    'cli_auth_credentials_store = "file"',
    '[features]',
    'remote_control = false',
    'analytics = false',
    ...Object.entries(profiles).flatMap(([name, entries]) => [
      `[permissions.${name}]`,
      `filesystem = ${table(entries)}`,
      'network = { enabled = false }',
    ]),
  ].join('\n'),
);
// No inherited account, API key, config, proxy or auth environment.
const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: root,
  CODEX_HOME: home,
  TMPDIR: root,
  RUST_LOG: 'off',
};
const version = spawnSync(binary, ['--version'], { env, encoding: 'utf8' });
assert.equal(version.status, 0);
assert.equal(version.stdout.trim(), 'codex-cli 0.160.0');
const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
  cwd: workspace,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nextId = 1;
const pending = new Map();
let stderr = '';
child.stderr.on('data', (data) => {
  stderr = (stderr + data).slice(-4096);
});
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!pending.has(message.id)) return;
  const callback = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
  else callback.resolve(message.result);
});
child.on('error', (error) => {
  for (const callback of pending.values()) callback.reject(error);
});
child.on('exit', () => {
  for (const callback of pending.values())
    callback.reject(new Error(`Native process exited: ${stderr}`));
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15000);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
const command = (profile, argv) =>
  request('command/exec', {
    command: argv,
    cwd: workspace,
    permissionProfile: profile,
    timeoutMs: 5000,
  });
try {
  await request('initialize', {
    clientInfo: { name: 'mitzo-offline-permission-qualification', version: '1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const local = await command('base', ['/usr/bin/touch', join(workspace, 'allowed')]);
  assert.equal(local.exitCode, 0, JSON.stringify(local));
  assert.ok(existsSync(join(workspace, 'allowed')));
  const blocked = await command('base', ['/usr/bin/touch', join(extra, 'blocked')]);
  assert.notEqual(blocked.exitCode, 0, JSON.stringify(blocked));
  assert.ok(!existsSync(join(extra, 'blocked')));
  const granted = await command('granted', ['/usr/bin/touch', join(extra, 'granted')]);
  assert.equal(granted.exitCode, 0, JSON.stringify(granted));
  assert.ok(existsSync(join(extra, 'granted')));
  const deniedCredential = await command('granted', ['/bin/cat', secret]);
  assert.notEqual(deniedCredential.exitCode, 0, JSON.stringify(deniedCredential));
  assert.ok(!deniedCredential.stdout.includes('synthetic credential marker'));
  const runtimeAllowed = await command('base', [helper]);
  assert.equal(runtimeAllowed.exitCode, 0, JSON.stringify(runtimeAllowed));
  const runtimeDenied = await command('broadPrivateHomeDenyWithoutException', [helper]);
  assert.notEqual(runtimeDenied.exitCode, 0, JSON.stringify(runtimeDenied));
  const runtimeException = await command('broadPrivateHomeDeny', [helper]);
  assert.equal(runtimeException.exitCode, 0, JSON.stringify(runtimeException));
  const privateCredential = await command('broadPrivateHomeDeny', ['/bin/cat', secret]);
  assert.notEqual(privateCredential.exitCode, 0, JSON.stringify(privateCredential));
  assert.ok(!privateCredential.stdout.includes('synthetic credential marker'));
  const hostileCredentialChildGrant = await command('hostileCredentialChildGrant', [
    '/bin/cat',
    secret,
  ]);
  // Configuration union is deliberately adversarial: the adapter must reject
  // this overlay before upstream. A parent deny is not an immutable ceiling.
  const hostileChildReadable = hostileCredentialChildGrant.exitCode === 0;
  console.log(
    JSON.stringify(
      {
        version: version.stdout.trim(),
        executableSha256: digest,
        modelCalls: 0,
        workspaceWrite: 'allowed',
        outsideWrite: 'denied',
        exactAddedRootWrite: 'allowed',
        credentialReadAfterGrant: 'denied',
        helperWithNarrowCredentialFence: 'allowed',
        helperWithBroadHomeDenyWithoutException: 'denied',
        helperWithBroadHomeDenyAndReadableChild: 'allowed',
        credentialReadWithHelperException: 'denied',
        hostileCredentialChildGrant: hostileChildReadable
          ? 'readable: adapter must reject intersecting grants'
          : 'denied',
        scope:
          'standalone command/exec profile union; request_permissions lifecycle remains source/adapter-fixture qualification',
      },
      null,
      2,
    ),
  );
} finally {
  child.kill('SIGTERM');
  lines.close();
  rmSync(root, { recursive: true, force: true });
}
