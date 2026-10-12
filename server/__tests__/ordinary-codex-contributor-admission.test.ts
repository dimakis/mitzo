import { describe, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import {
  assertOrdinaryCodexContributorAccount,
  OrdinaryContributorModeError,
} from '../ordinary-codex-contributor-admission.js';

const unsupported = 'Selected account does not support ordinary contributor turns';
const models = [{ id: 'offline-model', label: 'Offline' }];
const api = {
  id: 'api',
  label: 'Offline API',
  provider: 'openai' as const,
  credentialRef: { provider: 'offline', service: 'unused', account: 'api' },
  sandboxProvider: 'offline-api',
  models,
};
const codex = {
  id: 'codex',
  label: 'Offline Codex',
  provider: 'openai-codex' as const,
  credentialRef: '/offline/unused-auth.json',
  email: 'offline@example.test',
  planType: 'plus',
  models,
};
function environment(): NodeJS.ProcessEnv {
  return {
    MITZO_OPENSHELL_ENABLED: '1',
    MITZO_OPENSHELL_IMAGE: 'offline-image',
    MITZO_OPENSHELL_POLICY: '/offline/policy.yaml',
    MITZO_OPENSHELL_SEED: '/offline/seed',
  };
}

describe('ordinary Codex contributor admission', () => {
  it.each(['agent', 'auto', undefined] as const)(
    'admits bound API in %s mode without credentials',
    (mode) => {
      const accounts = new AccountProfiles([api]);
      const credential = vi.spyOn(accounts, 'apiCredential').mockImplementation(() => {
        throw new Error('Credentials must not be resolved');
      });
      expect(() =>
        assertOrdinaryCodexContributorAccount(
          accounts,
          accounts.resolve('api', 'offline-model'),
          mode,
          environment(),
        ),
      ).not.toThrow();
      expect(credential).not.toHaveBeenCalled();
    },
  );

  it('rejects API Ask with a static mode error', () => {
    const accounts = new AccountProfiles([api]);
    const check = () =>
      assertOrdinaryCodexContributorAccount(
        accounts,
        accounts.resolve('api', 'offline-model'),
        'ask',
        environment(),
      );
    expect(check).toThrow(OrdinaryContributorModeError);
    expect(check).toThrow('OpenShell contributors require Agent or Auto mode.');
  });

  it.each([
    ['no runtime', {}],
    ['disabled runtime', { MITZO_OPENSHELL_ENABLED: '0' }],
    ['named retained sandbox', { MITZO_OPENSHELL_SANDBOX_NAME: 'retained' }],
    ['API disabled', { MITZO_OPENSHELL_OPENAI_API_ENABLED: '0' }],
    ['incomplete runtime', { MITZO_OPENSHELL_POLICY: undefined }],
    ['malformed runtime', { MITZO_OPENSHELL_AGENT_CONTEXT_PRESETS: '{secret malformed config' }],
    [
      'private missing manifest',
      { MITZO_OPENSHELL_STACK_MANIFEST: '/offline/private-secret-missing.json' },
    ],
  ] as const)('refuses %s with a safe static error', (kind, changes) => {
    const accounts = new AccountProfiles([api]);
    const env = kind === 'no runtime' ? {} : { ...environment(), ...changes };
    expect(() =>
      assertOrdinaryCodexContributorAccount(
        accounts,
        accounts.resolve('api', 'offline-model'),
        'agent',
        env,
      ),
    ).toThrow(unsupported);
  });

  it('rejects an API profile without a sandbox binding', () => {
    const accounts = new AccountProfiles([{ ...api, sandboxProvider: undefined }]);
    expect(() =>
      assertOrdinaryCodexContributorAccount(
        accounts,
        accounts.resolve('api', 'offline-model'),
        'agent',
        environment(),
      ),
    ).toThrow(unsupported);
  });

  it('revalidates removed accounts and changed routing', () => {
    const binding = new AccountProfiles([api]).resolve('api', 'offline-model');
    for (const accounts of [
      new AccountProfiles([]),
      new AccountProfiles([{ ...api, sandboxProvider: 'changed' }]),
    ]) {
      expect(() =>
        assertOrdinaryCodexContributorAccount(accounts, binding, 'agent', environment()),
      ).toThrow(unsupported);
    }
  });

  it('rechecks mutable host configuration on each admission', () => {
    const accounts = new AccountProfiles([api]);
    const binding = accounts.resolve('api', 'offline-model');
    const env = environment();
    assertOrdinaryCodexContributorAccount(accounts, binding, 'agent', env);
    env.MITZO_OPENSHELL_OPENAI_API_ENABLED = '0';
    expect(() => assertOrdinaryCodexContributorAccount(accounts, binding, 'agent', env)).toThrow(
      unsupported,
    );
  });

  it('preserves compatibility Codex eligibility, including Ask without OpenShell', () => {
    const accounts = new AccountProfiles([codex], { codexEnabled: true });
    expect(() =>
      assertOrdinaryCodexContributorAccount(
        accounts,
        accounts.resolve('codex', 'offline-model'),
        'ask',
        {},
      ),
    ).not.toThrow();
  });

  it('rejects native ChatGPT Codex', () => {
    const accounts = new AccountProfiles(
      [
        {
          ...codex,
          credentialRef: undefined,
          nativeAuth: 'sandbox-chatgpt',
          sandboxProvider: 'offline-native',
          sandboxProviderType: 'codex',
          sandboxProviderId: 'offline-id',
        },
      ],
      { codexEnabled: true },
    );
    expect(() =>
      assertOrdinaryCodexContributorAccount(
        accounts,
        accounts.resolve('codex', 'offline-model'),
        'agent',
        environment(),
      ),
    ).toThrow(unsupported);
  });

  it.each(['anthropic-vertex', 'google-vertex'] as const)('rejects %s', (provider) => {
    const accounts = new AccountProfiles([
      {
        id: 'vertex',
        label: 'Offline Vertex',
        provider,
        projectId: 'offline',
        region: 'offline',
        credentialRef: '/offline/unused-adc.json',
        models,
      },
    ]);
    expect(() =>
      assertOrdinaryCodexContributorAccount(
        accounts,
        accounts.resolve('vertex', 'offline-model'),
        'agent',
        environment(),
      ),
    ).toThrow(unsupported);
  });
});
