import { afterEach, expect, it } from 'vitest';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
const authEnv = {
  PATH: process.env.PATH,
  AUTH_PASSPHRASE: 'synthetic-offline-passphrase-000000000000',
  AUTH_SECRET: 'synthetic-offline-secret-'.padEnd(64, '0'),
  PORT: '19992',
  MITZO_BIND_HOST: '127.0.0.1',
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-launch-')));
  roots.push(root);
  for (const name of ['scripts', 'dist', 'plan', 'repo'])
    mkdirSync(join(root, name), { mode: 0o700 });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  cpSync('scripts/start-owned-custodian.mjs', join(root, 'scripts/start-owned-custodian.mjs'));
  writeFileSync(
    join(root, 'dist/symposium-staging-environment.js'),
    ts.transpileModule(readFileSync('server/symposium-staging-environment.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
  // Exercise the actual shared environment helper in this disposable release,
  // rather than bypassing its isolation checks with another stub.
  writeFileSync(
    join(root, 'dist/symposium-custodian-launch.js'),
    ts.transpileModule(readFileSync('server/symposium-custodian-launch.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
  writeFileSync(
    join(root, 'dist/symposium-staging-identity.js'),
    ts.transpileModule(readFileSync('server/symposium-staging-identity.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
  const plan = {
    appHome: root,
    releaseRoot: root,
    planDirectory: join(root, 'plan'),
    repositoryPath: join(root, 'repo'),
    configPath: join(root, 'host.json'),
    entry: 'dist/symposium-custodian-main.js',
  };
  writeFileSync(join(root, 'plan/owned-release.json'), JSON.stringify(plan));
  writeFileSync(
    join(root, 'dist/symposium-owned-release.js'),
    `import {readFileSync,writeFileSync} from 'node:fs';export const readOwnedReleasePlan=p=>JSON.parse(readFileSync(p));export const verifyOwnedRelease=p=>{if(p.entry!=='dist/symposium-custodian-main.js')throw Error();};export const claimOwnedLaunch=p=>writeFileSync(p.planDirectory+'/launch.intent','claimed',{flag:'wx',mode:0o600});`,
  );
  writeFileSync(
    join(root, 'dist/symposium-custodian-main.js'),
    `console.log(JSON.stringify({entry:'custodian',repo:process.env.REPO_PATH,config:process.env.MITZO_SYMPOSIUM_OWNED_HOST_CONFIG,legacy:process.env.MITZO_OPENSHELL_ENABLED,accounts:process.env.MITZO_ACCOUNT_PROFILES_FILE,ambient:Object.keys(process.env).filter(k=>['HTTPS_PROXY','GH_TOKEN','GOOGLE_APPLICATION_CREDENTIALS'].includes(k))}));`,
  );
  writeFileSync(join(root, 'dist/index.js'), `throw Error('ordinary entry must not run');`);
  return { root, plan };
}
it('executes the fixed custodian entry only after claim; repeat startup cannot exec', () => {
  const f = fixture();
  const args = [
    join(f.root, 'scripts/start-owned-custodian.mjs'),
    join(f.root, 'plan/owned-release.json'),
  ];
  const first = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...authEnv,
      MITZO_OPENSHELL_ENABLED: '1',
      REPO_PATH: '/wrong',
      HTTPS_PROXY: 'http://invalid',
      GH_TOKEN: 'synthetic-not-a-token',
      GOOGLE_APPLICATION_CREDENTIALS: '/must-not-read',
    },
  });
  expect(first.status, first.stderr).toBe(0);
  expect(readFileSync(join(f.plan.planDirectory, 'launch.intent'), 'utf8')).toBe('claimed');
  expect(JSON.parse(first.stdout)).toEqual({
    entry: 'custodian',
    repo: f.plan.repositoryPath,
    config: f.plan.configPath,
    legacy: '0',
    accounts: join(f.plan.planDirectory, 'empty-accounts.json'),
    ambient: [],
  });
  expect(spawnSync(process.execPath, args, { encoding: 'utf8', env: authEnv }).status).not.toBe(0);
});
it('does not claim or execute when entry/config verification fails', () => {
  const f = fixture();
  writeFileSync(
    join(f.root, 'plan/owned-release.json'),
    JSON.stringify({ ...f.plan, entry: 'dist/index.js' }),
  );
  const result = spawnSync(
    process.execPath,
    [join(f.root, 'scripts/start-owned-custodian.mjs'), join(f.root, 'plan/owned-release.json')],
    { encoding: 'utf8', env: authEnv },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain('/wrong');
  expect(() => readFileSync(join(f.root, 'plan/launch.intent'))).toThrow();
});
it.each([
  {},
  { AUTH_PASSPHRASE: 'short' },
  { NODE_OPTIONS: '--trace-warnings' },
  { DOTENV_CONFIG_PATH: '/ambient/private' },
  { PORT: '3100junk' },
  { MITZO_BIND_HOST: '0.0.0.0' },
])('rejects missing/unsafe launch settings before claim %j', (override) => {
  const f = fixture();
  const result = spawnSync(
    process.execPath,
    [join(f.root, 'scripts/start-owned-custodian.mjs'), join(f.root, 'plan/owned-release.json')],
    {
      encoding: 'utf8',
      env: Object.keys(override).length ? { ...authEnv, ...override } : { PATH: process.env.PATH },
    },
  );
  expect(result.status).not.toBe(0);
  expect(() => readFileSync(join(f.root, 'plan/launch.intent'))).toThrow();
});

it('rejects an unregistered canonical plan before claiming or executing', () => {
  const f = fixture();
  const dir = join(f.root, 'symposium/service');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'owned-release.json');
  writeFileSync(path, JSON.stringify({ ...f.plan, planDirectory: dir }));
  const result = spawnSync(
    process.execPath,
    [join(f.root, 'scripts/start-owned-custodian.mjs'), path],
    { encoding: 'utf8', env: authEnv },
  );
  expect(result.status).not.toBe(0);
  expect(() => readFileSync(join(dir, 'launch.intent'))).toThrow();
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
});
