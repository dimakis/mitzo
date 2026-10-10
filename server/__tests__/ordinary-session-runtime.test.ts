import { describe, expect, it } from 'vitest';
import { SessionRuntimeBindingV1Schema } from '@mitzo/protocol';
import {
  resolveOrdinarySessionRuntime,
  type OrdinarySessionRuntimeCatalog,
  type OrdinarySessionRuntimeRequest,
} from '../ordinary-session-runtime.js';

function catalog(): OrdinarySessionRuntimeCatalog {
  return {
    deployment: 'ordinary',
    enabledHarnesses: ['codex', 'responses', 'claude-sdk', 'gemini'],
    accounts: [
      {
        accountId: 'chatgpt-host',
        provider: 'openai-codex',
        profileRevision: 'r1',
        planType: 'pro',
        auth: { kind: 'host-login' },
      },
      {
        accountId: 'chatgpt-broker',
        provider: 'openai-codex',
        profileRevision: 'r1',
        planType: 'plus',
        auth: { kind: 'brokered-oauth', targetIds: ['ordinary-sandbox'] },
      },
      {
        accountId: 'api',
        provider: 'openai',
        profileRevision: 'r1',
        auth: { kind: 'api-credential', openshellTargetIds: ['ordinary-sandbox'] },
      },
      {
        accountId: 'claude',
        provider: 'anthropic-vertex',
        profileRevision: 'r1',
        auth: { kind: 'vertex-adc' },
      },
      {
        accountId: 'gemini',
        provider: 'google-vertex',
        profileRevision: 'r1',
        auth: { kind: 'vertex-adc' },
      },
    ],
    targets: [
      { targetId: 'host', location: 'local' },
      {
        targetId: 'ordinary-sandbox',
        location: 'openshell',
        ownership: 'dedicated-ordinary',
        openaiApi: 'enabled',
      },
    ],
  };
}

function request(
  accountId = 'chatgpt-host',
  provider: OrdinarySessionRuntimeRequest['account']['provider'] = 'openai-codex',
  harness: OrdinarySessionRuntimeRequest['harness'] = 'codex',
  targetId = 'host',
): OrdinarySessionRuntimeRequest {
  return {
    account: { accountId, provider, profileRevision: 'r1' },
    harness,
    targetId,
    mode: 'agent',
  };
}

function reject(value: unknown, configuration: unknown, code: string) {
  expect(resolveOrdinarySessionRuntime(value, configuration)).toEqual({ status: 'rejected', code });
}

describe('dormant ordinary runtime configuration resolution', () => {
  it.each([
    ['chatgpt-host', 'openai-codex', 'codex', 'host', 'local'],
    ['chatgpt-broker', 'openai-codex', 'codex', 'ordinary-sandbox', 'openshell'],
    ['api', 'openai', 'responses', 'host', 'local'],
    ['api', 'openai', 'codex', 'ordinary-sandbox', 'openshell'],
    ['claude', 'anthropic-vertex', 'claude-sdk', 'host', 'local'],
    ['gemini', 'google-vertex', 'gemini', 'host', 'local'],
  ] as const)(
    'describes configured %s / %s / %s / %s',
    (id, provider, harness, targetId, location) => {
      const result = resolveOrdinarySessionRuntime(
        request(id, provider, harness, targetId),
        catalog(),
      );
      expect(result).toEqual({
        status: 'compatible',
        binding: {
          version: 1,
          account: { accountId: id, provider, profileRevision: 'r1' },
          harness: { implementation: harness },
          execution: { location },
        },
        targetId,
      });
      if (result.status !== 'compatible') throw new Error('Expected compatible configuration');
      expect(SessionRuntimeBindingV1Schema.safeParse(result.binding).success).toBe(true);
      expect(result.binding.execution).not.toHaveProperty('targetId');
    },
  );

  it.each([
    request('api', 'openai', 'codex'),
    request('api', 'openai', 'responses', 'ordinary-sandbox'),
    request('claude', 'anthropic-vertex', 'claude-sdk', 'ordinary-sandbox'),
    request('gemini', 'google-vertex', 'gemini', 'ordinary-sandbox'),
    request('chatgpt-host', 'openai-codex', 'responses'),
    request('claude', 'anthropic-vertex', 'codex'),
    request('gemini', 'google-vertex', 'claude-sdk'),
  ])('rejects a tuple outside existing ordinary adapters', (selection) => {
    reject(selection, catalog(), 'unsupported_tuple');
  });

  it.each(['codex', 'responses', 'claude-sdk', 'gemini'] as const)(
    'cannot infer compatibility from a disabled %s adapter',
    (harness) => {
      const selection = {
        codex: request(),
        responses: request('api', 'openai', 'responses'),
        'claude-sdk': request('claude', 'anthropic-vertex', 'claude-sdk'),
        gemini: request('gemini', 'google-vertex', 'gemini'),
      }[harness];
      const configuration = catalog();
      configuration.enabledHarnesses = configuration.enabledHarnesses.filter((h) => h !== harness);
      reject(selection, configuration, 'harness_disabled');
    },
  );

  it.each([
    request('chatgpt-host', 'openai-codex', 'codex', 'ordinary-sandbox'),
    request('chatgpt-broker', 'openai-codex', 'codex', 'host'),
  ])('never substitutes an auth class or falls back to another target', (selection) => {
    reject(selection, catalog(), 'auth_configuration_incompatible');
  });

  it('requires the exact configured provider target for API OpenShell', () => {
    const configuration = catalog();
    const account = configuration.accounts[2];
    if (account.provider !== 'openai') throw new Error('Expected API fixture');
    account.auth.openshellTargetIds = [];
    reject(
      request('api', 'openai', 'codex', 'ordinary-sandbox'),
      configuration,
      'auth_configuration_incompatible',
    );
    expect(
      resolveOrdinarySessionRuntime(request('api', 'openai', 'responses'), configuration).status,
    ).toBe('compatible');
  });

  it('does not replace API-disabled OpenShell with an available host route', () => {
    const configuration = catalog();
    const target = configuration.targets[1];
    if (target.location !== 'openshell') throw new Error('Expected OpenShell fixture');
    target.openaiApi = 'disabled';
    reject(
      request('api', 'openai', 'codex', target.targetId),
      configuration,
      'auth_configuration_incompatible',
    );
    expect(
      resolveOrdinarySessionRuntime(
        request('chatgpt-broker', 'openai-codex', 'codex', target.targetId),
        configuration,
      ).status,
    ).toBe('compatible');
  });

  it('keeps native sandbox ChatGPT enrollment in Symposium', () => {
    const configuration = catalog();
    const account = configuration.accounts[0];
    if (account.provider !== 'openai-codex') throw new Error('Expected Codex fixture');
    account.auth = { kind: 'sandbox-chatgpt' };
    for (const target of configuration.targets) {
      reject(
        request(account.accountId, account.provider, 'codex', target.targetId),
        configuration,
        'native_auth_ordinary_unsupported',
      );
    }
  });

  it.each(['api', 'API', ' Api '])(
    'rejects ambiguous legacy Codex plan %s without billing substitution',
    (planType) => {
      const configuration = catalog();
      for (const account of configuration.accounts) {
        if (account.provider !== 'openai-codex') continue;
        account.planType = planType;
        const targetId = account.auth.kind === 'host-login' ? 'host' : 'ordinary-sandbox';
        reject(
          request(account.accountId, account.provider, 'codex', targetId),
          configuration,
          'ambiguous_codex_api_plan',
        );
      }
    },
  );

  it.each([{ skillCeiling: [] }, { skillCeiling: ['Read'] }])(
    'rejects any supplied Codex skill ceiling, including empty',
    ({ skillCeiling }) => {
      for (const selection of [
        request(),
        request('chatgpt-broker', 'openai-codex', 'codex', 'ordinary-sandbox'),
        request('api', 'openai', 'codex', 'ordinary-sandbox'),
      ]) {
        reject({ ...selection, skillCeiling }, catalog(), 'skill_ceiling_unsupported');
      }
    },
  );

  it.each([
    request('api', 'openai', 'responses'),
    request('claude', 'anthropic-vertex', 'claude-sdk'),
    request('gemini', 'google-vertex', 'gemini'),
  ])('preserves host skill ceiling and mode capability for other harnesses', (selection) => {
    for (const mode of ['ask', 'agent', 'auto']) {
      expect(
        resolveOrdinarySessionRuntime({ ...selection, mode, skillCeiling: [] }, catalog()).status,
      ).toBe('compatible');
    }
  });

  it('supports host Codex Ask but rejects OpenShell Ask for both billing providers', () => {
    expect(resolveOrdinarySessionRuntime({ ...request(), mode: 'ask' }, catalog()).status).toBe(
      'compatible',
    );
    for (const selection of [
      request('chatgpt-broker', 'openai-codex', 'codex', 'ordinary-sandbox'),
      request('api', 'openai', 'codex', 'ordinary-sandbox'),
    ]) {
      reject({ ...selection, mode: 'ask' }, catalog(), 'mode_unsupported');
      expect(resolveOrdinarySessionRuntime({ ...selection, mode: 'auto' }, catalog()).status).toBe(
        'compatible',
      );
    }
  });

  it('refuses shared or retained OpenShell for new selection in either deployment', () => {
    const configuration = catalog();
    const target = configuration.targets[1];
    if (target.location !== 'openshell') throw new Error('Expected OpenShell fixture');
    target.ownership = 'shared-or-retained';
    for (const deployment of ['ordinary', 'custodian']) {
      reject(
        request('chatgpt-broker', 'openai-codex', 'codex', target.targetId),
        { ...configuration, deployment },
        'target_not_dedicated_ordinary',
      );
    }
  });

  it('custodian rejects OpenAI host execution without widening policy to Vertex', () => {
    const configuration = { ...catalog(), deployment: 'custodian' };
    reject(request(), configuration, 'custodian_requires_dedicated_openshell');
    reject(
      request('api', 'openai', 'responses'),
      configuration,
      'custodian_requires_dedicated_openshell',
    );
    for (const selection of [
      request('claude', 'anthropic-vertex', 'claude-sdk'),
      request('gemini', 'google-vertex', 'gemini'),
      request('chatgpt-broker', 'openai-codex', 'codex', 'ordinary-sandbox'),
      request('api', 'openai', 'codex', 'ordinary-sandbox'),
    ]) {
      expect(resolveOrdinarySessionRuntime(selection, configuration).status).toBe('compatible');
    }
  });

  it('distinguishes unavailable identities from mismatched exact account revisions', () => {
    reject(request('missing'), catalog(), 'account_unavailable');
    reject(
      { ...request(), account: { ...request().account, provider: 'openai' } },
      catalog(),
      'account_identity_mismatch',
    );
    reject(
      { ...request(), account: { ...request().account, profileRevision: 'r2' } },
      catalog(),
      'account_identity_mismatch',
    );
    reject({ ...request(), targetId: 'missing' }, catalog(), 'target_unavailable');
  });

  it('refuses duplicate IDs even if only one entry matches the requested revision or target', () => {
    const configuration = catalog();
    configuration.accounts.push({ ...configuration.accounts[0], profileRevision: 'r2' });
    reject(request(), configuration, 'ambiguous_account');
    const targets = catalog();
    targets.targets.push({ ...targets.targets[1], targetId: 'host' });
    reject(request(), targets, 'ambiguous_target');
  });

  it.each([
    null,
    {},
    { ...request(), targetId: '' },
    { ...request(), targetId: undefined },
    { ...request(), harness: 'native' },
    { ...request(), mode: 'plan' },
    { ...request(), skillCeiling: null },
    { ...request(), account: { ...request().account, profileRevision: '' } },
    { ...request(), account: { ...request().account, profileRevision: undefined } },
  ])('rejects missing or malformed explicit selection', (selection) => {
    reject(selection, catalog(), 'invalid_request');
  });

  it('requires a strict configuration catalog rather than presence or readiness flags', () => {
    for (const configuration of [
      null,
      {},
      { ...catalog(), enabledHarnesses: undefined },
      { ...catalog(), enabledHarnesses: ['codex', 'codex'] },
      { ...catalog(), enabledHarnesses: ['native'] },
      { ...catalog(), ready: true },
      { ...catalog(), targets: [{ targetId: 'host', location: 'local', credentialPresent: true }] },
      {
        ...catalog(),
        accounts: [{ ...catalog().accounts[0], auth: { kind: 'host-login', brokered: true } }],
      },
    ]) {
      reject(request(), configuration, 'invalid_catalog');
    }
  });

  it.each([
    { targetIds: [] },
    { targetIds: ['missing'] },
    { targetIds: ['host'] },
    { targetIds: ['ordinary-sandbox', 'ordinary-sandbox'] },
  ])(
    'rejects incomplete, unknown, local or duplicate brokered target references',
    ({ targetIds }) => {
      const configuration = catalog();
      const account = configuration.accounts[1];
      if (account.provider !== 'openai-codex') throw new Error('Expected Codex fixture');
      account.auth = { kind: 'brokered-oauth', targetIds };
      reject(request(), configuration, 'invalid_catalog');
    },
  );

  it.each([
    { openshellTargetIds: ['missing'] },
    { openshellTargetIds: ['host'] },
    { openshellTargetIds: ['ordinary-sandbox', 'ordinary-sandbox'] },
  ])('rejects invalid API target references too', ({ openshellTargetIds }) => {
    const configuration = catalog();
    const account = configuration.accounts[2];
    if (account.provider !== 'openai') throw new Error('Expected API fixture');
    account.auth.openshellTargetIds = openshellTargetIds;
    reject(request(), configuration, 'invalid_catalog');
  });

  it('rejects credential and execution payloads without echoing their values', () => {
    const secret = 'DO-NOT-ECHO-this-test-secret';
    for (const selection of [
      { ...request(), token: secret },
      { ...request(), account: { ...request().account, credentialRef: secret } },
      { ...request(), gatewayEndpoint: secret },
      { ...request(), model: secret },
      { ...request(), prompt: secret },
    ]) {
      reject(selection, catalog(), 'invalid_request');
      expect(JSON.stringify(resolveOrdinarySessionRuntime(selection, catalog()))).not.toContain(
        secret,
      );
    }
    for (const configuration of [
      { ...catalog(), accounts: [{ ...catalog().accounts[0], credentialRef: secret }] },
      { ...catalog(), targets: [{ targetId: 'host', location: 'local', executable: secret }] },
    ]) {
      reject(request(), configuration, 'invalid_catalog');
      expect(JSON.stringify(resolveOrdinarySessionRuntime(request(), configuration))).not.toContain(
        secret,
      );
    }
  });

  it('returns only independent configuration metadata and never mutates its inputs', () => {
    const configuration = catalog();
    const selection = request();
    const before = JSON.stringify({ configuration, selection });
    const result = resolveOrdinarySessionRuntime(selection, configuration);
    expect(JSON.stringify({ configuration, selection })).toBe(before);
    expect(result).not.toHaveProperty('authorized');
    expect(result).not.toHaveProperty('ready');
    if (result.status !== 'compatible') throw new Error('Expected compatible fixture');
    result.binding.account.profileRevision = 'changed';
    expect(selection.account.profileRevision).toBe('r1');
    expect(configuration.accounts[0].profileRevision).toBe('r1');
  });
});
