import { expect, it } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import {
  selectSessionOwnedProviderEvidence,
  assertSessionOwnedProviderEvidence,
} from '../symposium-session-evidence-selection.js';
const models = [{ id: 'claude-fixture', label: 'Offline fixture' }];
const profiles = new AccountProfiles([
  {
    id: 'vertex-stage',
    label: 'Fresh staging Vertex',
    provider: 'anthropic-vertex',
    credentialRef: '/offline/unused-adc.json',
    projectId: 'stage-project',
    region: 'stage-region',
    sandboxProvider: 'stage-vertex-provider',
    sandboxProviderId: 'stage-vertex-provider-id',
    models,
  },
  {
    id: 'api-stage',
    label: 'Fresh staging API',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'unused-offline', account: 'stage' },
    sandboxProvider: 'stage-api-provider',
    sandboxProviderId: 'stage-api-id',
    models: [{ id: 'gpt-6-luna', label: 'Luna fixture' }],
  },
]);
const binding = profiles.resolve('vertex-stage', models[0].id);
const config = {
  version: 2,
  revision: 1,
  state: 'draft',
  anchorSeatId: 'primary',
  activeSeatCap: 1,
  seats: [
    {
      id: 'primary',
      name: 'Stage Reader',
      role: 'reviewer',
      model: binding.model,
      accountBinding: binding,
      systemPrompt: 'Read fixture',
      color: '#335577',
    },
  ],
  turnRules: { mode: 'directed', maxTurns: 2 },
  interceptMode: 'manual',
};
it('derives Vertex candidate scope only from actual selected profiles and draft roles', () => {
  const selected = selectSessionOwnedProviderEvidence(config, profiles);
  expect(selected).toEqual({
    providerInstances: [
      {
        name: 'stage-vertex-provider',
        id: 'stage-vertex-provider-id',
        type: 'google-vertex-ai',
        profileName: 'google-vertex-ai',
      },
    ],
    allowedRoles: ['reviewer'],
    allowedAccountProviders: ['anthropic-vertex'],
  });
  expect(() => assertSessionOwnedProviderEvidence(config, profiles, selected)).not.toThrow();
});
it('refuses caller provider substitution, added provider/role scope and stale account revision', () => {
  const selected = selectSessionOwnedProviderEvidence(config, profiles);
  for (const changed of [
    { ...selected, allowedAccountProviders: ['openai'] },
    { ...selected, allowedRoles: ['reviewer', 'coder'] },
    { ...selected, providerInstances: [{ ...selected.providerInstances[0], id: 'other' }] },
    {
      ...selected,
      providerInstances: [...selected.providerInstances, selected.providerInstances[0]],
    },
  ])
    expect(() => assertSessionOwnedProviderEvidence(config, profiles, changed)).toThrow();
  expect(() =>
    selectSessionOwnedProviderEvidence(
      {
        ...config,
        seats: [{ ...config.seats[0], accountBinding: { ...binding, profileRevision: 'changed' } }],
      },
      profiles,
    ),
  ).toThrow();
});
it('preserves Work API selection and refuses mixed runtime providers or personal substitution', () => {
  const api = profiles.resolve('api-stage', 'gpt-6-luna');
  const apiSeat = { ...config.seats[0], accountBinding: api, model: api.model };
  expect(
    selectSessionOwnedProviderEvidence({ ...config, seats: [apiSeat] }, profiles)
      .allowedAccountProviders,
  ).toEqual(['openai']);
  expect(() =>
    selectSessionOwnedProviderEvidence(
      { ...config, activeSeatCap: 2, seats: [config.seats[0], { ...apiSeat, id: 'secondary' }] },
      profiles,
    ),
  ).toThrow();
  expect(() =>
    selectSessionOwnedProviderEvidence(
      {
        ...config,
        seats: [{ ...config.seats[0], accountBinding: { ...binding, provider: 'openai-codex' } }],
      },
      profiles,
    ),
  ).toThrow();
});

it('binds the actual retained Vertex receipt to account, project, region and model, not only provider id', async () => {
  const { assertSessionOwnedVertexReceipt } =
    await import('../symposium-session-evidence-selection.js');
  const receipt = {
    principal: 'fresh-stage@example.test',
    accountId: binding.accountId,
    provider: 'stage-vertex-provider',
    providerId: 'stage-vertex-provider-id',
    projectId: 'stage-project',
    region: 'stage-region',
    model: binding.model,
    workspace: 'stage-workspace',
  };
  expect(() =>
    assertSessionOwnedVertexReceipt(config, profiles, receipt, 'stage-workspace'),
  ).not.toThrow();
  for (const changed of [
    { ...receipt, principal: '' },
    { ...receipt, accountId: 'other' },
    { ...receipt, projectId: 'other' },
    { ...receipt, region: 'other' },
    { ...receipt, model: 'other' },
    { ...receipt, workspace: 'other' },
  ])
    expect(() =>
      assertSessionOwnedVertexReceipt(config, profiles, changed, 'stage-workspace'),
    ).toThrow();
});

it('preserves existing private owned implementer draft collection while public candidates stay coder/reviewer', () => {
  const owned = { ...config, seats: [{ ...config.seats[0], role: 'implementer' }] };
  expect(() => selectSessionOwnedProviderEvidence(owned, profiles)).toThrow('roles');
  const selected = selectSessionOwnedProviderEvidence(owned, profiles, 'owned-draft');
  expect(selected.allowedRoles).toEqual(['implementer']);
  expect(() =>
    assertSessionOwnedProviderEvidence(owned, profiles, selected, 'owned-draft'),
  ).not.toThrow();
});
