import process from 'node:process';
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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { artifacts, fingerprintDirectory } from '../../scripts/lib/staging-files.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(mode = 'valid') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'staging-control-cli-')));
  roots.push(home);
  const root = join(home, '.local/share/mitzo-staging'),
    old = 'a'.repeat(40),
    target = 'b'.repeat(40),
    oldRelease = join(root, 'releases', old.slice(0, 12)),
    next = join(root, 'releases', target.slice(0, 12));
  for (const name of ['service', 'settings', 'workspace', 'state', 'home', 'releases', 'bin/lib'])
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  const cli = join(root, 'bin/staging.mjs');
  writeFileSync(
    cli,
    readFileSync('scripts/staging.mjs', 'utf8').replace("process.platform !== 'darwin'", 'false'),
  );
  for (const name of [
    'staging-files',
    'staging-job',
    'staging-operations',
    'staging-launcher-template',
  ])
    cpSync('scripts/lib/' + name + '.mjs', join(root, 'bin/lib', name + '.mjs'));
  const receipt = (release, source) => {
    for (const folder of [
      'dist',
      'frontend/dist',
      'packages/protocol/dist',
      'packages/harness/dist',
      'packages/client/dist',
      '.git',
      'node_modules',
    ])
      mkdirSync(join(release, folder), { recursive: true, mode: 0o700 });
    writeFileSync(join(release, 'dist/index.js'), '// compiled fixture');
    return {
      label: 'com.mitzo.staging',
      port: 3190,
      bind: '127.0.0.1',
      workspace: join(root, 'workspace'),
      release,
      sourceCommit: source,
      sourceTree: 'c'.repeat(40),
      compiledArtifacts: artifacts(release),
      dependencyFingerprint: fingerprintDirectory(release, 'node_modules'),
    };
  };
  const active = receipt(oldRelease, old),
    candidate = receipt(next, target);
  if (mode === 'missing-fingerprint') delete candidate.dependencyFingerprint;
  const json = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  json(join(root, 'service/release-receipt.json'), active);
  json(join(next, 'staging-release.json'), candidate);
  mkdirSync(join(next, 'scripts/lib'), { recursive: true });
  cpSync(cli, join(next, 'scripts/staging.mjs'));
  for (const name of [
    'staging-files',
    'staging-job',
    'staging-operations',
    'staging-launcher-template',
  ])
    cpSync(join(root, 'bin/lib', name + '.mjs'), join(next, 'scripts/lib', name + '.mjs'));
  const calls = join(home, 'calls.json');
  json(calls, []);
  const preload = join(home, 'fixture.mjs');
  writeFileSync(
    preload,
    `import os from 'node:os';import cp from 'node:child_process';import {readFileSync,writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(home)};const root=${JSON.stringify(root)},oldRelease=${JSON.stringify(oldRelease)},next=${JSON.stringify(next)},mode=${JSON.stringify(mode)},calls=${JSON.stringify(calls)};let stopped=false,started=false,birthReads=0,clock=Date.now();if(mode==='lingering-original')Date.now=()=>{clock+=50000;return clock;};
 cp.spawnSync=(program,args,options)=>{
  if(program==='git'){if(args[0]==='-c')args=args.slice(4);if(args[0]==='ls-remote')return {status:0,stdout:${JSON.stringify(target)}+' refs/heads/main'};if(args[0]==='rev-parse'&&args[1]==='--show-toplevel')return {status:0,stdout:mode==='worktree-redirect'&&options.cwd!==oldRelease?oldRelease:options.cwd};if(args[0]==='rev-parse')return {status:0,stdout:args[1]==='HEAD^{tree}'?'c'.repeat(40):options.cwd===oldRelease?${JSON.stringify(old)}:${JSON.stringify(target)}};if(args[0]==='remote')return {status:0,stdout:'https://github.com/dimakis/mitzo.git'};return {status:0,stdout:''};}
  if(program==='launchctl'){if(args[0]==='print')return {status:0,stdout:'path = '+(mode==='changed-registration'?'/outside.plist':root+'/service/com.mitzo.staging.plist')+'\\n'+(started?'pid = 43':stopped?'state = not running':'pid = 42')};const values=JSON.parse(readFileSync(calls));values.push([program,...args]);writeFileSync(calls,JSON.stringify(values));if(args[0]==='kill')stopped=true;if(args[0]==='kickstart')started=true;return {status:0,stdout:''};}
  if(program==='/bin/ps'){if(args.includes('lstart=')){birthReads++;return {status:0,stdout:mode==='reused-pid'&&birthReads>1?'successor birth':args[1]==='43'?'new birth':'original birth'};}return {status:stopped&&mode!=='lingering-original'?1:0,stdout:stopped&&mode!=='lingering-original'?'':'42'};}
  if(program==='/usr/sbin/lsof'){if(args.includes('cwd'))return {status:0,stdout:'p42\\nfcwd\\nn'+(started?next:oldRelease)};const port=args.find(x=>x.startsWith('-iTCP:')).split(':')[1],ids=port==='3190'?(started?[43]:stopped?[]:[42]):port==='3100'?[900]:[];return {status:ids.length?0:1,stdout:ids.join('\\n')};}
  throw Error('Unmocked execution: '+program);
 };globalThis.fetch=async()=>({ok:true});syncBuiltinESMExports();`,
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        cli,
        'deploy',
        '--commit',
        target,
        '--expected-current',
        old,
        '--apply',
      ],
      { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } },
    );
  return { root, calls, run, old, target };
}
it.each(['changed-registration', 'reused-pid', 'missing-fingerprint'])(
  'actual deploy refuses %s before original service control',
  (mode) => {
    const f = fixture(mode),
      result = f.run();
    expect(result.status, result.stderr).not.toBe(0);
    expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
  },
);
it('actual deploy keeps the lock and old receipt while original process remains alive without its listener', () => {
  const f = fixture('lingering-original'),
    result = f.run();
  expect(result.status, result.stderr).not.toBe(0);
  expect(JSON.parse(readFileSync(f.calls, 'utf8')).map((call) => call[1])).toEqual(['kill']);
  expect(
    JSON.parse(readFileSync(join(f.root, 'service/release-receipt.json'), 'utf8')).sourceCommit,
  ).toBe(f.old);
  expect(JSON.parse(readFileSync(join(f.root, 'service/deployment.lock'), 'utf8')).expected).toBe(
    f.old,
  );
});
it('actual deploy controls only the pinned service and verifies one successor after original process exit', () => {
  const f = fixture(),
    result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.calls, 'utf8')).map((call) => call[1])).toEqual([
    'kill',
    'kickstart',
  ]);
  expect(JSON.parse(result.stdout).deployed).toBe(f.target);
});

it('actual ordinary apply refuses a clean Git worktree redirected away from the receipt release', () => {
  const f = fixture('worktree-redirect');
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(JSON.parse(readFileSync(f.calls, 'utf8'))).toEqual([]);
});
