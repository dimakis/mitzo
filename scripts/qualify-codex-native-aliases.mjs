/** Pinned no-model macOS alias qualification. Unsafe outcomes exit nonzero.
 * Usage: node scripts/qualify-codex-native-aliases.mjs /absolute/pinned/codex
 * Every protected file, credential and mutation below is synthetic/disposable.
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
  chmodSync,
  linkSync,
  symlinkSync,
  unlinkSync,
  statSync,
  existsSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

assert.equal(process.platform, 'darwin');
const binary = process.argv[2];
assert.ok(binary && isAbsolute(binary), 'Supply the pinned executable absolute path');
const executableSha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
assert.equal(executableSha256, '112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-native-aliases-')));
const home = join(root, 'private-home');
const osTemp = join(root, 'os-temp');
const workspace = join(root, 'workspace');
const credentials = join(home, 'credentials');
const publicDir = join(root, 'public-runtime');
const safe = join(workspace, 'safe');
const approvedTarget = join(root, 'approved-target');
for (const path of [home, osTemp, workspace, credentials, publicDir, safe, approvedTarget])
  mkdirSync(path, { recursive: true });
const runtimeNative = join(publicDir, 'native-origin');
const runtimeHost = join(publicDir, 'host-origin');
const runtimeOwnerWritable = join(publicDir, 'owner-writable-origin');
const credentialNative = join(credentials, 'native-origin');
const credentialHost = join(credentials, 'host-origin');
const runtimeMarker = 'synthetic public runtime marker';
const credentialMarker = 'synthetic credential marker';
for (const path of [runtimeNative, runtimeHost]) {
  writeFileSync(path, runtimeMarker);
  chmodSync(path, 0o444);
}
writeFileSync(runtimeOwnerWritable, runtimeMarker, { mode: 0o644 });
for (const path of [credentialNative, credentialHost])
  writeFileSync(path, credentialMarker, { mode: 0o600 });
const hostRuntimeAlias = join(workspace, 'host-runtime-link');
const hostCredentialAlias = join(workspace, 'host-credential-link');
linkSync(runtimeHost, hostRuntimeAlias);
linkSync(credentialHost, hostCredentialAlias);
const writeAlias = join(safe, 'root');
symlinkSync(approvedTarget, writeAlias);
writeFileSync(join(approvedTarget, 'value'), 'safe value');
const protectedValue = join(publicDir, 'value');
writeFileSync(protectedValue, runtimeMarker);
const actualDirectory = join(safe, 'actual-directory');
mkdirSync(actualDirectory);
writeFileSync(join(actualDirectory, 'value'), 'safe value');
const subtreeGlob = (path) => `${path.replace(/[\\*?[\]{}]/g, '\\$&')}{,/**}`;
const base = {
  '/': 'read',
  [workspace]: 'write',
  [publicDir]: 'read',
  [runtimeNative]: 'read',
  [runtimeHost]: 'read',
  [protectedValue]: 'read',
  [credentials]: 'deny',
  [subtreeGlob(credentials)]: 'deny',
};
const profiles = {
  base,
  publicWritablePositiveControl: { ...base, [publicDir]: 'write' },
  retainedWrite: { ...base, [writeAlias]: 'write' },
  retainedDirectoryWrite: { ...base, [actualDirectory]: 'write' },
  readTrailingSubtree: { ...base, [`${publicDir}/**`]: 'read', [writeAlias]: 'write' },
  publicDenyGlob: { ...base, [subtreeGlob(publicDir)]: 'deny', [writeAlias]: 'write' },
  publicDenyOnly: { ...base, [subtreeGlob(publicDir)]: 'deny' },
};
const table = (entries) =>
  `{ ${Object.entries(entries)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(', ')} }`;
writeFileSync(
  join(home, 'config.toml'),
  [
    'default_permissions = "base"',
    'approval_policy = "never"',
    'notify = []',
    'web_search = "disabled"',
    '[features]',
    'hooks = false',
    'shell_zsh_fork = false',
    'unified_exec = true',
    ...Object.entries(profiles).flatMap(([name, entries]) => [
      `[permissions.${name}]`,
      `filesystem = ${table(entries)}`,
      'network = { enabled = false }',
    ]),
  ].join('\n'),
);
const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: root,
  CODEX_HOME: home,
  TMPDIR: osTemp,
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
const pending = new Map();
let nextId = 1;
let stderr = '';
child.stderr.on('data', (data) => {
  stderr = (stderr + data).slice(-4096);
});
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  const callback = pending.get(message.id);
  if (!callback) return;
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
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
const command = async (profile, argv) => {
  try {
    return await request('command/exec', {
      command: argv,
      cwd: workspace,
      permissionProfile: profile,
      timeoutMs: 5000,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('{"code":')) throw error;
    return { exitCode: null, stdout: '', stderr: error.message, rpcRejected: true };
  }
};
const write = (profile, path) =>
  command(profile, ['/bin/sh', '-c', 'chmod u+w "$1" && printf changed > "$1"', 'fixture', path]);
const resetRuntime = (path) => {
  chmodSync(path, 0o644);
  writeFileSync(path, runtimeMarker);
  chmodSync(path, 0o444);
};
const brief = (result) => ({
  exitCode: result.exitCode,
  rpcRejected: result.rpcRejected ?? false,
  stderr: result.stderr.replaceAll(root, '<fixture>').trim(),
});
try {
  await request('initialize', {
    clientInfo: { name: 'mitzo-offline-alias-qualification', version: '1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const direct = await write('base', runtimeNative);
  assert.notEqual(direct.exitCode, 0);
  assert.equal(readFileSync(runtimeNative, 'utf8'), runtimeMarker);
  const hostWrite = await write('base', hostRuntimeAlias);
  const hostChanged = readFileSync(runtimeHost, 'utf8') !== runtimeMarker;
  resetRuntime(runtimeHost);
  assert.equal(statSync(runtimeNative).nlink, 1);
  const nativeRuntimeAlias = join(workspace, 'native-runtime-link');
  const nativeLink = await command('base', ['/bin/ln', runtimeNative, nativeRuntimeAlias]);
  let nativeWrite = null;
  let nativeChanged = false;
  if (nativeLink.exitCode === 0) {
    assert.equal(statSync(runtimeNative).ino, statSync(nativeRuntimeAlias).ino);
    nativeWrite = await write('base', nativeRuntimeAlias);
    nativeChanged = readFileSync(runtimeNative, 'utf8') !== runtimeMarker;
    resetRuntime(runtimeNative);
  }
  const nativeWritableSourceAlias = join(workspace, 'native-owner-writable-link');
  assert.equal(statSync(runtimeOwnerWritable).nlink, 1);
  const nativeWritableSourceLink = await command('base', [
    '/bin/ln',
    runtimeOwnerWritable,
    nativeWritableSourceAlias,
  ]);
  let nativeWritableSourceWrite = null;
  let nativeWritableSourceChanged = false;
  if (nativeWritableSourceLink.exitCode === 0) {
    nativeWritableSourceWrite = await write('base', nativeWritableSourceAlias);
    nativeWritableSourceChanged = readFileSync(runtimeOwnerWritable, 'utf8') !== runtimeMarker;
    resetRuntime(runtimeOwnerWritable);
  }
  chmodSync(runtimeOwnerWritable, 0o644);
  const positiveAlias = join(workspace, 'positive-owner-writable-link');
  const positiveLink = await command('publicWritablePositiveControl', [
    '/bin/ln',
    runtimeOwnerWritable,
    positiveAlias,
  ]);
  assert.equal(positiveLink.exitCode, 0, JSON.stringify(positiveLink));
  const positiveWrite = await write('publicWritablePositiveControl', positiveAlias);
  assert.equal(positiveWrite.exitCode, 0, JSON.stringify(positiveWrite));
  assert.equal(readFileSync(runtimeOwnerWritable, 'utf8'), 'changed');
  resetRuntime(runtimeOwnerWritable);
  const directCredential = await command('base', ['/bin/cat', credentialNative]);
  assert.notEqual(directCredential.exitCode, 0);
  const hostCredentialRead = await command('base', ['/bin/cat', hostCredentialAlias]);
  assert.equal(statSync(credentialNative).nlink, 1);
  const nativeCredentialAlias = join(workspace, 'native-credential-link');
  const nativeCredentialLink = await command('base', [
    '/bin/ln',
    credentialNative,
    nativeCredentialAlias,
  ]);
  let nativeCredentialRead = null;
  if (nativeCredentialLink.exitCode === 0)
    nativeCredentialRead = await command('base', ['/bin/cat', nativeCredentialAlias]);
  const retained = {};
  for (const profile of ['retainedWrite', 'readTrailingSubtree', 'publicDenyGlob']) {
    unlinkSync(writeAlias);
    symlinkSync(approvedTarget, writeAlias);
    writeFileSync(protectedValue, runtimeMarker);
    const before = await command(profile, ['/usr/bin/touch', join(writeAlias, 'approved')]);
    const retargetProfile = before.rpcRejected ? 'base' : profile;
    const retarget = await command(retargetProfile, [
      '/bin/sh',
      '-c',
      'rm "$1" && ln -s "$2" "$1"',
      'fixture',
      writeAlias,
      publicDir,
    ]);
    const outsideMutationRequired = retarget.exitCode !== 0;
    if (outsideMutationRequired) {
      rmSync(writeAlias, { force: true });
      symlinkSync(publicDir, writeAlias);
    }
    const after = await write(profile, join(writeAlias, 'value'));
    retained[profile] = {
      initialGrantAdmission: brief(before),
      nativeAliasReplacementProfile: retargetProfile,
      nativeAliasReplacement: brief(retarget),
      outsideMutationRequired,
      nextConstructionWrite: brief(after),
      originalChanged: readFileSync(protectedValue, 'utf8') !== runtimeMarker,
    };
  }
  writeFileSync(protectedValue, runtimeMarker);
  const directoryInitial = await command('retainedDirectoryWrite', [
    '/usr/bin/touch',
    join(actualDirectory, 'admitted'),
  ]);
  assert.equal(directoryInitial.exitCode, 0, JSON.stringify(directoryInitial));
  const directoryReplacement = await command('retainedDirectoryWrite', [
    '/bin/sh',
    '-c',
    'mv "$1" "$1-old" && ln -s "$2" "$1"',
    'fixture',
    actualDirectory,
    publicDir,
  ]);
  const directoryHostRetargetNeeded = directoryReplacement.exitCode !== 0;
  if (directoryHostRetargetNeeded) {
    if (existsSync(actualDirectory)) renameSync(actualDirectory, `${actualDirectory}-old`);
    symlinkSync(publicDir, actualDirectory);
  }
  const directoryAfter = await write('retainedDirectoryWrite', join(actualDirectory, 'value'));
  const directoryChanged = readFileSync(protectedValue, 'utf8') !== runtimeMarker;
  writeFileSync(protectedValue, runtimeMarker);
  const denyRead = await command('publicDenyOnly', ['/bin/cat', protectedValue]);
  assert.ok(!denyRead.rpcRejected);
  assert.notEqual(denyRead.exitCode, 0);
  const denyNativeLinkPath = join(workspace, 'denied-public-link');
  const denyNativeLink = await command('publicDenyOnly', [
    '/bin/ln',
    runtimeNative,
    denyNativeLinkPath,
  ]);
  assert.ok(!denyNativeLink.rpcRejected);
  const deniedGlobHostAliasWrite = await write('publicDenyOnly', hostRuntimeAlias);
  assert.ok(!deniedGlobHostAliasWrite.rpcRejected);
  const deniedGlobHostAliasChanged = readFileSync(runtimeHost, 'utf8') !== runtimeMarker;
  resetRuntime(runtimeHost);
  const unsupportedReadGlob = spawnSync(
    binary,
    [
      '-c',
      `permissions.unsupported.filesystem=${table({ [subtreeGlob(publicDir)]: 'read' })}`,
      'sandbox',
      '-P',
      'unsupported',
      '-C',
      workspace,
      '--',
      '/usr/bin/true',
    ],
    { cwd: workspace, env, encoding: 'utf8', timeout: 15000 },
  );
  assert.notEqual(unsupportedReadGlob.status, 0);
  assert.match(unsupportedReadGlob.stderr, /only supports `deny` access/);
  const nativeOnlyInvariantsMet =
    !nativeChanged &&
    !nativeWritableSourceChanged &&
    (!nativeCredentialRead || nativeCredentialRead.exitCode !== 0) &&
    !Object.values(retained).some((entry) => entry.originalChanged) &&
    !directoryChanged;
  const safetyInvariantsMet =
    nativeOnlyInvariantsMet && !hostChanged && hostCredentialRead.exitCode !== 0;
  console.log(
    JSON.stringify(
      {
        version: version.stdout.trim(),
        executableSha256,
        modelCalls: 0,
        nativeThreadOrTurnTested: false,
        publicRuntime: {
          directWrite: brief(direct),
          hostPreexistingHardlinkWrite: brief(hostWrite),
          hostPreexistingHardlinkOriginalChanged: hostChanged,
          nativeLinkSourceInitiallySingleLink: true,
          nativeHardlinkCreate: brief(nativeLink),
          nativeHardlinkWrite: nativeWrite && brief(nativeWrite),
          nativeHardlinkOriginalChanged: nativeChanged,
          nativeOwnerWritableSource: {
            sourceInitiallySingleLink: true,
            sourceMode: '0644',
            hardlinkCreate: brief(nativeWritableSourceLink),
            hardlinkWrite: nativeWritableSourceWrite && brief(nativeWritableSourceWrite),
            originalChanged: nativeWritableSourceChanged,
          },
          positiveWritablePolicyControl: {
            sourceMode: '0644',
            hardlinkCreate: brief(positiveLink),
            hardlinkWrite: brief(positiveWrite),
            originalChangedAsAuthorized: true,
          },
        },
        credential: {
          directRead: brief(directCredential),
          hostPreexistingHardlinkReadAllowed:
            hostCredentialRead.exitCode === 0 &&
            hostCredentialRead.stdout.includes(credentialMarker),
          nativeLinkSourceInitiallySingleLink: true,
          nativeHardlinkCreate: brief(nativeCredentialLink),
          nativeHardlinkReadAllowed: nativeCredentialRead
            ? nativeCredentialRead.exitCode === 0 &&
              nativeCredentialRead.stdout.includes(credentialMarker)
            : null,
        },
        retainedWritableSymlink: retained,
        retainedWritableDirectory: {
          initialGrantAdmission: brief(directoryInitial),
          nativeRootReplacement: brief(directoryReplacement),
          outsideMutationRequired: directoryHostRetargetNeeded,
          nextConstructionWrite: brief(directoryAfter),
          originalChanged: directoryChanged,
        },
        remedyControls: {
          denyGlobAlsoDeniesPublicRead: true,
          denyGlobNativeHardlinkCreate: brief(denyNativeLink),
          denyGlobHostPreexistingHardlinkWrite: brief(deniedGlobHostAliasWrite),
          denyGlobHostAliasOriginalChanged: deniedGlobHostAliasChanged,
          readBraceGlobParserRejected: true,
          readBraceGlobParserDiagnostic: unsupportedReadGlob.stderr
            .replaceAll(root, '<fixture>')
            .trim()
            .slice(0, 1000),
        },
        safetyInvariantsMet,
        testedNativeControlsPreservedOriginals: nativeOnlyInvariantsMet,
        scope:
          'Synthetic named profiles through pinned command/exec. Host preexisting aliases and host retargets are explicitly distinguished from native creation/replacement. No claim about untested content or other credentials.',
      },
      null,
      2,
    ),
  );
  if (!safetyInvariantsMet) process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  lines.close();
  rmSync(root, { recursive: true, force: true });
}
