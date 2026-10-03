import { expect, it } from 'vitest';
import { ownedCustodianEnvironment } from '../symposium-custodian-launch.js';
import type { OwnedReleasePlan } from '../symposium-owned-release.js';
const plan = {
  appHome: '/private/home',
  repositoryPath: '/private/repo',
  configPath: '/private/host.json',
  planDirectory: '/private/plan',
} as OwnedReleasePlan;
const source = {
  AUTH_PASSPHRASE: 'p'.repeat(32),
  AUTH_SECRET: 's'.repeat(64),
  PORT: '18880',
  MITZO_BIND_HOST: '127.0.0.1',
};
it('uses the owned isolated topology and omits ambient credentials and loader injection', () => {
  const env = ownedCustodianEnvironment(plan, {
    ...source,
    PROVIDER_TOKEN: 'never-forward',
    MITZO_SYMPOSIUM_CUSTODIAN_OWNER: '1',
  });
  expect(env).toMatchObject({
    HOME: plan.appHome,
    REPO_PATH: plan.repositoryPath,
    MITZO_SYMPOSIUM_OWNED_HOST_CONFIG: plan.configPath,
    DOTENV_CONFIG_PATH: '/dev/null',
    MITZO_OPENSHELL_ENABLED: '0',
    MITZO_WORKTREE_CLEANUP_POLICY: 'report',
  });
  expect(env.PROVIDER_TOKEN).toBeUndefined();
  expect(env.MITZO_SYMPOSIUM_CUSTODIAN_OWNER).toBeUndefined();
  expect(() =>
    ownedCustodianEnvironment(plan, { ...source, NODE_OPTIONS: '--import=other' }),
  ).toThrow();
  expect(() =>
    ownedCustodianEnvironment(plan, { ...source, MITZO_BIND_HOST: '0.0.0.0' }),
  ).toThrow();
  expect(() => ownedCustodianEnvironment(plan, { ...source, AUTH_SECRET: 'short' })).toThrow();
});
