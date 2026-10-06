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
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(canonical = false) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'staging-service-entry-')));
  roots.push(temporary);
  const canonicalRoot = join(temporary, '.local/share/mitzo-staging');
  const sourceCommit = 'a'.repeat(40);
  const root = canonical ? join(canonicalRoot, 'releases', sourceCommit.slice(0, 12)) : temporary;
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
    'symposium-staging-identity',
    'symposium-staging-service',
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
  const plan = {
    releaseRoot: root,
    sourceCommit,
    planDirectory: canonical ? join(canonicalRoot, 'symposium/service') : join(root, 'plan'),
    repositoryPath: canonical ? join(canonicalRoot, 'symposium/workspace') : join(root, 'repo'),
    appHome: canonical ? join(canonicalRoot, 'symposium/home') : root,
    configPath: canonical
      ? join(canonicalRoot, 'symposium/settings/owned-host.json')
      : join(root, 'host.json'),
    entry: 'dist/symposium-custodian-main.js',
  };
  writeFileSync(join(plan.planDirectory, 'owned-release.json'), JSON.stringify(plan), {
    mode: 0o600,
  });
  const registrationPath = canonical
    ? join(canonicalRoot, 'symposium/settings/staging-registration.json')
    : join(root, 'registration.json');
  const registration = canonical
    ? { capacity: 1, registryDirectory: join(canonicalRoot, 'registry') }
    : {};
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
    `import {readFileSync,writeFileSync} from 'node:fs'; export const readOwnedReleasePlan=p=>JSON.parse(readFileSync(p)); export const verifyOwnedRelease=()=>{}; export const claimOwnedLaunch=p=>writeFileSync(p.planDirectory+'/launch.intent','claimed',{flag:'wx'});`,
  );
  writeFileSync(
    join(root, 'dist/symposium-staging-launch.js'),
    `export const StagingLaunchSchema={parse:x=>x}; export const launchStagingCustodian=async(p,r,d)=>{d.verify(p); d.claim(p); await d.run({});};`,
  );
  writeFileSync(
    join(root, 'dist/symposium-custodian-main.js'),
    `export const runSymposiumCustodian=async()=>{console.log(JSON.stringify({port:process.env.PORT,bind:process.env.MITZO_BIND_HOST,passphraseCorrect:process.env.AUTH_PASSPHRASE===${JSON.stringify(operator.AUTH_PASSPHRASE)},secretCorrect:process.env.AUTH_SECRET===${JSON.stringify(operator.AUTH_SECRET)},ambient:Object.keys(process.env).filter(k=>['GH_TOKEN','HTTPS_PROXY','GOOGLE_APPLICATION_CREDENTIALS'].includes(k))}));};`,
  );
  const args = [
    ...(canonical ? ['--import', join(root, 'test-operator.mjs')] : []),
    join(root, 'scripts/start-staging-custodian.mjs'),
    join(plan.planDirectory, 'owned-release.json'),
    registrationPath,
    operatorPath,
    ...(canonical ? ['--canonical'] : []),
  ];
  return { root, args, operator, operatorPath, registration, registrationPath, plan };
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
});
it.each(['capacity', 'registry', 'production-port', 'other-port', 'missing-canonical'])(
  'refuses canonical CLI %s drift before claiming a launch',
  (kind) => {
    const f = fixture(true);
    if (kind === 'capacity') f.registration.capacity = 2;
    if (kind === 'registry') f.registration.registryDirectory = join(f.root, 'other-registry');
    if (kind === 'production-port') f.operator.PORT = '3100';
    if (kind === 'other-port') f.operator.PORT = '3191';
    if (kind === 'missing-canonical') f.args.pop();
    writeFileSync(f.registrationPath, JSON.stringify(f.registration));
    writeFileSync(f.operatorPath, JSON.stringify(f.operator));
    const result = spawnSync(process.execPath, f.args, {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.plan.planDirectory, 'launch.intent'))).toBe(false);
  },
);
