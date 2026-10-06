import { afterEach, expect, it } from 'vitest';
import {
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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture(mode = 'ok') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'staging-transition-cli-'))),
    root = join(home, '.local/share/mitzo-staging');
  roots.push(home);
  const old = 'a'.repeat(40),
    target = 'b'.repeat(40),
    release = join(root, 'releases', target.slice(0, 12)),
    oldRelease = join(root, 'releases', old.slice(0, 12)),
    owned = join(root, 'symposium/service'),
    service = join(root, 'service');
  const dirs = [
    'bin',
    'service',
    'registry',
    'workspace',
    'state',
    'home',
    'settings',
    'symposium/service',
    'symposium/settings',
    'symposium/home',
    'symposium/workspace',
  ];
  for (const p of dirs
    .map((x) => join(root, x))
    .concat([release, oldRelease, join(release, 'scripts/lib'), join(release, 'dist')]))
    mkdirSync(p, { recursive: true, mode: 0o700 });
  const json = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v), { mode: 0o600 });
  const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
  for (const n of [
    'scripts/symposium-staging-transition.mjs',
    'scripts/lib/symposium-staging-transition.mjs',
    'scripts/lib/symposium-staging-router.mjs',
  ])
    cpSync(n, join(release, n));
  const cli = join(release, 'scripts/symposium-staging-transition.mjs');
  writeFileSync(cli, readFileSync(cli, 'utf8').replace("process.platform !== 'darwin'", 'false'));
  json(join(release, 'package.json'), { type: 'module' });
  symlinkSync(realpathSync('node_modules'), join(release, 'node_modules'));
  for (const name of ['symposium-canonical-owner-record', 'symposium-canonical-control'])
    writeFileSync(
      join(release, 'dist', name + '.js'),
      ts.transpileModule(readFileSync('server/' + name + '.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  writeFileSync(
    join(release, 'dist/symposium-staging-service.js'),
    `export const canonicalStagingRoot=()=>${JSON.stringify(root)};export const assertCanonicalStagingService=()=>{};export const readStagingOperatorEnvironment=()=>{};`,
  );
  writeFileSync(
    join(release, 'dist/symposium-owned-release.js'),
    `import {readFileSync,existsSync} from 'node:fs';export const readOwnedReleasePlan=p=>JSON.parse(readFileSync(p));export const verifyOwnedRelease=()=>{if(existsSync(${JSON.stringify(join(home, 'source-drift'))}))throw Error('source drift');};`,
  );
  const plan = {
    sourceCommit: target,
    releaseRoot: release,
    planDirectory: owned,
    configPath: join(root, 'symposium/settings/owned-host.json'),
    configSha256: 'c'.repeat(64),
    buildSha256: 'd'.repeat(64),
  };
  json(join(owned, 'owned-release.json'), plan);
  json(plan.configPath, { synthetic: true });
  json(join(root, 'symposium/settings/staging-registration.json'), { capacity: 1 });
  json(join(owned, 'staging-operator.json'), {});
  writeFileSync(join(owned, 'staging-custodian.plist'), 'prepared', { mode: 0o600 });
  writeFileSync(join(service, 'com.mitzo.staging.plist'), 'old', { mode: 0o600 });
  writeFileSync(join(service, 'start.mjs'), 'old start', { mode: 0o600 });
  writeFileSync(join(root, 'bin/staging.mjs'), 'old controller', { mode: 0o600 });
  writeFileSync(join(root, 'bin/mitzo-staging'), 'old wrapper', { mode: 0o700 });
  for (const n of ['workspace', 'state', 'home', 'settings'])
    writeFileSync(join(root, n, 'retained'), 'original ' + n, { mode: 0o600 });
  const artifacts: Record<string, string> = {};
  for (const n of [
    'dist',
    'frontend/dist',
    'packages/protocol/dist',
    'packages/harness/dist',
    'packages/client/dist',
  ]) {
    mkdirSync(join(oldRelease, n), { recursive: true, mode: 0o700 });
    const p = join(oldRelease, n, 'one.js');
    writeFileSync(p, 'original');
    artifacts[n + '/one.js'] = hash('original');
  }
  mkdirSync(join(oldRelease, 'node_modules'), { mode: 0o700 });
  const fp = hash(JSON.stringify(['node_modules', 0o700]) + '\n');
  json(join(service, 'release-receipt.json'), {
    sourceCommit: old,
    sourceTree: 'e'.repeat(40),
    release: oldRelease,
    label: 'com.mitzo.staging',
    port: 3190,
    bind: '127.0.0.1',
    workspace: join(root, 'workspace'),
    compiledArtifacts: artifacts,
    dependencyFingerprint: fp,
  });
  const calls = join(home, 'calls.json');
  json(calls, []);
  const prelude = join(release, 'fixture.mjs');
  writeFileSync(
    prelude,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {readFileSync,writeFileSync} from 'node:fs';import Database from 'better-sqlite3';
const root=${JSON.stringify(root)},oldRelease=${JSON.stringify(oldRelease)},release=${JSON.stringify(release)},owned=${JSON.stringify(owned)},mode=${JSON.stringify(mode)},calls=${JSON.stringify(calls)};let stopped=false,booted=false,started=false,tick=Date.now();if(mode==='uncertain')Date.now=()=>{tick+=200000;return tick;};
function record(program,args){const c=JSON.parse(readFileSync(calls));c.push([program,...args]);writeFileSync(calls,JSON.stringify(c));}
cp.execFileSync=(program,args)=>{if(program==='/bin/ps')return args.includes('lstart=')?(args[1]==='42'?'old birth':args[1]==='111'?'parent birth':'app birth'):(args[1]==='112'?'111':'1');if(program==='/usr/sbin/lsof')return 'p'+args[3]+'\\nfcwd\\nn'+(args[2]==='42'?oldRelease:release);throw Error('Unmocked OS execution '+program);};
cp.spawnSync=(program,args)=>{
 if(program==='git'){if(args[0]==='ls-remote')return {status:0,stdout:(mode==='main-mismatch'?${JSON.stringify(old)}:${JSON.stringify(target)})+' refs/heads/main'};if(args[0]==='rev-parse')return {status:0,stdout:args[1]==='HEAD'?${JSON.stringify(old)}:'e'.repeat(40)};if(args[0]==='remote')return {status:0,stdout:'https://github.com/dimakis/mitzo.git'};return {status:0,stdout:''};}
 if(program==='/usr/bin/plutil'){const canonical=args.at(-1).includes('/symposium/');const plist=canonical?{Label:'com.mitzo.staging',ProgramArguments:[process.execPath,release+'/scripts/start-staging-custodian.mjs',owned+'/owned-release.json',root+'/symposium/settings/staging-registration.json',owned+'/staging-operator.json','--canonical'],EnvironmentVariables:{NODE_OPTIONS:'',NODE_PATH:'',DOTENV_CONFIG_PATH:'/dev/null'},WorkingDirectory:release,StandardOutPath:owned+'/owner.stdout.log',StandardErrorPath:owned+'/owner.stderr.log',KeepAlive:false,RunAtLoad:false,ExitTimeOut:180}:{Label:'com.mitzo.staging',KeepAlive:false,WorkingDirectory:oldRelease,ProgramArguments:[process.execPath,root+'/service/start.mjs']};if(mode==='unsafe-plist'&&canonical)plist.EnvironmentVariables.NODE_OPTIONS='--import /production/hook.mjs';return {status:0,stdout:JSON.stringify(plist)};}
 if(program==='/usr/sbin/lsof'){const port=args.find(x=>x.startsWith('-iTCP:')).split(':')[1],pids=port==='3190'?(started?[112]:stopped?[]:[42]):port==='3100'?(mode==='production'?[42]:[900]):[];return {status:pids.length?0:1,stdout:pids.join('\\n')};}
 if(program==='/bin/ps')return {status:stopped&&mode!=='uncertain'?1:0,stdout:stopped?'':'42'};
 if(program==='/bin/launchctl'){
  if(args[0]==='print')return {status:0,stdout:'path = '+root+'/service/com.mitzo.staging.plist\\n'+(started?'pid = 111':stopped?'state = not running':'pid = 42')};
  record(program,args);if(args[0]==='kill')stopped=true;if(args[0]==='bootstrap')booted=true;if(args[0]==='kickstart'){if(!booted)throw Error('not bootstrapped');started=true;const db=new Database(root+'/registry/staging.db');db.exec('CREATE TABLE policy(id INTEGER,capacity INTEGER);INSERT INTO policy VALUES(1,1);CREATE TABLE launches(planDirectory TEXT,sourceCommit TEXT,configSha256 TEXT,buildSha256 TEXT,state TEXT,instanceId TEXT,controllerGeneration INTEGER,createdAt INTEGER)');db.prepare('INSERT INTO launches VALUES(?,?,?,?,?,?,?,?)').run(owned,${JSON.stringify(target)},'c'.repeat(64),'d'.repeat(64),'active','original',1,1);db.close();const {chmodSync}=awaitNo();chmodSync(root+'/registry/staging.db',0o600);writeFileSync(owned+'/original-owner.json',JSON.stringify({version:1,sourceCommit:${JSON.stringify(target)},configSha256:'c'.repeat(64),buildSha256:'d'.repeat(64),instanceId:'original',epoch:1,capturedAt:2,parent:{pid:111,birth:'parent birth',cwd:release},app:{pid:112,birth:'app birth',cwd:release,parentPid:111}}),{mode:0o600});}return {status:0,stdout:''};}
 throw Error('Unmocked OS execution '+program);
};import {chmodSync} from 'node:fs';function awaitNo(){return {chmodSync};}globalThis.fetch=async()=>({ok:true});syncBuiltinESMExports();`,
  );
  const run = (command: string) =>
    spawnSync(
      process.execPath,
      ['--import', prelude, cli, command, '--commit', target, '--expected-current', old],
      { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } },
    );
  return { root, owned, service, calls, run, home, target };
}
it('actual CLI prepare and plan do not signal; tampered private input refuses apply', () => {
  const f = fixture();
  {
    const p = f.run('prepare');
    expect(p.status, p.stderr).toBe(0);
  }
  expect(f.run('plan').status).toBe(0);
  writeFileSync(join(f.owned, 'staging-custodian.plist'), 'changed');
  expect(f.run('apply').status).not.toBe(0);
  expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
});
it('exact main mismatch refuses before original control', () => {
  const f = fixture('main-mismatch');
  {
    const p = f.run('prepare');
    expect(p.status, p.stderr).toBe(0);
  }
  const r = f.run('apply');
  expect(r.status, r.stderr).not.toBe(0);
  expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
  expect(existsSync(join(f.service, 'deployment.lock'))).toBe(false);
});
it('unsafe launch environment and protected listener refuse preparation', () => {
  for (const mode of ['unsafe-plist', 'production']) {
    const f = fixture(mode);
    expect(f.run('prepare').status).not.toBe(0);
    expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
  }
});
it('uncertain original exit retains lock without bootstrap', () => {
  const f = fixture('uncertain');
  {
    const p = f.run('prepare');
    expect(p.status, p.stderr).toBe(0);
  }
  const r = f.run('apply');
  expect(r.status, r.stderr).not.toBe(0);
  expect(existsSync(join(f.service, 'deployment.lock'))).toBe(true);
  expect(JSON.parse(readFileSync(f.calls, 'utf8')).map((x: string[]) => x[1])).toEqual(['kill']);
});
it('one same-label transition preserves ordinary data and installs owned-only router', () => {
  const f = fixture();
  {
    const p = f.run('prepare');
    expect(p.status, p.stderr).toBe(0);
  }
  const r = f.run('apply');
  expect(r.status, r.stderr).toBe(0);
  const output = JSON.parse(r.stdout);
  expect(existsSync(join(f.service, 'deployment.lock'))).toBe(false);
  for (const n of ['workspace', 'state', 'home', 'settings'])
    expect(readFileSync(join(output.backup, n, 'retained'), 'utf8')).toBe('original ' + n);
  expect(JSON.parse(readFileSync(f.calls, 'utf8')).map((x: string[]) => x[1])).toEqual([
    'kill',
    'bootout',
    'bootstrap',
    'kickstart',
  ]);
  expect(JSON.parse(readFileSync(join(f.service, 'topology.json'), 'utf8')).sourceCommit).toBe(
    f.target,
  );
  expect(readFileSync(join(f.root, 'bin/staging.mjs'), 'utf8')).toContain("['check', 'drain']");
});

it('stored process birth and malformed intent cannot retarget control', () => {
  for (const field of ['birth', 'id']) {
    const f = fixture();
    const p = f.run('prepare');
    expect(p.status, p.stderr).toBe(0);
    const path = join(f.owned, 'transition.json'),
      intent = JSON.parse(readFileSync(path, 'utf8'));
    if (field === 'birth') intent.original.birth = 'reused PID';
    else intent.id = '../../production';
    writeFileSync(path, JSON.stringify(intent));
    expect(f.run('apply').status).not.toBe(0);
    expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
  }
});
it('retained registry sidecars and existing owner log targets refuse before control', () => {
  for (const name of ['registry/staging.db-wal', 'symposium/service/owner.stdout.log']) {
    const f = fixture();
    writeFileSync(join(f.root, name), 'retained evidence', { mode: 0o600 });
    expect(f.run('prepare').status).not.toBe(0);
    expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
  }
});
it('unexpected compiled artifacts refuse ordinary source qualification', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'releases', 'a'.repeat(12), 'dist', 'unexpected.js'), 'added');
  expect(f.run('prepare').status).not.toBe(0);
  expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
});
