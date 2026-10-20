import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '@mitzo/protocol/event-store';

// This boundary uses only the real protocol EventStore and private temporary files.
// No server auth/token loader, Git source, native process or provider is imported.
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const account = {
  accountId: 'offline-account',
  accountLabel: 'Offline fixture',
  provider: 'openai-codex' as const,
  profileRevision: 'r1',
  model: 'fixture-model',
};
const binding = {
  version: 2 as const,
  account: {
    accountId: account.accountId,
    provider: account.provider,
    profileRevision: account.profileRevision,
  },
  harness: { implementation: 'codex' as const },
  execution: { location: 'local' as const, targetId: 'offline-local', targetRevision: 'r1' },
};
const selection = {
  version: 1 as const,
  agent: { profileId: 'offline-agent', revision: 1 },
  context: { source: 'none' as const, revision: null },
  permission: { mode: 'agent' as const, revision: 0 },
  model: account.model,
  thinking: null,
};
const definition = {
  name: 'Ordinary agent',
  descriptor: 'Fixture',
  role: 'agent' as const,
  instructions: 'Retain output',
  expectedOutput: 'Report',
  acceptanceCriteria: ['Evidence'],
  modelPolicyRole: 'agent' as const,
};
const agentProfile = {
  profileId: selection.agent.profileId,
  revision: 1,
  definition,
  contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordinary-session-v2-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'ordinary-files');
  mkdirSync(cwd, { mode: 0o700 });
  const path = join(root, 'events.db');
  let events = new EventStore(path);
  cleanup.push(() => events.close());
  const workspaceId = randomUUID(),
    sessionId = 'ordinary-session-' + randomUUID();
  const settings = {
    version: 2 as const,
    binding,
    selection,
    workspace: { kind: 'ordinary' as const, preparationId: randomUUID() },
  };
  const meta = {
    sessionId,
    ordinaryWorkspaceId: workspaceId,
    cwd,
    accountBinding: account,
    agentProfile,
    selectedModel: account.model,
    reasoningEffort: null,
    mode: 'agent' as const,
  };
  const input = {
    allocationOperationId: randomUUID(),
    preparationFingerprint: 'a'.repeat(64),
    settings,
  };
  return {
    root,
    cwd,
    workspaceId,
    meta,
    input,
    get events() {
      return events;
    },
    reopen() {
      events.close();
      events = new EventStore(path);
    },
  };
}

it('retains a strict ordinary V2 preparation with its real workspace kind and creates no command or event', () => {
  const f = fixture();
  const receipt = f.events.prepareOrdinaryWorkspaceSession(f.meta, f.input);
  expect(receipt).toEqual({
    version: 2,
    allocationOperationId: f.input.allocationOperationId,
    sessionId: f.meta.sessionId,
    workspaceKind: 'ordinary',
    workspaceId: f.workspaceId,
    settings: f.input.settings,
    preparationFingerprint: f.input.preparationFingerprint,
    firstCommandId: null,
  });
  expect(f.events.getSession(f.meta.sessionId)).toMatchObject({
    ordinaryWorkspaceId: f.workspaceId,
    cwd: f.cwd,
  });
  expect(f.events.getSession(f.meta.sessionId)).not.toHaveProperty('repositoryWorkspaceId');
  expect(f.events.getSessionRuntimeBinding(f.meta.sessionId)).toEqual(binding);
  expect(f.events.getSessionEvents(f.meta.sessionId)).toEqual([]);
  expect(f.events.getOrdinaryInitialCommandId(f.meta.sessionId)).toBeUndefined();
  expect(f.events.getSendCommand(f.input.allocationOperationId)).toBeUndefined();
  expect(f.events.getOrdinarySessionPreparation(f.input.allocationOperationId)).toBeUndefined();
  expect(f.events.getOrdinaryConversationSettings(f.meta.sessionId)).toBeUndefined();
  expect(f.events.getOrdinaryWorkspaceConversationSettings(f.meta.sessionId)).toEqual(
    f.input.settings,
  );
});

it('reopens and replays exact V2 metadata while refusing changed workspace, cwd, account or intent', () => {
  const f = fixture();
  const original = f.events.prepareOrdinaryWorkspaceSession(f.meta, f.input);
  f.reopen();
  expect(f.events.prepareOrdinaryWorkspaceSession(f.meta, f.input)).toEqual(original);
  for (const changed of [
    { ordinaryWorkspaceId: randomUUID() },
    { cwd: join(f.root, 'replacement') },
    { accountBinding: { ...account, accountId: 'other' } },
  ]) {
    expect(() =>
      f.events.prepareOrdinaryWorkspaceSession({ ...f.meta, ...changed }, f.input),
    ).toThrow();
  }
  expect(() =>
    f.events.prepareOrdinaryWorkspaceSession(f.meta, {
      ...f.input,
      settings: { ...f.input.settings, selection: { ...selection, thinking: 'high' } },
    }),
  ).toThrow();
  expect(f.events.getOrdinaryWorkspaceSessionPreparation(f.input.allocationOperationId)).toEqual(
    original,
  );
  expect(f.events.getSession(f.meta.sessionId)).toMatchObject({
    ordinaryWorkspaceId: f.workspaceId,
    cwd: f.cwd,
  });
});

it('refuses mixed or unsupported workspace metadata and freezes the ordinary kind through upsert', () => {
  const f = fixture();
  expect(() =>
    f.events.prepareOrdinaryWorkspaceSession(
      { ...f.meta, repositoryWorkspaceId: randomUUID() },
      f.input,
    ),
  ).toThrow();
  expect(f.events.getSession(f.meta.sessionId)).toBeNull();
  const unsupported = {
    ...binding,
    execution: { ...binding.execution, location: 'openshell' as const },
  };
  expect(() =>
    f.events.prepareOrdinaryWorkspaceSession(f.meta, {
      ...f.input,
      settings: { ...f.input.settings, binding: unsupported },
    }),
  ).toThrow();
  expect(f.events.getSession(f.meta.sessionId)).toBeNull();
  f.events.prepareOrdinaryWorkspaceSession(f.meta, f.input);
  for (const changed of [
    { ordinaryWorkspaceId: null },
    { ordinaryWorkspaceId: randomUUID() },
    { repositoryWorkspaceId: randomUUID() },
    { cwd: join(f.root, 'replacement') },
  ]) {
    expect(() => f.events.upsertSession({ sessionId: f.meta.sessionId, ...changed })).toThrow();
  }
  expect(f.events.getSessionRuntimeBinding(f.meta.sessionId)).toEqual(binding);
});

it('admits the explicit first command through existing ledgers exactly once and never projects it as a repository', () => {
  const f = fixture();
  f.events.prepareOrdinaryWorkspaceSession(f.meta, f.input);
  const command = {
    clientMsgId: randomUUID(),
    requestFingerprint: 'original-command',
    selection,
    payload: { text: 'Retain a report' },
  };
  const first = f.events.admitPreparedOrdinaryWorkspaceCommand(
    f.input.allocationOperationId,
    f.meta,
    binding,
    command,
  );
  expect(first.duplicate).toBe(false);
  expect(first.admission.workspace).toEqual({ workspaceId: f.workspaceId, cwd: f.cwd });
  expect(f.events.getSendCommand(command.clientMsgId)?.sessionId).toBe(f.meta.sessionId);
  expect(
    f.events.getOrdinaryWorkspaceSessionPreparation(f.input.allocationOperationId)?.firstCommandId,
  ).toBe(command.clientMsgId);
  expect(f.events.getOrdinaryConversationSettings(f.meta.sessionId)).toBeUndefined();
  expect(f.events.getOrdinaryWorkspaceConversationSettings(f.meta.sessionId)).toEqual(
    f.input.settings,
  );
  f.reopen();
  expect(
    f.events.admitPreparedOrdinaryWorkspaceCommand(
      f.input.allocationOperationId,
      f.meta,
      binding,
      command,
    ).duplicate,
  ).toBe(true);
  expect(() =>
    f.events.admitPreparedOrdinaryWorkspaceCommand(f.input.allocationOperationId, f.meta, binding, {
      ...command,
      payload: { text: 'Changed input' },
    }),
  ).toThrow();
  const replacement = { ...command, clientMsgId: randomUUID() };
  expect(() =>
    f.events.admitPreparedOrdinaryWorkspaceCommand(
      f.input.allocationOperationId,
      f.meta,
      binding,
      replacement,
    ),
  ).toThrow();
  expect(f.events.getSendCommand(replacement.clientMsgId)).toBeUndefined();
  expect(
    f.events.getOrdinaryWorkspaceSessionPreparation(f.input.allocationOperationId)?.firstCommandId,
  ).toBe(command.clientMsgId);
});

it('refuses direct unprepared local admission of ordinary metadata before durable session or command effects', () => {
  const f = fixture();
  const command = {
    clientMsgId: randomUUID(),
    requestFingerprint: 'unprepared',
    selection,
    payload: { text: 'Never dispatch' },
  };
  expect(() => f.events.admitOrdinaryLocalCommand(f.meta, binding, command)).toThrow();
  expect(f.events.getSession(f.meta.sessionId)).toBeNull();
  expect(f.events.getSendCommand(command.clientMsgId)).toBeUndefined();
});

it('keeps the legacy V1 preparation body and getters unchanged beside the new kind', () => {
  const f = fixture();
  const meta = {
    ...f.meta,
    ordinaryWorkspaceId: undefined,
    sessionId: 'legacy-session',
    repositoryWorkspaceId: 'legacy-workspace',
  };
  const settings = { binding, selection, repositoryWorkspaceId: meta.repositoryWorkspaceId };
  const input = {
    allocationOperationId: 'legacy-operation',
    preparationFingerprint: 'b'.repeat(64),
    settings,
  };
  const receipt = f.events.prepareOrdinarySession(meta, input);
  const expected = {
    version: 1,
    allocationOperationId: input.allocationOperationId,
    sessionId: meta.sessionId,
    workspaceId: meta.repositoryWorkspaceId,
    settings,
    preparationFingerprint: input.preparationFingerprint,
    firstCommandId: null,
  };
  expect(JSON.stringify(receipt)).toBe(JSON.stringify(expected));
  expect(f.events.getOrdinaryConversationSettings(meta.sessionId)).toEqual(settings);
  expect(f.events.getOrdinarySessionPreparation(input.allocationOperationId)).toEqual(receipt);
});

it('does not let a legacy joining allocation manufacture a repository identity from an ordinary command', () => {
  const f = fixture();
  f.events.upsertSession({ sessionId: 'legacy-source' });
  const group = randomUUID();
  const collaboration = f.events.collaborationConversation;
  collaboration.begin(group, { requestId: randomUUID(), sessionId: 'legacy-source' });
  const fakeRepositorySettings = { binding, selection, repositoryWorkspaceId: f.workspaceId };
  // Synthetic capacity at the existing trusted compiler port; no native/model call.
  const snapshot = collaboration.saveSnapshot(group, {
    requestId: randomUUID(),
    sourceConversationId: 'legacy-source',
    boundary: { sequence: 0, messageId: null },
    mode: 'selected',
    purpose: 'Legacy compatibility refusal',
    joiningBrief: 'Must not adopt ordinary custody',
    messages: [],
    artifacts: [],
    summary: null,
    capacity: {
      status: 'ready',
      assessments: [
        {
          settings: fakeRepositorySettings,
          availableTokens: 100,
          estimatedTokens: 10,
          estimatorRevision: 'offline-fixture',
        },
      ],
    },
  });
  const joining = collaboration.prepareJoin(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'Unrelated legacy join',
    settings: fakeRepositorySettings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  });
  f.events.prepareOrdinaryWorkspaceSession(f.meta, f.input);
  f.events.admitPreparedOrdinaryWorkspaceCommand(f.input.allocationOperationId, f.meta, binding, {
    clientMsgId: joining.allocationOperationId,
    requestFingerprint: 'ordinary-not-legacy',
    selection,
    payload: { text: 'Ordinary explicit command' },
  });
  expect(() =>
    collaboration.recordAllocation(group, joining.joinId, {
      operationId: joining.allocationOperationId,
      sessionId: f.meta.sessionId,
      settings: fakeRepositorySettings,
    }),
  ).toThrow(/allocation_conflict/);
  expect(collaboration.getJoin(group, joining.joinId)).toMatchObject({
    state: 'pending_preparation',
    sessionId: null,
  });
  expect(f.events.getSession(f.meta.sessionId)).not.toHaveProperty('repositoryWorkspaceId');
});
