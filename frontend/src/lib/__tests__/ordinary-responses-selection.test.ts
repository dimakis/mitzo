import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { expect, it } from 'vitest';
import {
  ExplicitLocalInventorySchema,
  normalizeLocalInventory,
  prepareLocalFirstCommand,
  prepareLocalContinuationCommand,
} from '../explicit-local-chat';
import {
  createChatRuntimeSelection,
  evaluateChatRuntimeSelection,
} from '../chat-runtime-selection';
const account = {
  accountId: 'work-api',
  provider: 'openai' as const,
  profileRevision: 'one-enrolled-credential',
};
const model = (id: string) => ({ id, label: id, reasoningEfforts: ['high'] });
const inventory = ExplicitLocalInventorySchema.parse({
  version: 1,
  authority: 'configuration-only',
  defaultLocation: 'openshell',
  capabilityRevision: 'combined',
  accounts: [
    {
      account,
      label: 'Work API',
      models: [model('shell-model'), model('api-model')],
      modelDiscovery: { source: 'configured', stale: false },
    },
  ],
  targets: [
    {
      targetId: 'shell',
      targetRevision: 'shell-revision',
      label: 'OpenShell',
      location: 'openshell',
      harness: 'codex',
    },
    {
      targetId: 'mac-api',
      targetRevision: 'mac-revision',
      label: 'Local Mac',
      location: 'local',
      harness: 'responses',
    },
  ],
  routes: [
    {
      account,
      targetId: 'shell',
      harness: 'codex',
      modes: ['agent'],
      capabilityRevision: 'shell-cap',
      models: [model('shell-model')],
      modelDiscovery: { source: 'configured', stale: false },
    },
    {
      account,
      targetId: 'mac-api',
      harness: 'responses',
      modes: ['agent'],
      capabilityRevision: 'local-cap',
      models: [model('api-model')],
      modelDiscovery: { source: 'configured', stale: false },
    },
  ],
  locations: [
    { location: 'openshell', status: 'configured' },
    { location: 'local', status: 'configured' },
  ],
  agentProfiles: [],
});
const agent = { profileId: 'developer', revision: 1 };
// Selection evaluation uses published reference inventory; the wire schema rejects invented namespaces.
const pickerInventory = { ...normalizeLocalInventory(inventory), agentProfiles: [agent] };
const selected = {
  ...createChatRuntimeSelection(),
  account: { accountId: account.accountId, model: 'api-model', reasoningEffort: 'high' },
  accountReference: account,
  agentProfile: agent,
  execution: { location: 'local' as const, targetId: 'mac-api' },
  capabilityRevision: 'combined',
};
const input = {
  clientMsgId: 'first',
  repositoryWorkspaceId: '12345678-1234-4234-8234-123456789012',
  mode: 'agent' as const,
  text: 'Develop the same account on Local',
};
it('derives Responses from exact account/environment tuple without changing account or OpenShell preference', () => {
  expect(createChatRuntimeSelection().execution.location).toBe('openshell');
  expect(evaluateChatRuntimeSelection(selected, pickerInventory).ready).toBe(true);
  const source = {
    ...inventory,
    agentProfiles: [{ ...localInventoryFixture().agentProfiles[0], profileId: 'developer' }],
  };
  const first = prepareLocalFirstCommand(selected, source, input).request!;
  expect(first.runtime).toMatchObject({ account, harness: 'responses', targetId: 'mac-api' });
  expect(first.capabilityRevision).toBe('local-cap');
  expect(
    prepareLocalContinuationCommand(selected, source, {
      ...input,
      clientMsgId: 'future',
      sessionId: 'retained',
    }).request?.runtime,
  ).toEqual(first.runtime);
  const elsewhere = {
    ...selected,
    execution: { location: 'openshell' as const, targetId: 'shell' },
    account: { ...selected.account, model: 'shell-model' },
  };
  expect(
    prepareLocalFirstCommand(elsewhere, source, {
      ...input,
      repositoryWorkspaceId: '22345678-1234-4234-8234-123456789012',
    }).request?.runtime,
  ).toMatchObject({ account, harness: 'codex' });
});
it('keeps unsupported future/environment choices explicit and rejects stale opaque account identity', () => {
  expect(
    evaluateChatRuntimeSelection(
      { ...selected, account: { ...selected.account, model: 'shell-model' } },
      pickerInventory,
    ).issues.map((issue) => issue.code),
  ).toContain('model_unavailable');
  expect(
    evaluateChatRuntimeSelection(
      { ...selected, accountReference: { ...account, profileRevision: 'changed' } },
      pickerInventory,
    ).issues.map((issue) => issue.code),
  ).toContain('account_route_changed');
  const unavailable = {
    ...pickerInventory,
    locations: pickerInventory.locations.map((location) =>
      location.location === 'openshell'
        ? { ...location, available: false, reason: 'Original OpenShell target unavailable' }
        : location,
    ),
  };
  const elsewhere = {
    ...selected,
    execution: { location: 'openshell' as const, targetId: 'shell' },
  };
  expect(
    evaluateChatRuntimeSelection(elsewhere, unavailable).issues.some((issue) =>
      issue.message.includes('Original OpenShell'),
    ),
  ).toBe(true);
  expect(elsewhere.accountReference).toEqual(account);
});

it('retains a rejected context choice and explains the real adapter boundary', () => {
  const source = {
    ...inventory,
    agentProfiles: [{ ...localInventoryFixture().agentProfiles[0], profileId: 'developer' }],
    routes: inventory.routes.map((route) =>
      route.harness === 'responses'
        ? {
            ...route,
            agentProfiles: [],
            agentProfileRejections: [{ agent, reason: 'native_context_unavailable' as const }],
          }
        : route,
    ),
  };
  const before = structuredClone(selected);
  expect(prepareLocalFirstCommand(selected, source, input)).toMatchObject({
    request: null,
    reason: expect.stringMatching(/context recipes.*unavailable/),
  });
  expect(selected).toEqual(before);
});
