import { expect, it } from 'vitest';
import {
  prepareOrdinaryWorkspaceCommand,
  prepareOrdinaryWorkspaceSelection,
} from '../explicit-local-chat';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
const content = {
  clientMsgId: 'original',
  sessionId: 'ordinary-session',
  ordinaryWorkspaceId: '11111111-1111-4111-8111-111111111111',
  mode: 'agent' as const,
  text: 'Retain the people-work report',
};
function fixture() {
  const inventory = localInventoryFixture();
  const selection = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    accountReference: inventory.accounts[0].account,
    agentProfile: { profileId: 'agent', revision: 1 },
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: inventory.capabilityRevision,
  };
  return { inventory, selection };
}
it('builds a strict V2 command from the existing settings validator with only actual ordinary identities', () => {
  const f = fixture(),
    original = structuredClone(f.selection),
    result = prepareOrdinaryWorkspaceCommand(f.selection, f.inventory, content);
  expect(result.reason).toBeUndefined();
  expect(result.request).toMatchObject({
    version: 2,
    sessionId: content.sessionId,
    clientMsgId: content.clientMsgId,
    workspace: { kind: 'ordinary', workspaceId: content.ordinaryWorkspaceId },
    selection: { model: 'luna-fixture', thinking: 'low' },
    payload: { text: content.text },
  });
  expect(result.request).not.toHaveProperty('repositoryWorkspaceId');
  expect(result.request).not.toHaveProperty('cwd');
  expect(f.selection).toEqual(original);
});
it('reviews the same settings before allocation without inventing a session or workspace ID', () => {
  const f = fixture(),
    input = { clientMsgId: content.clientMsgId, mode: content.mode, text: content.text },
    result = prepareOrdinaryWorkspaceSelection(f.selection, f.inventory, input);
  expect(result.request).toBeTruthy();
  for (const field of ['version', 'workspace', 'repositoryWorkspaceId', 'sessionId'])
    expect(result.request).not.toHaveProperty(field);
  expect(result.request?.selection.model).toBe('luna-fixture');
});
it('rejects unsupported OpenShell intent and stale account confirmation without silently switching runtime or billing', () => {
  const f = fixture(),
    selection = { ...f.selection, execution: { location: 'openshell' as const, targetId: 'mac' } },
    original = structuredClone(selection);
  expect(prepareOrdinaryWorkspaceCommand(selection, f.inventory, content)).toMatchObject({
    request: null,
    reason: expect.stringContaining('Local Mac Codex'),
  });
  expect(selection).toEqual(original);
  expect(
    prepareOrdinaryWorkspaceCommand(
      { ...f.selection, accountReference: null },
      f.inventory,
      content,
    ).request,
  ).toBeNull();
});
it('retains a missing identity, stale profile or oversized draft as an actionable refusal without fabricating replacements', () => {
  const f = fixture();
  expect(
    prepareOrdinaryWorkspaceCommand(f.selection, f.inventory, {
      ...content,
      ordinaryWorkspaceId: 'missing',
    }).request,
  ).toBeNull();
  expect(
    prepareOrdinaryWorkspaceCommand(f.selection, f.inventory, {
      ...content,
      text: 'x'.repeat(8 * 1024 * 1024 + 1),
    }),
  ).toMatchObject({ request: null, reason: expect.stringContaining('Shorten') });
  const inventory = { ...f.inventory, agentProfiles: [] };
  expect(prepareOrdinaryWorkspaceCommand(f.selection, inventory, content).request).toBeNull();
});

it('builds an ordinary OpenShell continuation from a configured route without a repository grant', () => {
  const f = fixture();
  Object.assign(f.inventory.targets[0], { location: 'openshell', label: 'OpenShell' });
  Object.assign(f.inventory.locations[0], { status: 'configured' });
  const selection = {
    ...f.selection,
    execution: { ...f.selection.execution, location: 'openshell' as const },
  };
  const result = prepareOrdinaryWorkspaceCommand(selection, f.inventory, content);
  expect(result.request).toMatchObject({
    version: 2,
    runOn: 'openshell',
    workspace: { kind: 'ordinary' },
  });
  expect(result.request).not.toHaveProperty('repositoryWorkspaceId');
});
