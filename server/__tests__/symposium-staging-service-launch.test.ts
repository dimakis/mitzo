import { afterEach, expect, it } from 'vitest';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME } from '../symposium-owned-runtime-contract.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(canonical = false) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'staging-service-entry-')));
  roots.push(temporary);
  const canonicalRoot = join(temporary, '.local/share/mitzo-staging');
  const sourceCommit = 'a'.repeat(40);
  const root = canonical
    ? join(canonicalRoot, 'releases', sourceCommit.slice(0, 12))
    : join(temporary, 'release');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  if (canonical) {
    for (const name of [
      'symposium/service',
      'symposium/settings',
      'symposium/workspace',
      'symposium/home',
      'registry',
    ])
      mkdirSync(join(canonicalRoot, name), { recursive: true, mode: 0o700 });
    // Override only the operator identity in this child. Every canonical path,
    // registration and auth guard is the actual compiled implementation.
    writeFileSync(
      join(root, 'test-operator.mjs'),
      `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; const original=os.userInfo; os.userInfo=()=>({...original(),homedir:${JSON.stringify(temporary)}}); syncBuiltinESMExports();`,
    );
  }
  for (const name of ['scripts', 'dist', 'plan', 'repo'])
    mkdirSync(join(root, name), { mode: 0o700 });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  cpSync('scripts/start-staging-custodian.mjs', join(root, 'scripts/start-staging-custodian.mjs'));
  // Actual auth reader and environment allowlist; physical owner is synthetic.
  for (const name of [
    'symposium-custodian-launch',
    'symposium-staging-environment',
    'symposium-canonical-control',
    'symposium-canonical-owner-record',
    'symposium-staging-identity',
    'symposium-staging-service',
    'symposium-staging-launch-schema',
    'symposium-staging-runtime-contract',
    'symposium-owned-runtime-contract',
    'symposium-staging-registry',
    'symposium-custodian-retirement',
    'symposium-owned-config-schema',
    'symposium-owned-network-config',
    'credentials',
    'model-catalog',
    'symposium-work-vertex-profile',
    'symposium-publication-registration-schema',
    'symposium-podman-namespace',
    'symposium-criterion-definition',
    'symposium-review-records',
  ])
    writeFileSync(
      join(root, 'dist', name + '.js'),
      ts.transpileModule(readFileSync('server/' + name + '.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  cpSync('node_modules/zod', join(root, 'node_modules/zod'), {
    recursive: true,
    dereference: true,
  });
  cpSync('node_modules/better-sqlite3', join(root, 'node_modules/better-sqlite3'), {
    recursive: true,
    dereference: true,
  });
  const registryDirectory = canonical
    ? join(canonicalRoot, 'registry')
    : join(temporary, 'registry');
  mkdirSync(registryDirectory, { recursive: true, mode: 0o700 });
  const home = canonical ? join(canonicalRoot, 'symposium/home') : join(temporary, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const plan = {
    releaseRoot: root,
    sourceCommit,
    planDirectory: canonical ? join(canonicalRoot, 'symposium/service') : join(root, 'plan'),
    repositoryPath: canonical ? join(canonicalRoot, 'symposium/workspace') : join(root, 'repo'),
    appHome: home,
    configPath: canonical
      ? join(canonicalRoot, 'symposium/settings/owned-host.json')
      : join(root, 'host.json'),
    entry: 'dist/symposium-custodian-main.js',
    buildSha256: 'b'.repeat(64),
    configSha256: 'c'.repeat(64),
    runtime: REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build,
  };
  const stateParent = join(temporary, 'gateway-state');
  mkdirSync(stateParent, { mode: 0o700 });
  const gatewayStateDirectory = join(stateParent, 'gateway');
  mkdirSync(gatewayStateDirectory, { mode: 0o700 });
  const inputs = join(temporary, 'public-inputs');
  mkdirSync(inputs, { mode: 0o700 });
  const file = (name: string) => {
    const path = join(inputs, name);
    writeFileSync(path, 'offline fixture', { mode: 0o600 });
    return path;
  };
  const build = plan.runtime;
  const config = {
    gateway: {
      executable: file('gateway'),
      executableSha256: build.gatewaySha256,
      cliExecutable: file('cli'),
      cliSha256: build.cliSha256,
      stateParent,
      systemCaBundle: file('ca'),
      gateway: 'test',
      workspace: 'test',
      port: 18991,
      podmanSocket: file('socket'),
      network: 'test',
      workloadImage: build.image,
      sandboxRuntimeImage: build.sandboxRuntimeImage,
      supervisorImage: build.supervisorImage,
      tls: {
        serverCert: file('cert'),
        serverKey: file('key'),
        clientCa: file('client-ca'),
        managementCert: file('management-cert'),
        managementKey: file('management-key'),
      },
      jwt: { signingKey: file('signing'), publicKey: file('public'), kid: file('kid') },
    },
    attestationPath: join(inputs, 'pending-attestation'),
    runtime: { policy: file('policy'), seed: inputs, createDetached: true, sandboxIdLength: 13 },
    podman: {
      executable: file('podman'),
      environment: { HOME: home, PATH: '/usr/bin:/bin' },
      sandboxNamespace: '',
    },
    personal: {
      workProfiles: [],
      accountId: 'fixture',
      label: 'Fixture',
      selectedModel: 'luna',
      models: [{ id: 'luna', label: 'Luna' }],
    },
    artifacts: [],
    providerProfiles: [{ path: file('profile'), sha256: 'd'.repeat(64) }],
  };
  writeFileSync(plan.configPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(plan.planDirectory, 'owned-release.json'), JSON.stringify(plan), {
    mode: 0o600,
  });
  const registrationPath = canonical
    ? join(canonicalRoot, 'symposium/settings/staging-registration.json')
    : join(root, 'registration.json');
  const registration = {
    capacity: 1,
    registryDirectory,
    ownerChat: 'cli-test',
    purpose: 'canonical entry coverage',
    retentionReason: 'synthetic test only',
    reviewAfter: Date.now() + 86400000,
  };
  writeFileSync(registrationPath, JSON.stringify(registration), { mode: 0o600 });
  const operator = {
    AUTH_PASSPHRASE: 'synthetic-offline-passphrase-000000000000',
    AUTH_SECRET: 'synthetic-offline-secret-'.padEnd(64, '0'),
    PORT: canonical ? '3190' : '19994',
    MITZO_BIND_HOST: '127.0.0.1',
  };
  const operatorPath = join(plan.planDirectory, 'staging-operator.json');
  writeFileSync(operatorPath, JSON.stringify(operator), {
    mode: 0o600,
  });
  writeFileSync(
    join(root, 'dist/symposium-owned-release.js'),
    `import {readFileSync,writeFileSync,existsSync} from 'node:fs'; export const readOwnedReleasePlan=p=>JSON.parse(readFileSync(p)); export const verifyOwnedRelease=p=>{const path=p.planDirectory+'/verify-count.json';writeFileSync(path,JSON.stringify((existsSync(path)?JSON.parse(readFileSync(path)):0)+1),{mode:0o600});}; export const claimOwnedLaunch=p=>writeFileSync(p.planDirectory+'/launch.intent','claimed',{flag:'wx'});`,
  );
  writeFileSync(
    join(root, 'dist/actual-staging-launch.js'),
    ts.transpileModule(readFileSync('server/symposium-staging-launch.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
  writeFileSync(
    join(root, 'dist/symposium-staging-launch.js'),
    `export {StagingLaunchSchema,launchStagingCustodian} from './actual-staging-launch.js';`,
  );
  writeFileSync(
    join(root, 'dist/symposium-custodian-main.js'),
    `import {writeCustodianRetirementReceipt} from './symposium-custodian-retirement.js'; export const runSymposiumCustodian=async(hooks)=>{if(hooks.admissionBuildSelection!==undefined)throw Error('Unexpected successor selector'); const identity={instanceId:'fixture-original',controllerGeneration:1};hooks.observeRetirement('retiring',${JSON.stringify(stateParent)},identity);writeCustodianRetirementReceipt({stateParent:${JSON.stringify(stateParent)},gatewayStateDirectory:${JSON.stringify(gatewayStateDirectory)},...identity});hooks.observeRetirement('retired',${JSON.stringify(stateParent)});console.log(JSON.stringify({port:process.env.PORT,bind:process.env.MITZO_BIND_HOST,passphraseCorrect:process.env.AUTH_PASSPHRASE===${JSON.stringify(operator.AUTH_PASSPHRASE)},secretCorrect:process.env.AUTH_SECRET===${JSON.stringify(operator.AUTH_SECRET)},ambient:Object.keys(process.env).filter(k=>['GH_TOKEN','HTTPS_PROXY','GOOGLE_APPLICATION_CREDENTIALS'].includes(k))}));};`,
  );
  const args = [
    ...(canonical ? ['--import', join(root, 'test-operator.mjs')] : []),
    join(root, 'scripts/start-staging-custodian.mjs'),
    join(plan.planDirectory, 'owned-release.json'),
    registrationPath,
    operatorPath,
    ...(canonical ? ['--canonical'] : []),
  ];
  return { root, args, operator, operatorPath, registration, registrationPath, plan, config };
}
function assertOriginalLaunch(f: ReturnType<typeof fixture>) {
  expect(JSON.parse(readFileSync(join(f.plan.planDirectory, 'verify-count.json'), 'utf8'))).toBe(2);
  const db = new Database(join(f.registration.registryDirectory, 'staging.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(db.prepare('SELECT capacity FROM policy WHERE id=1').get()).toEqual({ capacity: 1 });
    expect(db.prepare('SELECT state,instanceId,controllerGeneration FROM launches').all()).toEqual([
      { state: 'retired', instanceId: 'fixture-original', controllerGeneration: 1 },
    ]);
  } finally {
    db.close();
  }
}
it('starts through the private file transport with no ambient credentials and refuses a second owner', () => {
  const f = fixture();
  const env = {
    PATH: process.env.PATH,
    GH_TOKEN: 'synthetic-ambient-must-not-pass',
    HTTPS_PROXY: 'http://must-not-pass',
    AUTH_PASSPHRASE: 'must-not-select-ambient',
    AUTH_SECRET: 'must-not-select-ambient',
  };
  const result = spawnSync(process.execPath, f.args, { encoding: 'utf8', env });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    port: '19994',
    bind: '127.0.0.1',
    passphraseCorrect: true,
    secretCorrect: true,
    ambient: [],
  });
  expect(result.stdout).not.toContain(f.operator.AUTH_PASSPHRASE);
  expect(result.stdout).not.toContain(f.operator.AUTH_SECRET);
  assertOriginalLaunch(f);
  expect(spawnSync(process.execPath, f.args, { encoding: 'utf8', env }).status).not.toBe(0);
});
it('refuses exposed settings before launch intent', () => {
  const f = fixture();
  chmodSync(f.args[3], 0o644);
  const result = spawnSync(process.execPath, f.args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  expect(result.status).not.toBe(0);
  expect(existsSync(join(f.root, 'plan/launch.intent'))).toBe(false);
  expect(result.stderr).not.toContain(f.operator.AUTH_SECRET);
});

it('starts the canonical CLI path with the actual registration/auth guards', () => {
  const f = fixture(true);
  const result = spawnSync(process.execPath, f.args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ port: '3190', bind: '127.0.0.1', ambient: [] });
  expect(existsSync(join(f.plan.planDirectory, 'launch.intent'))).toBe(true);
  assertOriginalLaunch(f);
});
it.each(['configured-cli', 'plan-manifest'] as const)(
  'uses the actual subprocess classifier to refuse %s drift before claim',
  (failure) => {
    const f = fixture(true);
    if (failure === 'configured-cli')
      Object.assign(f.config.gateway, { cliSha256: 'e'.repeat(64) });
    else Object.assign(f.plan, { runtime: { ...f.plan.runtime, imageDigest: 'e'.repeat(64) } });
    writeFileSync(f.plan.configPath, JSON.stringify(f.config), { mode: 0o600 });
    writeFileSync(join(f.plan.planDirectory, 'owned-release.json'), JSON.stringify(f.plan), {
      mode: 0o600,
    });
    const result = spawnSync(process.execPath, f.args, {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.plan.planDirectory, 'launch.intent'))).toBe(false);
    expect(existsSync(join(f.registration.registryDirectory, 'staging.db'))).toBe(false);
  },
);
it.each([
  'capacity',
  'registry',
  'production-port',
  'other-port',
  'missing-canonical',
  'missing-purpose',
])('refuses canonical CLI %s drift before claiming a launch', (kind) => {
  const f = fixture(true);
  if (kind === 'capacity') f.registration.capacity = 2;
  if (kind === 'registry') f.registration.registryDirectory = join(f.root, 'other-registry');
  if (kind === 'production-port') f.operator.PORT = '3100';
  if (kind === 'other-port') f.operator.PORT = '3191';
  if (kind === 'missing-canonical') f.args.pop();
  if (kind === 'missing-purpose') Object.assign(f.registration, { purpose: undefined });
  writeFileSync(f.registrationPath, JSON.stringify(f.registration));
  writeFileSync(f.operatorPath, JSON.stringify(f.operator));
  const result = spawnSync(process.execPath, f.args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  expect(result.status).not.toBe(0);
  expect(existsSync(join(f.plan.planDirectory, 'launch.intent'))).toBe(false);
});
