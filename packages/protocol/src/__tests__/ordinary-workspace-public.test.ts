import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as protocol from '../index.js';

const account = { accountId: 'offline', provider: 'openai-codex' as const, profileRevision: 'r1' };
const runtime = {
  account,
  harness: 'codex' as const,
  targetId: 'offline-local',
  mode: 'agent' as const,
};
const selection = {
  version: 1 as const,
  agent: { profileId: 'ordinary-worker', revision: 1 },
  context: { source: 'none' as const, revision: null },
  permission: { mode: 'agent' as const, revision: 0 },
  model: 'fixture-model',
  thinking: 'low',
};
const command = {
  version: 2,
  runOn: 'local',
  sessionId: 'ordinary-session',
  workspace: { kind: 'ordinary', workspaceId: randomUUID() },
  clientMsgId: randomUUID(),
  capabilityRevision: 'c1',
  runtime,
  selection,
  payload: { text: 'Review the studio plan' },
};
it('retains strict repository V1 while V2 ordinary commands have explicit session/kind without a fake repository', () => {
  const legacy = {
    runOn: 'local',
    repositoryWorkspaceId: randomUUID(),
    clientMsgId: randomUUID(),
    capabilityRevision: 'c1',
    runtime,
    selection,
    payload: command.payload,
  };
  expect(protocol.LocalCodexFirstCommandSchema.parse(legacy)).toEqual(legacy);
  expect(protocol.LocalCodexFirstCommandSchema.safeParse(command).success).toBe(false);
  expect(protocol.OrdinaryWorkspaceFirstCommandSchema.parse(command)).toEqual(command);
  expect(protocol.OrdinaryWorkspaceContinuationCommandSchema.parse(command)).toEqual(command);
  expect(
    protocol.OrdinaryWorkspaceFirstCommandSchema.safeParse({
      ...command,
      repositoryWorkspaceId: randomUUID(),
    }).success,
  ).toBe(false);
});
it('keeps physical paths, fake branch/source and client authority outside the ordinary command DTO', () => {
  for (const extra of [
    { cwd: '/fake-root' },
    { branch: 'main' },
    { baseOid: 'a'.repeat(40) },
    { authority: { allowed: true } },
  ])
    expect(
      protocol.OrdinaryWorkspaceFirstCommandSchema.safeParse({ ...command, ...extra }).success,
    ).toBe(false);
  expect(
    protocol.OrdinaryWorkspaceFirstCommandSchema.safeParse({
      ...command,
      workspace: { kind: 'repository', workspaceId: randomUUID() },
    }).success,
  ).toBe(false);
  expect(
    protocol.OrdinaryWorkspaceFirstCommandSchema.safeParse({
      ...command,
      runtime: { ...runtime, mode: 'ask' },
    }).success,
  ).toBe(false);
  expect(
    protocol.OrdinaryWorkspaceFirstCommandSchema.safeParse({
      ...command,
      payload: { text: 'a'.repeat(1048577) },
    }).success,
  ).toBe(false);
});
it('publishes silent opaque preparation intent/receipt with no credential, path or client capability grant', () => {
  const request = {
    version: 1,
    runOn: 'local',
    model: 'fixture-model',
    runtime: { account, harness: 'codex', targetId: 'offline-local' },
  };
  expect(protocol.OrdinaryWorkspacePreparationRequestSchema.parse(request)).toEqual(request);
  const receipt = {
    version: 1,
    kind: 'ordinary',
    preparationId: randomUUID(),
    runtimeBinding: {
      version: 2,
      account,
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'offline-local', targetRevision: 't1' },
    },
    capabilities: [
      'ordinary_conversation',
      'writable_files',
      'retained_artifacts',
      'task_execution',
    ],
  };
  expect(protocol.OrdinaryWorkspacePreparationReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(
    protocol.OrdinaryWorkspacePreparationReceiptSchema.safeParse({
      ...receipt,
      credentialDigest: 'secret',
    }).success,
  ).toBe(false);
  expect(
    protocol.OrdinaryWorkspacePreparationReceiptSchema.safeParse({
      ...receipt,
      directory: '/private-root',
    }).success,
  ).toBe(false);
  expect(
    protocol.OrdinaryWorkspacePreparationRequestSchema.safeParse({
      ...request,
      capabilities: ['git_revision'],
    }).success,
  ).toBe(false);
});
