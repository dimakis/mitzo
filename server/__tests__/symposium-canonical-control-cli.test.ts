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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import ts from 'typescript';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture(mode = 'confirmed') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-control-cli-')));
  roots.push(home);
  chmodSync(home, 0o700);
  const root = join(home, '.local/share/mitzo-staging'),
    source = 'a'.repeat(40),
    release = join(root, 'releases', source.slice(0, 12)),
    service = join(root, 'symposium/service'),
    state = join(root, 'symposium/state/gateway');
  for (const p of [
    release,
    join(release, 'scripts'),
    join(release, 'dist'),
    service,
    state,
    join(state, 'gateway-one'),
    join(root, 'registry'),
    join(root, 'service'),
    join(root, 'symposium/settings'),
    join(root, 'symposium/home'),
    join(root, 'symposium/workspace'),
  ])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  writeFileSync(join(release, 'package.json'), '{"type":"module"}');
  symlinkSync(realpathSync('node_modules'), join(release, 'node_modules'));
  cpSync('scripts/symposium-staging.mjs', join(release, 'scripts/symposium-staging.mjs'));
  // Select only the macOS adapter branch; keep Node/native-addon platform real.
  const cliPath = join(release, 'scripts/symposium-staging.mjs');
  writeFileSync(
    cliPath,
    readFileSync(cliPath, 'utf8').replace("process.platform !== 'darwin'", 'false'),
  );
  for (const name of [
    'symposium-staging-service',
    'symposium-staging-identity',
    'symposium-custodian-launch',
    'symposium-canonical-control',
    'symposium-canonical-owner-record',
    'symposium-custodian-retirement',
  ])
    writeFileSync(
      join(release, 'dist', name + '.js'),
      ts.transpileModule(readFileSync('server/' + name + '.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  // Only immutable-release validation and OS commands are synthetic. The CLI,
  // private reader, original identities, real SQL, lock and retirement reader run.
  writeFileSync(
    join(release, 'dist/symposium-owned-release.js'),
    `import {readFileSync} from 'node:fs'; export const readOwnedReleasePlan=p=>JSON.parse(readFileSync(p));export const verifyRetainedOwnedRelease=()=>{};`,
  );
  writeFileSync(
    join(release, 'dist/symposium-owned-config-schema.js'),
    `import {readFileSync} from 'node:fs';export const readOwnedSymposiumHostConfig=p=>JSON.parse(readFileSync(p));`,
  );
  const schemaSource = readFileSync('server/symposium-staging-launch.ts', 'utf8').match(
    /export const StagingLaunchSchema = ([\s\S]*?);\n\/\//,
  )![1];
  writeFileSync(
    join(release, 'dist/symposium-staging-launch.js'),
    `import {z} from 'zod'; import {isAbsolute} from 'node:path'; export const StagingLaunchSchema=${schemaSource};`,
  );
  const plan = {
    schemaVersion: 1,
    mode: 'owned-custodian',
    entry: 'dist/symposium-custodian-main.js',
    releaseRoot: release,
    planDirectory: service,
    repositoryPath: join(root, 'symposium/workspace'),
    appHome: join(root, 'symposium/home'),
    configPath: join(root, 'symposium/settings/owned-host.json'),
    sourceCommit: source,
    configSha256: 'b'.repeat(64),
    buildSha256: 'c'.repeat(64),
    admissionVerified: false,
  };
  const json = (p: string, value: unknown) =>
    writeFileSync(p, JSON.stringify(value), { mode: 0o600 });
  json(join(service, 'owned-release.json'), plan);
  json(plan.configPath, { gateway: { stateParent: state } });
  json(join(root, 'symposium/settings/staging-registration.json'), {
    registryDirectory: join(root, 'registry'),
    capacity: 1,
    ownerChat: 'cli-test',
    purpose: 'original control wiring',
    retentionReason: 'synthetic only',
    reviewAfter: Date.now() + 86400000,
  });
  json(join(service, 'original-owner.json'), {
    version: 1,
    sourceCommit: source,
    configSha256: plan.configSha256,
    buildSha256: plan.buildSha256,
    instanceId: 'original',
    epoch: 2,
    capturedAt: 100,
    parent: { pid: 111, birth: 'parent birth', cwd: release },
    app: { pid: 112, birth: 'app birth', cwd: release, parentPid: 111 },
  });
  writeFileSync(join(service, 'launch.intent'), 'original', { mode: 0o600 });
  const dbPath = join(root, 'registry/staging.db'),
    db = new Database(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(
    'CREATE TABLE policy(id INTEGER, capacity INTEGER); INSERT INTO policy VALUES(1,1);CREATE TABLE launches(planDirectory TEXT,sourceCommit TEXT,configSha256 TEXT,buildSha256 TEXT,state TEXT,instanceId TEXT,controllerGeneration INTEGER,createdAt INTEGER,completedAt INTEGER,retirementStateParent TEXT)',
  );
  db.prepare('INSERT INTO launches VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    service,
    source,
    plan.configSha256,
    plan.buildSha256,
    'active',
    'original',
    2,
    50,
    null,
    null,
  );
  db.close();
  const prelude = join(release, 'operator-fixture.mjs'),
    calls = join(home, 'calls.json');
  json(calls, []);
  writeFileSync(
    prelude,
    `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {readFileSync,writeFileSync} from 'node:fs';import Database from 'better-sqlite3';
const original=os.userInfo;os.userInfo=()=>({...original(),homedir:${JSON.stringify(home)}});let stopped=false;const mode=${JSON.stringify(mode)},release=${JSON.stringify(release)},state=${JSON.stringify(state)};
cp.execFileSync=(program,args)=>{
 if(program==='/bin/launchctl'&&args[0]==='print')return stopped?'state = not running':'pid = 111';
 if(program==='/bin/launchctl'&&args[0]==='kill'){
  const p=${JSON.stringify(calls)};const calls=JSON.parse(readFileSync(p));calls.push([program,...args]);writeFileSync(p,JSON.stringify(calls));stopped=true;
  if(mode!=='uncertain'){const completedAt=Date.now()+1;const db=new Database(${JSON.stringify(dbPath)});db.prepare("UPDATE launches SET state='retired',completedAt=?,retirementStateParent=?").run(completedAt,state);db.close();writeFileSync(state+'/custodian-retirement.json',JSON.stringify({version:1,gatewayStateDirectory:state+'/gateway-one',instanceId:'original',controllerGeneration:2,completedAt}),{mode:0o600});}return '';
 }
 if(program==='/bin/ps')return args.includes('lstart=')?(args[1]==='111'?'parent birth':'app birth'):(args[1]==='112'?'111':'1');
 if(program==='/usr/sbin/lsof')return 'p'+args[3]+'\\nfcwd\\nn'+release;
 throw Error('Unmocked OS execution refused: '+program);
};
cp.spawnSync=(program,args)=>{
 if(program==='/usr/sbin/lsof'){const port=args.find(x=>x.startsWith('-iTCP:')).split(':')[1];const ids=port==='3190'?(stopped?[]:[112]):port==='3100'?(mode==='production'?[112]:[900]):[];return {status:ids.length?0:1,stdout:ids.join('\\n')};}
 if(program==='/bin/ps'&&args.includes('pid='))return {status:stopped?1:0,stdout:stopped?'':args[1]};
 throw Error('Unmocked OS execution refused: '+program);
};syncBuiltinESMExports();`,
  );
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', prelude, join(release, 'scripts/symposium-staging.mjs'), ...args],
      { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 },
    );
  const drain = ['drain', '--source', source, '--instance', 'original', '--epoch', '2', '--apply'];
  return { root, service, calls, run, drain };
}
it('checks the original topology through the actual CLI without controlling it', () => {
  const f = fixture();
  const result = f.run(['check', '--offline']);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ safe: true, parentPid: 111, appPid: 112 });
  expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
});
it('signals only the original staging job and confirms the real registry/receipt before unlocking', () => {
  const f = fixture();
  const result = f.run(f.drain);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ retired: true, replacementStarted: false });
  expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([
    ['/bin/launchctl', 'kill', 'SIGTERM', 'gui/' + process.getuid() + '/com.mitzo.staging'],
  ]);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(false);
  expect(readFileSync(join(f.service, 'launch.intent'), 'utf8')).toBe('original');
});
it('keeps the lock and original evidence when processes disappear without native retirement', () => {
  const f = fixture('uncertain');
  const result = f.run(f.drain);
  expect(result.status).not.toBe(0);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  expect(readFileSync(join(f.service, 'launch.intent'), 'utf8')).toBe('original');
});
it('refuses a production listener before creating a lock or signalling anything', () => {
  const f = fixture('production');
  const result = f.run(f.drain);
  expect(result.status).not.toBe(0);
  expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(false);
});
