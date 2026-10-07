import { afterEach, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  cpSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'staging-prepare-cli-')));
  roots.push(home);
  const root = join(home, '.local/share/mitzo-staging'),
    source = 'a'.repeat(40),
    release = join(root, 'releases', source.slice(0, 12)),
    service = join(root, 'symposium/service');
  for (const p of [
    'symposium/service',
    'symposium/settings',
    'symposium/home',
    'symposium/workspace',
    'registry',
  ]
    .map((name) => join(root, name))
    .concat([release, join(release, 'scripts'), join(release, 'dist')]))
    mkdirSync(p, { recursive: true, mode: 0o700 });
  const json = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  json(join(release, 'package.json'), { type: 'module' });
  cpSync(
    'scripts/prepare-staging-service.mjs',
    join(release, 'scripts/prepare-staging-service.mjs'),
  );
  cpSync('node_modules/zod', join(release, 'node_modules/zod'), {
    recursive: true,
    dereference: true,
  });
  for (const name of [
    'symposium-staging-service',
    'symposium-staging-environment',
    'symposium-staging-identity',
    'symposium-staging-launch-schema',
  ])
    writeFileSync(
      join(release, 'dist', name + '.js'),
      ts.transpileModule(readFileSync('server/' + name + '.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  writeFileSync(
    join(release, 'dist/symposium-owned-release.js'),
    "import {readFileSync} from 'node:fs';export const readOwnedReleasePlan=path=>JSON.parse(readFileSync(path));export const verifyOwnedRelease=()=>{};",
  );
  const plan = {
    sourceCommit: source,
    releaseRoot: release,
    planDirectory: service,
    repositoryPath: join(root, 'symposium/workspace'),
    appHome: join(root, 'symposium/home'),
    configPath: join(root, 'symposium/settings/owned-host.json'),
  };
  json(join(service, 'owned-release.json'), plan);
  const registration = join(root, 'symposium/settings/staging-registration.json');
  json(registration, {
    registryDirectory: join(root, 'registry'),
    capacity: 1,
    ownerChat: 'cli-test',
    purpose: 'static preparation',
    retentionReason: 'synthetic only',
    reviewAfter: Date.now() + 86400000,
  });
  const fixtureImport = join(release, 'fixture.mjs');
  writeFileSync(
    fixtureImport,
    `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const old=os.userInfo;os.userInfo=()=>({...old(),homedir:${JSON.stringify(home)}});cp.spawnSync=()=>{throw Error('OS control forbidden during preparation');};cp.execFileSync=()=>{throw Error('OS control forbidden during preparation');};syncBuiltinESMExports();`,
  );
  const run = (port = '3190', canonical = true) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        fixtureImport,
        join(release, 'scripts/prepare-staging-service.mjs'),
        join(service, 'owned-release.json'),
        registration,
        port,
        ...(canonical ? ['--canonical'] : []),
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 },
    );
  return { root, service, registration, run };
}
it('actual preparation emits only a private manually started canonical job without OS control', () => {
  const f = fixture(),
    result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    label: 'com.mitzo.staging',
    installed: false,
    started: false,
    modelCalls: 0,
  });
  const plist = readFileSync(join(f.service, 'staging-custodian.plist'), 'utf8');
  expect(plist).toContain('<key>KeepAlive</key><false/>');
  expect(plist).toContain('<key>RunAtLoad</key><false/>');
  expect(existsSync(join(f.service, 'launch.intent'))).toBe(false);
  expect(existsSync(join(f.root, 'registry/staging.db'))).toBe(false);
});
it('canonical preparation refuses absent canonical mode, production port and nonsingleton registration', () => {
  for (const kind of ['mode', 'production', 'capacity']) {
    const f = fixture();
    if (kind === 'capacity') {
      const reg = JSON.parse(readFileSync(f.registration, 'utf8'));
      reg.capacity = 2;
      writeFileSync(f.registration, JSON.stringify(reg));
    }
    const result = f.run(kind === 'production' ? '3100' : '3190', kind !== 'mode');
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.service, 'staging-custodian.plist'))).toBe(false);
  }
});
