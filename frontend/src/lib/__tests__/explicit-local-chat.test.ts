import { expect, it } from 'vitest';
import { buildLocalFirstCommand, normalizeLocalInventory } from '../explicit-local-chat';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
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
