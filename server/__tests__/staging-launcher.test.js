import process from 'node:process';
import { afterEach, expect, it } from 'vitest';
import {
  cpSync,
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
import { spawnSync } from 'node:child_process';
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
    `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(home)};cp.spawnSync=(program,args)=>{if(program==='git'){if(args.includes('ls-files'))return {status:0,stdout:${JSON.stringify(mode === 'assume-unchanged' ? 'h tracked.ts' : mode === 'skip-worktree' ? 'S tracked.ts' : 'H tracked.ts')}};if(args.includes('--show-toplevel'))return {status:0,stdout:${JSON.stringify(mode === 'worktree-redirect' ? home : release)}};if(args.includes('rev-parse'))return {status:0,stdout:args.includes('HEAD^{tree}')?${JSON.stringify(tree)}:${JSON.stringify(source)}};if(args.includes('remote'))return {status:0,stdout:'https://github.com/dimakis/mitzo.git'};return {status:0,stdout:''};}if(program===process.execPath)return {status:0,stdout:${JSON.stringify(JSON.stringify(paths))}};throw Error('Unmocked execution');};syncBuiltinESMExports();`,
  );
  const run = () =>
    spawnSync(process.execPath, ['--import', prelude, launcher, '--check'], {
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: process.env.PATH },
    });
  return { home, root, release, receipt, save, run };
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
