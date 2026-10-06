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
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'staging-service-entry-')));
  roots.push(root);
  chmodSync(root, 0o700);
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
    planDirectory: join(root, 'plan'),
    repositoryPath: join(root, 'repo'),
    appHome: root,
    configPath: join(root, 'host.json'),
    entry: 'dist/symposium-custodian-main.js',
  };
  writeFileSync(join(root, 'plan/owned-release.json'), JSON.stringify(plan));
  writeFileSync(join(root, 'registration.json'), '{}', { mode: 0o600 });
  const operator = {
    AUTH_PASSPHRASE: 'synthetic-offline-passphrase-000000000000',
    AUTH_SECRET: 'synthetic-offline-secret-'.padEnd(64, '0'),
    PORT: '19994',
    MITZO_BIND_HOST: '127.0.0.1',
  };
  writeFileSync(join(root, 'plan/staging-operator.json'), JSON.stringify(operator), {
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
    join(root, 'scripts/start-staging-custodian.mjs'),
    join(root, 'plan/owned-release.json'),
    join(root, 'registration.json'),
    join(root, 'plan/staging-operator.json'),
  ];
  return { root, args, operator };
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
