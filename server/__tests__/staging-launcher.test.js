import process from 'node:process';
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { artifacts, fingerprintDirectory } from '../../scripts/lib/staging-files.mjs';
const homes = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));
function fixture(mode = 'valid') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'staging-launcher-')));
  homes.push(home);
  const root = join(home, '.local/share/mitzo-staging');
  const source = 'a'.repeat(40),
    tree = 'b'.repeat(40);
  const release = join(root, 'releases', source.slice(0, 12));
  for (const name of ['service/control-lib', 'settings', 'workspace', 'home'])
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  const launcher = join(root, 'service/start.mjs');
  cpSync('scripts/lib/staging-launcher-template.mjs', launcher);
  for (const name of ['staging-files.mjs', 'staging-operations.mjs'])
    cpSync(join('scripts/lib', name), join(root, 'service/control-lib', name));
  const compiled = [
    'dist',
    'frontend/dist',
    'packages/protocol/dist',
    'packages/harness/dist',
    'packages/client/dist',
  ];
  for (const name of compiled) {
    mkdirSync(join(release, name), { recursive: true, mode: 0o700 });
    writeFileSync(join(release, name, 'index.js'), '// public compiled fixture');
  }
  mkdirSync(join(release, 'node_modules'), { mode: 0o700 });
  const receipt = {
    release,
    sourceCommit: source,
    sourceTree: tree,
    port: 3190,
    bind: '127.0.0.1',
    label: 'com.mitzo.staging',
    workspace: join(root, 'workspace'),
    compiledArtifacts: artifacts(release),
    dependencyFingerprint: fingerprintDirectory(release, 'node_modules'),
  };
  const receiptPath = join(root, 'service/release-receipt.json');
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  save();
  writeFileSync(
    join(root, 'settings/operator.json'),
    JSON.stringify({ AUTH_PASSPHRASE: 'x'.repeat(32), AUTH_SECRET: 'y'.repeat(64) }),
    { mode: 0o600 },
  );
  writeFileSync(join(root, 'settings/account-profiles.json'), '[]', { mode: 0o600 });
  const prelude = join(home, 'fixture.mjs');
  const paths = ['protocol', 'harness', 'client'].map((name) =>
    join(release, 'packages', name, 'dist/index.js'),
  );
  writeFileSync(
    prelude,
    `import fs from 'node:fs';import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(home)};let now=100000;Date.now=()=>now;process.execve=()=>console.log(JSON.stringify({executed:true}));let changed=false;cp.spawnSync=(program,args)=>{if(program==='git'){if(!changed){changed=true;if(${JSON.stringify(mode)}==='delay-qualification')now+=16000;if(${JSON.stringify(mode)}==='guard-drift')fs.writeFileSync(${JSON.stringify(join(root, 'service/deployment.lock'))},JSON.stringify({id:'original',target:${JSON.stringify(source)},phase:'changed'}));if(${JSON.stringify(mode)}==='receipt-drift')fs.writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify({...${JSON.stringify(receipt)},dependencyFingerprint:'changed'}));if(${JSON.stringify(mode)}==='guard-replaced'){const path=${JSON.stringify(join(root, 'service/deployment.lock'))};const bytes=fs.readFileSync(path);fs.unlinkSync(path);fs.writeFileSync(path,bytes,{mode:0o600});}if(${JSON.stringify(mode)}==='guard-removed')fs.unlinkSync(${JSON.stringify(join(root, 'service/deployment.lock'))});if(${JSON.stringify(mode)}==='guard-appears')fs.writeFileSync(${JSON.stringify(join(root, 'service/deployment.lock'))},JSON.stringify({id:'new',target:${JSON.stringify(source)}}),{mode:0o600});}if(args.includes('ls-files'))return {status:0,stdout:${JSON.stringify(mode === 'assume-unchanged' ? 'h tracked.ts' : mode === 'skip-worktree' ? 'S tracked.ts' : 'H tracked.ts')}};if(args.includes('--show-toplevel'))return {status:0,stdout:${JSON.stringify(mode === 'worktree-redirect' ? home : release)}};if(args.includes('rev-parse'))return {status:0,stdout:args.includes('HEAD^{tree}')?${JSON.stringify(tree)}:${JSON.stringify(source)}};if(args.includes('remote'))return {status:0,stdout:'https://github.com/dimakis/mitzo.git'};return {status:0,stdout:''};}if(program===process.execPath)return {status:0,stdout:${JSON.stringify(JSON.stringify(paths))}};throw Error('Unmocked execution');};syncBuiltinESMExports();`,
  );
  const run = (check = true) =>
    spawnSync(process.execPath, ['--import', prelude, launcher, ...(check ? ['--check'] : [])], {
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: process.env.PATH },
    });
  return {
    home,
    root,
    release,
    receipt,
    save,
    run,
    launchAsync: () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', prelude, launcher], {
          env: { PATH: process.env.PATH },
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', (error) => resolve({ status: null, stderr: String(error), stdout }));
        child.on('close', (status) => resolve({ status, stderr, stdout }));
      }),
    permit: () => {
      writeFileSync(
        join(root, 'service/deployment.lock'),
        JSON.stringify({ id: 'original', target: source }),
        { mode: 0o600 },
      );
      writeFileSync(
        join(root, 'service/launch-permit.json'),
        JSON.stringify({ id: 'original', target: source, expiresAt: 115000 }),
        { mode: 0o600 },
      );
    },
  };
}
it('checks the actual startup template against a complete pinned compiled inventory', () => {
  const f = fixture();
  f.receipt.compiledArtifacts = Object.fromEntries(
    Object.entries(f.receipt.compiledArtifacts).reverse(),
  );
  f.save();
  const r = f.run();
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({
    releaseGuard: 'passed',
    compiledArtifacts: 5,
    modelCalls: 0,
  });
});
it.each([
  'dist',
  'frontend/dist',
  'packages/protocol/dist',
  'packages/harness/dist',
  'packages/client/dist',
])('refuses an unlisted compiled file under %s before startup', (directory) => {
  const f = fixture();
  writeFileSync(join(f.release, directory, 'unlisted.js'), '// not in accepted build');
  expect(f.run().status).not.toBe(0);
});
it('refuses a modified or missing accepted compiled artifact', () => {
  const f = fixture();
  writeFileSync(join(f.release, 'dist/index.js'), '// changed');
  expect(f.run().status).not.toBe(0);
  unlinkSync(join(f.release, 'dist/index.js'));
  expect(f.run().status).not.toBe(0);
});
it('refuses an empty compiled receipt despite package resolution succeeding', () => {
  const f = fixture();
  f.receipt.compiledArtifacts = {};
  f.save();
  expect(f.run().status).not.toBe(0);
});
it('refuses a new compiled symlink instead of following its target', () => {
  const f = fixture();
  const outside = join(f.home, 'outside.js');
  writeFileSync(outside, '// retained outside fixture');
  symlinkSync(outside, join(f.release, 'dist/unlisted.js'));
  expect(f.run().status).not.toBe(0);
  expect(readFileSync(outside, 'utf8')).toBe('// retained outside fixture');
});

it('actual startup refuses changed contained dependency payload despite unchanged link and receipt', () => {
  const f = fixture();
  mkdirSync(join(f.release, 'vendor'));
  writeFileSync(join(f.release, 'vendor/tool.js'), 'one');
  symlinkSync('../vendor', join(f.release, 'node_modules/vendor'));
  f.receipt.dependencyFingerprint = fingerprintDirectory(f.release, 'node_modules');
  f.save();
  const valid = f.run();
  expect(valid.status, valid.stderr).toBe(0);
  writeFileSync(join(f.release, 'vendor/tool.js'), 'two');
  const changed = f.run();
  expect(changed.status, changed.stderr).not.toBe(0);
  expect(changed.stderr).toContain('dependency drift');
});

it.each(['assume-unchanged', 'skip-worktree'])(
  'actual startup refuses hidden tracked source flags: %s',
  (mode) => {
    const f = fixture(mode);
    expect(f.run().status).not.toBe(0);
  },
);

it('actual startup refuses a redirected Git source worktree', () => {
  const f = fixture('worktree-redirect');
  expect(f.run().status).not.toBe(0);
});

it('admits the actual launcher once before integrity qualification exceeds the 15-second entry deadline', () => {
  const f = fixture('delay-qualification');
  f.permit();
  const result = f.run(false);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ executed: true });
  expect(existsSync(join(f.root, 'service/launch-permit.json'))).toBe(false);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  expect(f.run(false).status).not.toBe(0);
});
it('read-only check never consumes a permit even when qualification exceeds its entry deadline', () => {
  const f = fixture('delay-qualification');
  f.permit();
  const path = join(f.root, 'service/launch-permit.json'),
    bytes = readFileSync(path);
  expect(f.run().status).toBe(0);
  expect(readFileSync(path)).toEqual(bytes);
});
it.each(['guard-drift', 'receipt-drift'])(
  'refuses %s after entry admission instead of executing under changed custody',
  (mode) => {
    const f = fixture(mode);
    f.permit();
    const result = f.run(false);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout).not.toContain('executed');
    expect(existsSync(join(f.root, 'service/launch-permit.json'))).toBe(false);
    expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  },
);
it('failed integrity after entry burns the permit and preserves the deployment guard', () => {
  const f = fixture();
  f.permit();
  writeFileSync(join(f.release, 'dist/index.js'), '// changed');
  expect(f.run(false).status).not.toBe(0);
  expect(existsSync(join(f.root, 'service/launch-permit.json'))).toBe(false);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
});

it('only one concurrent actual launcher can consume the same permit', async () => {
  const f = fixture();
  f.permit();
  const results = await Promise.all([f.launchAsync(), f.launchAsync()]);
  expect(results.filter((result) => result.status === 0)).toHaveLength(1);
  expect(results.filter((result) => result.stdout.includes('executed'))).toHaveLength(1);
  expect(existsSync(join(f.root, 'service/launch-permit.json'))).toBe(false);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
});
it.each([99999, 115001])(
  'refuses expired or oversized entry windows (%s) without consuming custody evidence',
  (expiresAt) => {
    const f = fixture();
    f.permit();
    writeFileSync(
      join(f.root, 'service/launch-permit.json'),
      JSON.stringify({ id: 'original', target: f.receipt.sourceCommit, expiresAt }),
      { mode: 0o600 },
    );
    expect(f.run(false).status).not.toBe(0);
    expect(existsSync(join(f.root, 'service/launch-permit.json'))).toBe(true);
  },
);

it.each(['guard-replaced', 'guard-removed'])(
  'refuses changed admitted guard identity (%s)',
  (mode) => {
    const f = fixture(mode);
    f.permit();
    const result = f.run(false);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('executed');
    expect(existsSync(join(f.root, 'service/launch-permit.json'))).toBe(false);
  },
);
it('requires an entry-unlocked launch to remain unlocked through qualification', () => {
  const f = fixture('guard-appears');
  const result = f.run(false);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('executed');
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
});
