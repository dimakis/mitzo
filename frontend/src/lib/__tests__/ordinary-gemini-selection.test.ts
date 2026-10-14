import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ExplicitLocalInventorySchema,
  prepareLocalContinuationCommand,
  prepareLocalFirstCommand,
} from '../explicit-local-chat';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
it('serializes the explicit Local Gemini tuple and retains unsupported future model/thinking draft choices', () => {
  const account = {
    accountId: 'google',
    provider: 'google-vertex' as const,
    profileRevision: 'original',
  };
  const definition = {
    name: 'Developer',
    descriptor: 'Assistant',
    role: 'agent' as const,
    instructions: 'Preserve ownership',
    expectedOutput: 'Review',
    acceptanceCriteria: ['Evidence'],
    modelPolicyRole: 'agent' as const,
  };
  const inventory = ExplicitLocalInventorySchema.parse({
    version: 1,
    authority: 'configuration-only',
    defaultLocation: 'openshell',
    capabilityRevision: 'configured',
    accounts: [
      {
        account,
        label: 'Google',
        models: [
          { id: 'gemini-2.5-pro', label: 'Pro', reasoningEfforts: ['low', 'high'] },
          { id: 'gemini-2.5-flash', label: 'Flash', reasoningEfforts: ['high'] },
        ],
        modelDiscovery: { source: 'configured', stale: false },
      },
    ],
    targets: [
      {
        targetId: 'mac',
        targetRevision: 'target',
        label: 'Local',
        location: 'local',
        harness: 'gemini',
      },
    ],
    routes: [
      {
        account,
        targetId: 'mac',
        harness: 'gemini',
        modes: ['agent'],
        skillCeiling: 'unsupported',
      },
    ],
    locations: [
      { location: 'local', status: 'configured' },
      {
        location: 'openshell',
        status: 'unavailable',
        reason: 'Google Vertex OpenShell is unsupported',
      },
    ],
    agentProfiles: [
      {
        profileId: 'developer',
        revision: 1,
        definition,
        contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
      },
    ],
  });
  const selected = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'google', model: 'gemini-2.5-pro', reasoningEffort: 'low' },
    accountReference: account,
    agentProfile: { profileId: 'developer', revision: 1 },
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: 'configured',
  };
  const input = {
    clientMsgId: 'command',
    repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
    mode: 'agent' as const,
    text: 'task',
  };
  expect(prepareLocalFirstCommand(selected, inventory, input).request).toMatchObject({
    runtime: { harness: 'gemini', account },
    selection: { model: 'gemini-2.5-pro', thinking: 'low' },
  });
  const nativeConstraint = {
    model: 'gemini-2.5-pro',
    thinking: 'low',
    reason:
      'Continue with the original Gemini model and thinking. Start another conversation to change them.' as const,
  };
  expect(
    prepareLocalContinuationCommand(selected, inventory, {
      ...input,
      sessionId: 'task',
      nativeConstraint,
    }).request,
  ).not.toBeNull();
  for (const choice of [
    {
      ...selected,
      account: { ...selected.account, model: 'gemini-2.5-flash', reasoningEffort: 'high' },
    },
    { ...selected, account: { ...selected.account, reasoningEffort: 'high' } },
  ]) {
    const before = structuredClone(choice);
    expect(
      prepareLocalContinuationCommand(choice, inventory, {
        ...input,
        sessionId: 'task',
        nativeConstraint,
      }),
    ).toEqual({ request: null, reason: nativeConstraint.reason });
    expect(choice).toEqual(before);
  }
  expect(
    prepareLocalContinuationCommand(selected, inventory, { ...input, sessionId: 'task' }).request,
  ).toBeNull();
  expect(
    prepareLocalContinuationCommand(
      {
        ...selected,
        accountReference: null,
        account: { ...selected.account, reasoningEffort: 'high' },
      },
      inventory,
      { ...input, sessionId: 'task', nativeConstraint },
    ),
  ).toEqual({ request: null, reason: nativeConstraint.reason });
});
