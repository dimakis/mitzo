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
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-launch-')));
  roots.push(root);
  for (const name of ['scripts', 'dist', 'plan', 'repo'])
    mkdirSync(join(root, name), { mode: 0o700 });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  cpSync('scripts/start-owned-custodian.mjs', join(root, 'scripts/start-owned-custodian.mjs'));
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
    `console.log(JSON.stringify({entry:'custodian',repo:process.env.REPO_PATH,config:process.env.MITZO_SYMPOSIUM_OWNED_HOST_CONFIG,legacy:process.env.MITZO_OPENSHELL_ENABLED,accounts:process.env.MITZO_ACCOUNT_PROFILES_FILE}));`,
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
    env: { PATH: process.env.PATH, MITZO_OPENSHELL_ENABLED: '1', REPO_PATH: '/wrong' },
  });
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual({
    entry: 'custodian',
    repo: f.plan.repositoryPath,
    config: f.plan.configPath,
    legacy: '0',
    accounts: join(f.plan.planDirectory, 'empty-accounts.json'),
  });
  expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).not.toBe(0);
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
    { encoding: 'utf8' },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain('/wrong');
  expect(() => readFileSync(join(f.root, 'plan/launch.intent'))).toThrow();
});
