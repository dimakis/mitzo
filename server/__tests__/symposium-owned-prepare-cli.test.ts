import { afterEach, expect, it } from 'vitest';
import {
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
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture(canonical = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-prepare-cli-')));
  roots.push(root);
  for (const p of ['scripts', 'dist', 'plan']) mkdirSync(join(root, p));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const n of ['prepare-owned-custodian-release', 'start-owned-custodian'])
    cpSync('scripts/' + n + '.mjs', join(root, 'scripts', n + '.mjs'));
  writeFileSync(
    join(root, 'dist/symposium-staging-identity.js'),
    'export const requiresCanonicalStaging=()=>true;',
  );
  writeFileSync(
    join(root, 'dist/symposium-staging-service.js'),
    `export const requiresCanonicalStaging=()=>${canonical};export const canonicalStagingRoot=()=>"/synthetic";export const assertCanonicalStagingService=()=>{};`,
  );
  writeFileSync(
    join(root, 'dist/symposium-owned-release.js'),
    `import {readFileSync,writeFileSync} from 'node:fs';export const prepareOwnedRelease=i=>({...i,mode:'owned',entry:'dist/symposium-custodian-main.js'});export const renderOwnedPlist=()=>'<generic/>';export const readOwnedReleasePlan=p=>JSON.parse(readFileSync(p));export const verifyOwnedRelease=()=>{writeFileSync(${JSON.stringify(join(root, 'called'))},'verification');throw Error('canonical plan reached generic verification');};export const claimOwnedLaunch=()=>{};`,
  );
  const run = (canonical: boolean) =>
    spawnSync(
      process.execPath,
      [
        join(root, 'scripts/prepare-owned-custodian-release.mjs'),
        '--owned-custodian',
        join(root, 'config'),
        join(root, 'repo'),
        join(root, 'plan'),
        ...(canonical ? ['--canonical', '--accepted-main-baseline', 'e'.repeat(40)] : []),
      ],
      { encoding: 'utf8' },
    );
  return { root, run };
}
it('canonical owned preparation requires explicit mode and baseline and emits no generic plist', () => {
  const f = fixture();
  expect(f.run(false).status).not.toBe(0);
  const result = f.run(true);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(f.root, 'plan/com.mitzo.owned-custodian.plist'))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(f.root, 'plan/owned-release.json'), 'utf8')).acceptedMainBaseline,
  ).toBe('e'.repeat(40));
});
it('generic native launcher refuses canonical plan before verification or launch intent', () => {
  const f = fixture();
  writeFileSync(
    join(f.root, 'plan/owned-release.json'),
    JSON.stringify({
      releaseRoot: f.root,
      planDirectory: join(f.root, 'plan'),
      entry: 'dist/symposium-custodian-main.js',
    }),
  );
  writeFileSync(
    join(f.root, 'fixture.mjs'),
    'process.execve=()=>{throw Error("OS execution forbidden")};',
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      join(f.root, 'fixture.mjs'),
      join(f.root, 'scripts/start-owned-custodian.mjs'),
      join(f.root, 'plan/owned-release.json'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTH_PASSPHRASE: 'a'.repeat(32),
        AUTH_SECRET: 'b'.repeat(64),
        PORT: '3190',
        MITZO_BIND_HOST: '127.0.0.1',
        NODE_OPTIONS: '',
        NODE_PATH: '',
      },
    },
  );
  expect(result.status).not.toBe(0);
  expect(existsSync(join(f.root, 'called'))).toBe(false);
});

it('ordinary owned preparation keeps its original generic plist without baseline flags', () => {
  const f = fixture(false);
  const result = f.run(false);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.root, 'plan/com.mitzo.owned-custodian.plist'), 'utf8')).toBe(
    '<generic/>',
  );
});
