import { expect, it } from 'vitest';
import type { ExplicitLocalInventory } from '../explicit-local-chat';
import {
  ExplicitLocalInventorySchema,
  buildLocalFirstCommand,
  normalizeLocalInventory,
  prepareLocalFirstCommand,
} from '../explicit-local-chat';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
it('preserves server location explanations and translates configured reason codes', () => {
  const data = localInventoryFixture();
  expect(normalizeLocalInventory(data).locations[0].reason).toBe(
    'OpenShell execution choices are not available yet.',
  );
  data.locations[0].reason = 'The selected OpenShell target is offline.';
  expect(normalizeLocalInventory(data).locations[0].reason).toBe(data.locations[0].reason);
});
it('keeps OpenShell unavailable rather than choosing the configured Local route', () => {
  const data = localInventoryFixture();
  const intent = createChatRuntimeSelection();
  expect(
    buildLocalFirstCommand(intent, data, {
      clientMsgId: 'first',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      mode: 'agent',
      text: 'Inspect',
    }),
  ).toBeNull();
  expect(intent.execution.location).toBe('openshell');
});
it('requires published revision, explicit thinking and ready exact selected route', () => {
  const data = localInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: data.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  const args = {
    clientMsgId: 'first',
    repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
    mode: 'agent' as const,
    text: 'Inspect',
  };
  const result = buildLocalFirstCommand(intent, data, args)!;
  expect(result.runtime.account).toEqual(data.accounts[0].account);
  expect(result.selection.agent).toEqual(intent.agentProfile);
  expect(result.payload).toEqual({ text: 'Inspect' });
  expect(
    buildLocalFirstCommand(
      { ...intent, account: { ...intent.account, reasoningEffort: null } },
      data,
      args,
    ),
  ).toBeNull();
  expect(buildLocalFirstCommand({ ...intent, capabilityRevision: 'older' }, data, args)).toBeNull();
  expect(buildLocalFirstCommand({ ...intent, agentProfile: null }, data, args)).toBeNull();
  expect(
    buildLocalFirstCommand(
      { ...intent, agentProfile: { profileId: 'agent', revision: 2 } },
      data,
      args,
    ),
  ).toBeNull();
  expect(normalizeLocalInventory(data).locations[0].available).toBe(false);
});
it('refuses builtin selection before request construction even when the user-library ID and revision collide', () => {
  const data = localInventoryFixture();
  const selection = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: data.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: {
      kind: 'builtin',
      profileId: 'agent',
      revision: 1,
    } as import('@mitzo/protocol').AgentProfileSelection,
  };
  expect(
    buildLocalFirstCommand(selection, data, {
      clientMsgId: 'first',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      mode: 'agent',
      text: 'Inspect',
    }),
  ).toBeNull();
  expect(selection.agentProfile).toHaveProperty('kind', 'builtin');
});

it('bounds the entire UTF8 Local envelope and exposes a recovery reason without dropping attachments', () => {
  const data = localInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: data.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  const input = {
    clientMsgId: '11111111-1111-4111-8111-111111111111',
    repositoryWorkspaceId: '22222222-2222-4222-8222-222222222222',
    mode: 'agent' as const,
    text: 'é'.repeat(300000),
    images: [{ data: 'AAAA'.repeat(120000), mediaType: 'image/jpeg' }],
  };
  expect(input.text.length + input.images[0].data.length).toBeLessThan(1048576);
  const result = prepareLocalFirstCommand(intent, data, input);
  expect(result.request).toBeNull();
  expect(result.reason).toMatch(/Remove or resize attachments, or shorten/);
  expect(input.images).toHaveLength(1);
  expect(
    prepareLocalFirstCommand(intent, data, { ...input, text: 'Shortened prompt' }).request,
  ).not.toBeNull();
});

it('prepares OpenShell with its native route revision while the draft reviews the combined inventory', async () => {
  const { ordinaryRuntimeInventoryFixture } =
    await import('../../test-utils/ordinary-runtime-inventory-fixture');
  const data = ordinaryRuntimeInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'openshell' as const, targetId: 'sandbox' },
    capabilityRevision: data.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  const request = prepareLocalFirstCommand(intent, data, {
    clientMsgId: 'sandbox-first',
    repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
    mode: 'agent',
    text: 'Inspect sandbox',
  }).request;
  expect(request).toMatchObject({
    runOn: 'openshell',
    capabilityRevision: 'sandbox-caps-r1',
    runtime: { targetId: 'sandbox', account: data.accounts[0].account },
  });
  expect(intent.capabilityRevision).toBe('combined-caps-r1');
});

it('keeps route locations distinct when independently configured targets reuse an ID', () => {
  const data: ExplicitLocalInventory = localInventoryFixture();
  const local = data.targets[0];
  data.targets.push({ ...local, location: 'openshell', label: 'OpenShell' });
  data.routes[0] = { ...data.routes[0], location: 'local', capabilityRevision: 'local-revision' };
  data.routes.push({
    ...data.routes[0],
    location: 'openshell',
    capabilityRevision: 'shell-revision',
  });
  expect(
    normalizeLocalInventory(ExplicitLocalInventorySchema.parse(data)).routes.map(
      (route) => route.location,
    ),
  ).toEqual(['local', 'openshell']);
  data.locations[0] = { location: 'openshell', status: 'configured' };
  const result = prepareLocalFirstCommand(
    {
      ...createChatRuntimeSelection(),
      execution: { location: 'openshell', targetId: local.targetId },
      capabilityRevision: data.capabilityRevision,
      account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
      agentProfile: { profileId: 'agent', revision: 1 },
    },
    data,
    {
      clientMsgId: 'first',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      mode: 'agent',
      text: 'Inspect',
    },
  );
  expect(result.request?.capabilityRevision).toBe('shell-revision');
  expect(result.request?.runOn).toBe('openshell');
});

it('refuses an older ambiguous route without choosing the first environment', () => {
  const data: ExplicitLocalInventory = localInventoryFixture();
  data.targets.push({ ...data.targets[0], location: 'openshell', label: 'OpenShell' });
  const route = normalizeLocalInventory(data).routes[0];
  expect(route.available).toBe(false);
  expect(route.reason).toContain('ambiguous');
});
