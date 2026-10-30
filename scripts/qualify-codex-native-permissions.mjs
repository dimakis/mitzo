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
  symlinkSync,
  unlinkSync,
  readdirSync,
  readlinkSync,
  copyFileSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';

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
const osTemp = join(root, 'os-temp');
const credentialChild = join(secrets, 'child');
const safe = join(extra, 'safe');
const metacharSecrets = join(extra, 'credential[*]?{literal}\\name');
const metacharNeighbor = join(extra, 'credential*Xliteralname');
for (const path of [
  home,
  workspace,
  extra,
  secrets,
  runtime,
  osTemp,
  credentialChild,
  safe,
  metacharSecrets,
  metacharNeighbor,
])
  mkdirSync(path, { recursive: true });
const secret = join(secrets, 'synthetic-auth.txt');
writeFileSync(secret, 'synthetic credential marker');
const nestedSecret = join(credentialChild, 'secret');
writeFileSync(nestedSecret, 'synthetic nested credential marker');
writeFileSync(join(safe, 'secret'), 'safe marker');
const metacharSecret = join(metacharSecrets, 'secret');
writeFileSync(metacharSecret, 'synthetic metachar credential marker');
writeFileSync(join(metacharNeighbor, 'safe'), 'safe neighbor marker');
const standaloneSecret = join(home, 'synthetic-auth.json');
writeFileSync(standaloneSecret, 'synthetic standalone credential marker');
const approvedAlias = join(workspace, 'approved');
symlinkSync(safe, approvedAlias);
const credentialAlias = join(extra, 'credential-alias');
symlinkSync(credentialChild, credentialAlias);
const insideBinary = join(home, 'codex-runtime');
copyFileSync(binary, insideBinary);
chmodSync(insideBinary, 0o700);
const insideHelperRoot = join(runtime, 'inside');
mkdirSync(insideHelperRoot);
const insideApplyPatch = join(insideHelperRoot, 'apply_patch');
symlinkSync(insideBinary, insideApplyPatch);
const helper = join(runtime, 'synthetic-execve-wrapper');
writeFileSync(helper, '#!/bin/sh\nprintf helper-executed');
chmodSync(helper, 0o700);
const base = { '/': 'read', [workspace]: 'write', [secrets]: 'deny' };
// POSIX git-glob escaping, then a brace alternative covering both the base
// path and every descendant. JSON.stringify below performs separate TOML
// string escaping; do not confuse the glob escape with TOML serialization.
const subtreeDenyGlob = (path) => `${path.replace(/[\\*?[\]{}]/g, '\\$&')}{,/**}`;
const credentialGlob = subtreeDenyGlob(secrets);
const hardFence = { ...base, [credentialGlob]: 'deny' };
// Exercise the production profile compiler with the actual pinned process.
const { codexNativeExecutionPolicy, codexNativePermissionProfiles } =
  await import('../server/codex-native-execution-policy.ts');
const productProfiles = codexNativePermissionProfiles(
  codexNativeExecutionPolicy({
    bindingRevision: 'offline-native-git',
    mode: 'agent',
    cwd: workspace,
    readableRoots: ['/'],
    writableRoots: [workspace],
    deniedRoots: [secrets],
  }),
);
const profiles = {
  ...Object.fromEntries(
    Object.entries(productProfiles.permissions).map(([name, value]) => [name, value.filesystem]),
  ),
  base,
  granted: { ...base, [extra]: 'write' },
  broadPrivateHomeDenyWithoutException: { ...base, [home]: 'deny' },
  broadPrivateHomeDeny: { ...base, [home]: 'deny', [runtime]: 'read' },
  hostileCredentialChildGrant: { ...base, [secret]: 'read' },
  hostileChildHardFence: {
    ...hardFence,
    [secret]: 'write',
    [credentialChild]: 'write',
    [extra]: 'write',
  },
  retainedLiteralGrant: { ...base, [approvedAlias]: 'read' },
  retainedGlobGrant: { ...hardFence, [approvedAlias]: 'read' },
  metacharHardFence: { ...base, [extra]: 'write', [subtreeDenyGlob(metacharSecrets)]: 'deny' },
  standaloneHardFence: {
    ...base,
    [standaloneSecret]: 'write',
    [subtreeDenyGlob(standaloneSecret)]: 'deny',
  },
  renameHardFence: { ...hardFence, [home]: 'write', [extra]: 'write' },
  homeGlobWithHelperException: {
    ...base,
    [subtreeDenyGlob(home)]: 'deny',
    [runtime]: 'read',
    [insideBinary]: 'read',
  },
  homeGlobWithoutHelperException: { ...base, [subtreeDenyGlob(home)]: 'deny' },
  homeLiteralWithExecutableException: { ...base, [home]: 'deny', [insideBinary]: 'read' },
};
// JSON string keys and simple access strings are also valid TOML inline tables.
const table = (entries) =>
  `{ ${Object.entries(entries)
    .map(
      ([key, value]) =>
        `${JSON.stringify(key)} = ${value && typeof value === 'object' ? table(value) : JSON.stringify(value)}`,
    )
    .join(', ')} }`;
writeFileSync(
  join(home, 'config.toml'),
  [
    'default_permissions = "base"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    'cli_auth_credentials_store = "file"',
    'notify = []',
    '[features]',
    'remote_control = false',
    'analytics = false',
    'shell_zsh_fork = false',
    'unified_exec = true',
    'hooks = false',
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
  // Ordinary Git must work at the actual workspace root, where the native
  // engine installs its implicit read-only .git rule. A nested repo misses it.
  const git = (...args) => {
    const result = spawnSync('/usr/bin/git', ['-C', workspace, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--template=', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline fixture');
  git('config', 'user.email', 'offline@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(workspace, 'base.txt'), 'base');
  git('add', 'base.txt');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'upstream');
  for (let index = 0; index < 218; index++)
    writeFileSync(join(workspace, `upstream-${index}.txt`), 'accepted upstream');
  git('add', '.');
  git('commit', '-qm', 'upstream');
  const upstream = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'task', 'main');
  writeFileSync(join(workspace, 'task.txt'), 'task');
  writeFileSync(join(workspace, 'unselected.txt'), 'retain dirty work');
  assert.notEqual(
    (await command('mitzo-native-ask', ['/usr/bin/touch', join(workspace, '.git', 'ask-write')]))
      .exitCode,
    0,
  );
  const nativeGit = await command('mitzo-native-agent', [
    '/bin/sh',
    '-c',
    'git add task.txt && git commit -qm "task" && git merge --no-ff --no-edit upstream',
  ]);
  assert.equal(nativeGit.exitCode, 0, JSON.stringify(nativeGit));
  assert.equal(git('rev-parse', 'HEAD^2'), upstream);
  assert.equal(git('status', '--porcelain', '--', 'unselected.txt'), '?? unselected.txt');
  assert.notEqual((await command('mitzo-native-agent', ['/bin/cat', secret])).exitCode, 0);
  assert.notEqual(
    (await command('mitzo-native-agent', ['/usr/bin/touch', join(extra, 'git-escape')])).exitCode,
    0,
  );
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
  assert.ok(
    hostileChildReadable,
    'Control: literal parent deny must reproduce the child-grant bypass',
  );
  const assertDenied = (result) => assert.notEqual(result.exitCode, 0, JSON.stringify(result));
  const hardRead = await command('hostileChildHardFence', ['/bin/cat', secret]);
  assertDenied(hardRead);
  const hardNestedRead = await command('hostileChildHardFence', ['/bin/cat', nestedSecret]);
  assertDenied(hardNestedRead);
  const hardWrite = await command('hostileChildHardFence', [
    '/usr/bin/touch',
    join(credentialChild, 'created'),
  ]);
  assertDenied(hardWrite);
  assert.ok(!existsSync(join(credentialChild, 'created')));
  const hardAliasRead = await command('hostileChildHardFence', [
    '/bin/cat',
    join(credentialAlias, 'secret'),
  ]);
  assertDenied(hardAliasRead);
  const hardMetacharRead = await command('metacharHardFence', ['/bin/cat', metacharSecret]);
  assertDenied(hardMetacharRead);
  const hardMetacharWrite = await command('metacharHardFence', [
    '/usr/bin/touch',
    join(metacharSecrets, 'created'),
  ]);
  assertDenied(hardMetacharWrite);
  const metacharNeighborRead = await command('metacharHardFence', [
    '/bin/cat',
    join(metacharNeighbor, 'safe'),
  ]);
  assert.equal(metacharNeighborRead.exitCode, 0, JSON.stringify(metacharNeighborRead));
  const metacharNeighborWrite = await command('metacharHardFence', [
    '/usr/bin/touch',
    join(metacharNeighbor, 'created'),
  ]);
  assert.equal(metacharNeighborWrite.exitCode, 0, JSON.stringify(metacharNeighborWrite));
  assertDenied(await command('standaloneHardFence', ['/bin/cat', standaloneSecret]));
  assertDenied(await command('standaloneHardFence', ['/usr/bin/touch', standaloneSecret]));
  assertDenied(
    await command('standaloneHardFence', [
      '/bin/mv',
      standaloneSecret,
      join(workspace, 'moved-auth.json'),
    ]),
  );
  // Reuse the same named read grant across sandbox constructions. The first
  // sandbox approves a safe alias, the next resolves that alias into credentials.
  const retargetResults = {};
  for (const profile of ['retainedLiteralGrant', 'retainedGlobGrant']) {
    unlinkSync(approvedAlias);
    symlinkSync(safe, approvedAlias);
    const initial = await command(profile, ['/bin/cat', join(approvedAlias, 'secret')]);
    assert.equal(initial.exitCode, 0, JSON.stringify(initial));
    const retarget = await command(profile, [
      '/bin/sh',
      '-c',
      'rm "$1" && ln -s "$2" "$1"',
      'fixture',
      approvedAlias,
      credentialChild,
    ]);
    // A read-only carveout can itself prevent the sandboxed unlink. Still
    // qualify a host/external retarget between sandbox constructions, because
    // the retained grant must not expose a credential after external mutation.
    if (retarget.exitCode !== 0) {
      unlinkSync(approvedAlias);
      symlinkSync(credentialChild, approvedAlias);
    }
    assert.equal(readlinkSync(approvedAlias), credentialChild);
    const after = await command(profile, ['/bin/cat', join(approvedAlias, 'secret')]);
    if (profile === 'retainedLiteralGrant') assert.equal(after.exitCode, 0, JSON.stringify(after));
    else assertDenied(after);
    retargetResults[profile] = {
      sandboxedUnlink: retarget.exitCode === 0 ? 'allowed' : 'denied',
      afterHostRetarget: after.exitCode === 0 ? 'readable' : 'denied',
    };
  }
  const renamed = join(extra, 'moved-credentials');
  const renameProtected = await command('renameHardFence', ['/bin/mv', secrets, renamed]);
  assertDenied(renameProtected);
  assert.ok(existsSync(secrets) && !existsSync(renamed));
  const renameAncestor = await command('renameHardFence', [
    '/bin/mv',
    home,
    join(extra, 'moved-private-home'),
  ]);
  assertDenied(renameAncestor);
  assert.ok(existsSync(home));
  const hardHelper = await command('hostileChildHardFence', [helper]);
  assert.equal(hardHelper.exitCode, 0, JSON.stringify(hardHelper));
  const homeGlobHelper = await command('homeGlobWithHelperException', [helper]);
  assertDenied(homeGlobHelper);
  const insideExecutableLiteral = await command('homeLiteralWithExecutableException', [
    insideBinary,
    '--version',
  ]);
  assert.equal(insideExecutableLiteral.exitCode, 0, JSON.stringify(insideExecutableLiteral));
  const insideExecutableGlob = await command('homeGlobWithHelperException', [
    insideBinary,
    '--version',
  ]);
  const insideExecutableRead = await command('homeGlobWithHelperException', [
    '/bin/cat',
    insideBinary,
  ]);
  assertDenied(insideExecutableRead);
  const actualHelpers = readdirSync(runtime, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith('codex-arg0'),
  );
  assert.ok(actualHelpers.length > 0, 'Real no-model startup must create its native arg0 helper');
  const externalApplyPatch = join(runtime, actualHelpers[0].name, 'apply_patch');
  assert.equal(readlinkSync(externalApplyPatch), binary);
  const patch = (name) =>
    `*** Begin Patch\n*** Add File: ${name}\n+synthetic helper patch\n*** End Patch`;
  const externalHelperControl = await command('base', [
    externalApplyPatch,
    patch('external-helper-control'),
  ]);
  assert.equal(externalHelperControl.exitCode, 0, JSON.stringify(externalHelperControl));
  assert.ok(existsSync(join(workspace, 'external-helper-control')));
  const internalHelperControl = await command('base', [
    insideApplyPatch,
    patch('internal-helper-control'),
  ]);
  assert.equal(internalHelperControl.exitCode, 0, JSON.stringify(internalHelperControl));
  assert.ok(existsSync(join(workspace, 'internal-helper-control')));
  const outsideHelperResult = await command('homeGlobWithHelperException', [
    externalApplyPatch,
    patch('external-helper-patch'),
  ]);
  const insideHelperResult = await command('homeGlobWithHelperException', [
    insideApplyPatch,
    patch('internal-helper-patch'),
  ]);
  assertDenied(outsideHelperResult);
  assertDenied(insideHelperResult);
  assert.ok(!existsSync(join(workspace, 'external-helper-patch')));
  assert.ok(!existsSync(join(workspace, 'internal-helper-patch')));
  // Native core/exec-server helpers use direct self-exe dispatch, rather than
  // traversing a PATH alias. Keep the real pinned binary inside denied home.
  const directPatch = await command('homeGlobWithoutHelperException', [
    insideBinary,
    '--codex-run-as-apply-patch',
    patch('direct-core-patch'),
  ]);
  assert.equal(directPatch.exitCode, 0, JSON.stringify(directPatch));
  assert.ok(existsSync(join(workspace, 'direct-core-patch')));
  const directProcessHelper = await command('homeGlobWithoutHelperException', [
    insideBinary,
    '--codex-run-as-arg0-exec-helper',
    'fixture-shell',
    '/bin/sh',
    '-c',
    'printf direct-shell; touch "$1"',
    'fixture',
    join(workspace, 'direct-shell'),
  ]);
  assert.equal(directProcessHelper.exitCode, 0, JSON.stringify(directProcessHelper));
  assert.ok(existsSync(join(workspace, 'direct-shell')));
  const fsHelper = async (operation, params) => {
    // The subprocess shape matches exec-server/fs_sandbox.rs: self-exe,
    // --codex-run-as-fs-helper, one JSON line on stdin. The shell only feeds it.
    const wire = JSON.stringify({ operation, params: { ...params, sandbox: null } });
    const result = await command('homeGlobWithoutHelperException', [
      '/bin/sh',
      '-c',
      'printf "%s\\n" "$1" | "$2" --codex-run-as-fs-helper',
      'fixture',
      wire,
      insideBinary,
    ]);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    return JSON.parse(result.stdout);
  };
  const fsFile = join(workspace, 'native-fs-write');
  const fsWrite = await fsHelper('fs/writeFile', {
    path: pathToFileURL(fsFile).href,
    dataBase64: Buffer.from('native fs marker').toString('base64'),
  });
  assert.equal(fsWrite.status, 'ok', JSON.stringify(fsWrite));
  assert.equal(readFileSync(fsFile, 'utf8'), 'native fs marker');
  const fsRead = await fsHelper('fs/readFile', { path: pathToFileURL(fsFile).href });
  assert.equal(fsRead.status, 'ok', JSON.stringify(fsRead));
  const fsCredentialRead = await fsHelper('fs/readFile', { path: pathToFileURL(secret).href });
  assert.equal(fsCredentialRead.status, 'error', JSON.stringify(fsCredentialRead));
  const fsCredentialWrite = await fsHelper('fs/writeFile', {
    path: pathToFileURL(secret).href,
    dataBase64: Buffer.from('forbidden').toString('base64'),
  });
  assert.equal(fsCredentialWrite.status, 'error', JSON.stringify(fsCredentialWrite));
  assert.equal(readFileSync(secret, 'utf8'), 'synthetic credential marker');
  console.log(
    JSON.stringify(
      {
        version: version.stdout.trim(),
        executableSha256: digest,
        modelCalls: 0,
        nativeThreadOrTurnTested: false,
        nativeGit: {
          productionProfile: 'mitzo-native-agent',
          localCommit: 'passed',
          mergedFiles: 218,
          twoParentMerge: 'passed',
          unselectedFile: 'preserved',
          askGitWrite: 'denied',
          credentialRead: 'denied',
          outsideWrite: 'denied',
        },
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
        globFence: {
          exactHostileChildRead: 'denied',
          nestedHostileChildRead: 'denied',
          nestedHostileChildWrite: 'denied',
          credentialSymlinkAliasRead: 'denied',
          escapedLiteralMetacharRead: 'denied',
          escapedLiteralMetacharWrite: 'denied',
          escapedLiteralMetacharNeighborReadWrite: 'allowed',
          standaloneCredentialFileReadWriteRename: 'denied',
          retainedSymlinkGrant: retargetResults,
          protectedDirectoryRename: 'denied',
          protectedAncestorRename: 'denied',
          helperOutsideCredentialGlob: 'allowed',
          helperInsideHomeGlobDespiteReadException: 'denied',
          frozenExecutableLiteralException: 'allowed',
          frozenExecutableInsideHomeGlob:
            insideExecutableGlob.exitCode === 0 ? 'exec allowed; bytes unreadable' : 'denied',
          actualArg0SymlinkExternalExecutable:
            outsideHelperResult.exitCode === 0 ? 'allowed' : 'denied',
          actualArg0SymlinkInternalExecutable:
            insideHelperResult.exitCode === 0 ? 'allowed' : 'denied',
          actualArg0ControlExternalExecutable: 'allowed',
          actualArg0ControlInternalExecutable: 'allowed',
          directCoreApplyPatchInsideDeniedHome: 'allowed',
          directNativeProcessHelperInsideDeniedHome: 'allowed',
          directNativeFsHelperWorkspaceReadWrite: 'allowed',
          directNativeFsHelperCredentialReadWrite: 'denied',
          directNativeHelperProfile: 'whole-home deny glob, no explicit helper exceptions',
          selectedFeatures: { shell_zsh_fork: false, unified_exec: true, hooks: false },
          legacyNotify: 'disabled explicitly',
          literalSubtreePatternExample: subtreeDenyGlob('/fixture/credential[*]?{literal}\\name'),
        },
        scope:
          'standalone command/exec profile union and direct pinned helper subprocesses; request_permissions lifecycle remains source/adapter-fixture qualification',
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
