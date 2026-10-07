import { describe, expect, it } from 'vitest';
import { StagingLaunchSchema } from '../symposium-staging-launch-schema.js';
import { ownedCustodianEnvironment } from '../symposium-staging-environment.js';
import {
  isOwnedSymposiumProxyUrl,
  isOwnedSymposiumSupervisorNetwork,
} from '../symposium-owned-network-config.js';
import { CriterionCheckDefinitionSchema } from '../symposium-criterion-definition.js';
import type { OwnedReleasePlan } from '../symposium-owned-release.js';

const registration = {
  registryDirectory: '/private/stage/registry',
  capacity: 1,
  ownerChat: 'owner',
  purpose: 'review',
  retentionReason: 'custody',
  reviewAfter: 1,
};
const plan = {
  appHome: '/private/stage/home',
  configPath: '/private/stage/settings/host.json',
  repositoryPath: '/private/stage/workspace',
  planDirectory: '/private/stage/service',
} as OwnedReleasePlan;
const auth = {
  AUTH_PASSPHRASE: 'a'.repeat(32),
  AUTH_SECRET: 'b'.repeat(64),
  PORT: '3190',
  MITZO_BIND_HOST: '127.0.0.1',
};
describe('pure staging static contracts', () => {
  it('preserves strict registration identity and capacity without native launch imports', () => {
    expect(StagingLaunchSchema.parse(registration)).toEqual(registration);
    for (const patch of [
      { capacity: 0 },
      { capacity: 21 },
      { registryDirectory: 'relative' },
      { unknown: true },
    ])
      expect(StagingLaunchSchema.safeParse({ ...registration, ...patch }).success).toBe(false);
  });
  it('constructs an isolated app environment while rejecting ambient executable hooks', () => {
    const result = ownedCustodianEnvironment(plan, {
      ...auth,
      HOME: '/production',
      GH_TOKEN: 'excluded',
    });
    expect(result.HOME).toBe(plan.appHome);
    expect(result.MITZO_ACCOUNT_PROFILES_FILE).toBe(plan.planDirectory + '/empty-accounts.json');
    expect(result.GH_TOKEN).toBeUndefined();
    expect(result.DOTENV_CONFIG_PATH).toBe('/dev/null');
    for (const patch of [
      { NODE_OPTIONS: '--import /production/hook' },
      { NODE_PATH: '/production' },
      { DOTENV_CONFIG_PATH: '/production/.env' },
      { AUTH_SECRET: 'short' },
      { MITZO_BIND_HOST: '0.0.0.0' },
    ])
      expect(() => ownedCustodianEnvironment(plan, { ...auth, ...patch })).toThrow();
  });
  it('admits only a bounded credential-free explicit proxy and the owned named bridge', () => {
    expect(isOwnedSymposiumProxyUrl('http://proxy.example:3128')).toBe(true);
    expect(isOwnedSymposiumProxyUrl('https://[::1]:4443')).toBe(true);
    for (const url of [
      'http://user:secret@proxy.example:3128',
      'http://proxy.example:0',
      'http://proxy.example:65536',
      'http://proxy.example:3128/path',
      'http://proxy.example:3128?bypass=true',
    ])
      expect(isOwnedSymposiumProxyUrl(url)).toBe(false);
    expect(isOwnedSymposiumSupervisorNetwork('staging-owned', 'staging-owned')).toBe(true);
    for (const name of ['host', 'none', 'bridge', 'private', 'slirp4netns', 'pasta', 'another'])
      expect(isOwnedSymposiumSupervisorNetwork(name, 'staging-owned')).toBe(false);
  });
  it('preserves bounded criterion definitions without importing execution or protocol receipts', () => {
    const definition = {
      id: 'criterion',
      criterion: 'Return the selected outcome',
      version: 1,
      kind: 'python-json-cases',
      path: 'checks/outcome.py',
      cases: [{ id: 'one', input: { value: 1 }, expected: { value: 2 } }],
    };
    expect(CriterionCheckDefinitionSchema.parse(definition)).toEqual(definition);
    for (const patch of [
      { path: '../production.py' },
      { cases: [...definition.cases, ...definition.cases] },
      { cases: [{ id: 'one', input: { value: Infinity }, expected: null }] },
      { cases: [{ id: 'one', input: 'x'.repeat(4097), expected: null }] },
      { cases: [] },
      { unknown: true },
    ])
      expect(CriterionCheckDefinitionSchema.safeParse({ ...definition, ...patch }).success).toBe(
        false,
      );
    expect(
      CriterionCheckDefinitionSchema.safeParse({
        id: 'sha',
        criterion: 'Exact file',
        version: 1,
        kind: 'file-sha256',
        path: 'result.json',
        expectedSha256: 'c'.repeat(64),
      }).success,
    ).toBe(true);
  });
});

it('preserves exact staging pins when the feature native selector implements those reviewed variants', async () => {
  const staging = await import('../symposium-staging-runtime-contract.js');
  const native = await import('../symposium-owned-runtime-contract.js');
  expect(
    staging.reviewedStagingOwnedRuntime(native.REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.image),
  ).toBe(native.REVIEWED_SYMPOSIUM_OWNED_RUNTIME);
  for (const selected of [
    staging.REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME,
    staging.REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME,
    staging.REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME,
    staging.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME,
  ]) {
    expect(staging.reviewedStagingOwnedRuntime(selected.build.image)).toBe(selected);
    expect(native.reviewedSymposiumOwnedRuntime(selected.build.image)).toEqual(selected);
  }
  expect(() => staging.reviewedStagingOwnedRuntime('sha256:' + '0'.repeat(64))).toThrow(
    'not reviewed',
  );
});
