import process from 'node:process';
import { afterEach, expect, it } from 'vitest';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { artifacts, fingerprintDirectory } from '../../scripts/lib/staging-files.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
function fixture(mode = 'valid') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stage-prepare-deps-')));
  roots.push(home);
  const root = join(home, '.local/share/mitzo-staging'),
    source = join(home, 'source');
  mkdirSync(source);
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  git(source, 'init', '-qb', 'main');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(source, '.gitignore'), 'node_modules\n**/dist\n');
  writeFileSync(join(source, 'package-lock.json'), 'original-lock');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'original');
  const old = git(source, 'rev-parse', 'HEAD');
  for (const p of ['service', 'settings', 'workspace', 'state', 'home', 'releases'])
    mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  const oldRelease = join(root, 'releases', old.slice(0, 12));
  git(home, 'clone', '-q', source, oldRelease);
  git(oldRelease, 'remote', 'set-url', 'origin', 'https://github.com/dimakis/mitzo.git');
  for (const p of [
    'dist',
    'frontend/dist',
    'packages/protocol/dist',
    'packages/harness/dist',
    'packages/client/dist',
    'node_modules',
  ])
    mkdirSync(join(oldRelease, p), { recursive: true });
  writeFileSync(join(oldRelease, 'dist/original.js'), 'retained');
  writeFileSync(join(oldRelease, 'node_modules/dependency.js'), 'old dependency');
  const receipt = {
    label: 'com.mitzo.staging',
    port: 3190,
    bind: '127.0.0.1',
    workspace: join(root, 'workspace'),
    release: oldRelease,
    sourceCommit: old,
    sourceTree: git(oldRelease, 'rev-parse', 'HEAD^{tree}'),
    compiledArtifacts: artifacts(oldRelease),
    dependencyFingerprint: fingerprintDirectory(oldRelease, 'node_modules'),
  };
  const receiptPath = join(root, 'service/release-receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  cpSync('scripts', join(source, 'scripts'), { recursive: true });
  const cli = join(source, 'scripts/staging.mjs');
  writeFileSync(cli, readFileSync(cli, 'utf8').replace("process.platform !== 'darwin'", 'false'));
  writeFileSync(join(source, 'package-lock.json'), 'new-accepted-lock');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'accepted');
  git(source, 'remote', 'add', 'origin', 'https://github.com/dimakis/mitzo.git');
  const target = git(source, 'rev-parse', 'HEAD');
  mkdirSync(join(source, 'node_modules'));
  writeFileSync(join(source, 'node_modules/dependency.js'), 'new audited dependency');
  const fingerprint = fingerprintDirectory(source, 'node_modules');
  const preload = join(home, 'os.mjs');
  writeFileSync(
    preload,
    `import cp from 'node:child_process';import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';import path from 'node:path';const original=cp.spawnSync;os.homedir=()=>${JSON.stringify(home)};cp.spawnSync=(program,args,options)=>{if(program==='git'&&args.includes('ls-remote'))return {status:0,stdout:${JSON.stringify(target)}+' refs/heads/main'};if(program==='git'&&args.includes('clone')){const p=args.at(-1);const clone=original('git',['clone','--no-checkout',${JSON.stringify(source)},p],options);if(clone.status===0)original('git',['remote','set-url','origin','https://github.com/dimakis/mitzo.git'],{...options,cwd:p});return clone;}if(program==='npm'){for(const name of ['dist','frontend/dist','packages/protocol/dist','packages/harness/dist','packages/client/dist']){fs.mkdirSync(path.join(options.cwd,name),{recursive:true});fs.writeFileSync(path.join(options.cwd,name,'compiled.js'),'independently rebuilt fixture');}if(${JSON.stringify(mode)}==='drift')fs.writeFileSync(${JSON.stringify(join(source, 'node_modules/dependency.js'))},'changed during build');return {status:0,stdout:'synthetic build'};}if(program==='launchctl'||program==='/bin/launchctl')throw Error('Service control attempted');return original(program,args,options);};syncBuiltinESMExports();`,
  );
  const run = (supplied = true) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        join(source, 'scripts/staging.mjs'),
        'prepare',
        '--commit',
        target,
        ...(supplied
          ? ['--dependency-source', source, '--expected-dependency-fingerprint', fingerprint]
          : []),
      ],
      { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } },
    );
  return { root, run, target, receiptPath };
}
it('actual preparation rebuilds a changed-lock candidate from pinned provisioned dependencies without changing the live receipt', () => {
  const f = fixture(),
    prior = readFileSync(f.receiptPath),
    result = f.run();
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.started).toBe(false);
  expect(output.productionActions).toEqual([]);
  expect(readFileSync(f.receiptPath)).toEqual(prior);
  expect(readFileSync(join(output.prepared, 'node_modules/dependency.js'), 'utf8')).toBe(
    'new audited dependency',
  );
  expect(
    Object.keys(
      JSON.parse(readFileSync(join(output.prepared, 'staging-release.json'))).compiledArtifacts,
    ),
  ).toHaveLength(5);
});
it('a changed lock without explicit provisioning never copies old dependencies or promotes a candidate', () => {
  const f = fixture(),
    prior = readFileSync(f.receiptPath),
    result = f.run(false);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Dependency lock changed');
  expect(readFileSync(f.receiptPath)).toEqual(prior);
  expect(existsSync(join(f.root, 'releases', f.target.slice(0, 12)))).toBe(false);
});
it('dependency drift during the build preserves the live receipt and refuses promotion', () => {
  const f = fixture('drift'),
    prior = readFileSync(f.receiptPath),
    result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Dependency source changed');
  expect(readFileSync(f.receiptPath)).toEqual(prior);
  expect(existsSync(join(f.root, 'releases', f.target.slice(0, 12)))).toBe(false);
});
