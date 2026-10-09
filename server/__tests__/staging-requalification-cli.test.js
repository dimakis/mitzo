import process from 'node:process';
import { afterEach, expect, it } from 'vitest';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { artifacts } from '../../scripts/lib/staging-files.mjs';
import { fingerprintLegacyDirectory } from '../../scripts/lib/staging-legacy.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const digest = (b) => createHash('sha256').update(b).digest('hex');
function fixture(mode = 'valid') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'requalify-cli-')));
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
  for (const name of ['protocol', 'harness', 'client']) {
    mkdirSync(join(source, 'packages', name), { recursive: true });
    writeFileSync(
      join(source, 'packages', name, 'package.json'),
      JSON.stringify({ name: '@mitzo/' + name, type: 'module', exports: '.' + '/dist/index.js' }),
    );
  }
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'original');
  const old = git(source, 'rev-parse', 'HEAD');
  for (const p of [
    'service/control-lib',
    'settings',
    'workspace',
    'state',
    'home',
    'releases',
    'bin/lib',
    'registry',
  ])
    mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  const release = join(root, 'releases', old.slice(0, 12));
  git(home, 'clone', '-q', source, release);
  git(release, 'remote', 'set-url', 'origin', 'https://github.com/dimakis/mitzo.git');
  for (const p of [
    'dist',
    'frontend/dist',
    'packages/protocol/dist',
    'packages/harness/dist',
    'packages/client/dist',
    'node_modules/@mitzo',
  ])
    mkdirSync(join(release, p), { recursive: true });
  for (const name of ['protocol', 'harness', 'client']) {
    writeFileSync(join(release, 'packages', name, 'dist/index.js'), 'export {};');
    symlinkSync('../../packages/' + name, join(release, 'node_modules/@mitzo', name));
  }
  const json = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  const receipt = {
    label: 'com.mitzo.staging',
    release,
    sourceCommit: old,
    sourceTree: git(release, 'rev-parse', 'HEAD^{tree}'),
    port: 3190,
    bind: '127.0.0.1',
    workspace: join(root, 'workspace'),
    providerProfiles: [],
    openShellEnabled: false,
    compiledArtifacts: artifacts(release),
    dependencyFingerprint: fingerprintLegacyDirectory(release, 'node_modules'),
  };
  const receiptPath = join(root, 'service/release-receipt.json');
  json(receiptPath, receipt);
  const controllerFiles = {};
  for (const name of [
    'staging.mjs',
    'lib/staging-files.mjs',
    'lib/staging-operations.mjs',
    'lib/staging-job.mjs',
    'lib/staging-launcher-template.mjs',
  ]) {
    writeFileSync(join(root, 'bin', name), '// original ' + name, { mode: 0o600 });
    controllerFiles['scripts/' + name] = digest(readFileSync(join(root, 'bin', name)));
  }
  for (const n of [
    'start.mjs',
    'control-lib/staging-files.mjs',
    'control-lib/staging-operations.mjs',
  ])
    writeFileSync(join(root, 'service', n), '// original', { mode: 0o600 });
  json(join(root, 'service/control-tool.json'), { controllerFiles });
  json(join(root, 'settings/account-profiles.json'), []);
  json(join(root, 'settings/operator.json'), {
    AUTH_PASSPHRASE: 'a'.repeat(64),
    AUTH_SECRET: 'b'.repeat(64),
  });
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  const legacy = join(home, 'Library/LaunchAgents/com.mitzo.staging.plist');
  const plist = {
    Label: 'com.mitzo.staging',
    KeepAlive: false,
    WorkingDirectory: release,
    ProgramArguments: [process.execPath, join(root, 'service/start.mjs')],
  };
  json(legacy, plist);
  json(join(root, 'service/com.mitzo.staging.plist'), plist);
  cpSync('scripts', join(source, 'scripts'), { recursive: true });
  const ordinaryCli = join(source, 'scripts/staging.mjs');
  writeFileSync(
    ordinaryCli,
    readFileSync(ordinaryCli, 'utf8').replace("process.platform !== 'darwin'", 'false'),
  );
  if (mode === 'failed-postcheck')
    writeFileSync(
      join(source, 'scripts/lib/staging-launcher-template.mjs'),
      'throw Error("synthetic postcheck failure");',
    );
  const cli = join(source, 'scripts/requalify-staging.mjs');
  writeFileSync(cli, readFileSync(cli, 'utf8').replace("process.platform !== 'darwin'", 'false'));
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'controller');
  git(source, 'remote', 'add', 'origin', 'https://github.com/dimakis/mitzo.git');
  const accepted = git(source, 'rev-parse', 'HEAD');
  const preload = join(home, 'os.mjs');
  writeFileSync(
    preload,
    `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawnSync;os.homedir=()=>${JSON.stringify(home)};cp.spawnSync=(program,args,options)=>{if(program==='git'&&args.includes('ls-remote'))return {status:0,stdout:${JSON.stringify(mode === 'unaccepted' ? 'f'.repeat(40) : accepted)}+' refs/heads/main'};if(program==='launchctl'){if(args[0]!=='print')throw Error('Service control attempted');return {status:0,stdout:'path = '+${JSON.stringify(legacy)}+'\\npid = 42'};}if(program==='/bin/ps')return {status:0,stdout:'original birth'};if(program==='/usr/sbin/lsof'){if(args.includes('cwd'))return {status:0,stdout:'p42\\nn'+${JSON.stringify(release)}};return args.includes('-iTCP:3190')?{status:0,stdout:'42'}:{status:1,stdout:''};}if(program==='/usr/bin/plutil')return {status:0,stdout:${JSON.stringify(JSON.stringify(plist))}};if(program===process.execPath)return original(program,['--import',${JSON.stringify(preload)},...args],options);return original(program,args,options);};syncBuiltinESMExports();`,
  );
  if (mode === 'partial-archive')
    writeFileSync(
      preload,
      readFileSync(preload, 'utf8') +
        `
import fs from 'node:fs';
const originalOpen=fs.openSync,originalWrite=fs.writeFileSync,archiveFds=new Set();let archiveWrites=0;
fs.openSync=(p,...a)=>{const fd=originalOpen(p,...a);if(typeof p==='string'&&p.includes('/service/requalifications/'))archiveFds.add(fd);return fd;};
fs.writeFileSync=(p,...a)=>{if(archiveFds.has(p)&&++archiveWrites===2)throw Error('synthetic partial archive');return originalWrite(p,...a);};
syncBuiltinESMExports();
`,
    );
  const run = (...args) =>
    spawnSync(process.execPath, ['--import', preload, cli, ...args], {
      encoding: 'utf8',
      timeout: 30000,
      env: { PATH: process.env.PATH },
    });
  return { root, old, receiptPath, run };
}
it('the real metadata command archives the original receipt, leaves its process intact and qualifies the new guards', () => {
  const f = fixture(),
    original = readFileSync(f.receiptPath),
    audit = f.run('audit');
  expect(audit.status, audit.stderr).toBe(0);
  const report = JSON.parse(audit.stdout);
  expect(report.coverage).toEqual({ tracked: 3, artifacts: 3 });
  const applied = f.run(
    'apply',
    '--expected-current',
    f.old,
    '--expected-audit',
    report.auditSha256,
  );
  expect(applied.status, applied.stderr).toBe(0);
  const result = JSON.parse(applied.stdout);
  expect(result.serviceControl).toBe(false);
  expect(result.modelCalls).toBe(0);
  expect(readFileSync(join(result.archive, 'original-receipt.json'))).toEqual(original);
  expect(JSON.parse(readFileSync(f.receiptPath)).dependencyFingerprint).toBe(
    report.closureFingerprint,
  );
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(f.root, 'service/legacy-qualification.json'))).original.pid,
  ).toBe(42);
});
it('a changed original receipt refuses before a lock, archive or controller write', () => {
  const f = fixture(),
    report = JSON.parse(f.run('audit').stdout),
    r = JSON.parse(readFileSync(f.receiptPath));
  r.sourceTree = 'a'.repeat(40);
  writeFileSync(f.receiptPath, JSON.stringify(r));
  expect(
    f.run('apply', '--expected-current', f.old, '--expected-audit', report.auditSha256).status,
  ).not.toBe(0);
  expect(existsSync(join(f.root, 'service/requalifications'))).toBe(false);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(false);
});
it('retained registry ownership or an unused start permit refuses even read-only qualification', () => {
  for (const name of ['registry/retained.json', 'service/launch-permit.json']) {
    const f = fixture();
    writeFileSync(join(f.root, name), 'retained', { mode: 0o600 });
    expect(f.run('audit').status).not.toBe(0);
    expect(existsSync(join(f.root, 'service/requalifications'))).toBe(false);
    expect(readFileSync(join(f.root, name), 'utf8')).toBe('retained');
  }
});
it('an unaccepted source cannot apply a valid independently audited original', () => {
  const f = fixture('unaccepted'),
    report = JSON.parse(f.run('audit').stdout);
  const result = f.run(
    'apply',
    '--expected-current',
    f.old,
    '--expected-audit',
    report.auditSha256,
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('accepted main');
  expect(existsSync(join(f.root, 'service/legacy-qualification.json'))).toBe(false);
});
it('a failed migrated guard keeps the archive and lock instead of restarting or restoring old evidence', () => {
  const f = fixture('failed-postcheck'),
    report = JSON.parse(f.run('audit').stdout);
  expect(
    f.run('apply', '--expected-current', f.old, '--expected-audit', report.auditSha256).status,
  ).not.toBe(0);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  expect(existsSync(join(f.root, 'service/legacy-qualification.json'))).toBe(true);
  expect(readFileSync(join(f.root, 'service/deployment-audit.jsonl'), 'utf8')).toContain(
    'uncertain',
  );
});
it('an actual partial archive write retains the lock and original receipt before any controller migration', () => {
  const f = fixture('partial-archive'),
    original = readFileSync(f.receiptPath);
  const report = JSON.parse(f.run('audit').stdout);
  const result = f.run(
    'apply',
    '--expected-current',
    f.old,
    '--expected-audit',
    report.auditSha256,
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('synthetic partial archive');
  expect(readFileSync(f.receiptPath)).toEqual(original);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  expect(existsSync(join(f.root, 'service/legacy-qualification.json'))).toBe(false);
  expect(readFileSync(join(f.root, 'service/deployment-audit.jsonl'), 'utf8')).toContain(
    'uncertain',
  );
});
