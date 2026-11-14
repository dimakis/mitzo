import { randomUUID } from 'node:crypto';
import type { EventStore } from '@mitzo/protocol/event-store';

export const settings = {
  binding: {
    version: 2,
    account: { accountId: 'fixture', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  selection: {
    version: 1,
    agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  },
  repositoryWorkspaceId: 'workspace',
} as const;

export function begin(store: EventStore, source = 'source') {
  store.upsertSession({
    sessionId: source,
    conversationSource: 'mitzo',
    summary: 'Original conversation',
    numTurns: 1,
  });
  const group = randomUUID();
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: source });
  return group;
}

export function joinParticipant(
  store: EventStore,
  group: string,
  sessionId = 'peer',
  state: 'pending' | 'allocated' | 'linked' = 'linked',
  source = 'source',
) {
  const participantSettings = { ...settings, repositoryWorkspaceId: `workspace-${sessionId}` };
  const snapshot = store.collaborationConversation.saveSnapshot(group, {
    requestId: randomUUID(),
    sourceConversationId: source,
    boundary: { sequence: 0, messageId: 'm0' },
    mode: 'selected',
    purpose: 'Review',
    joiningBrief: 'Check edges',
    messages: [],
    artifacts: [],
    summary: null,
    capacity: {
      status: 'ready',
      assessments: [
        {
          settings: participantSettings,
          availableTokens: 1000,
          estimatedTokens: 80,
          estimatorRevision: 'fixture-v1',
        },
      ],
    },
  });
  const revision = store.getSessionCollaboration(group)!.revision;
  const pending = store.collaborationConversation.prepareJoin(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: revision,
    name: 'Reviewer',
    settings: participantSettings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  });
  if (state === 'pending') return pending;
  store.prepareOrdinarySession(
    {
      sessionId,
      repositoryWorkspaceId: participantSettings.repositoryWorkspaceId,
      cwd: '/synthetic-task',
      accountBinding: {
        ...settings.binding.account,
        accountLabel: 'Fixture',
        model: settings.selection.model,
      },
      selectedModel: settings.selection.model,
      reasoningEffort: null,
      mode: 'agent',
    },
    {
      allocationOperationId: pending.allocationOperationId,
      preparationFingerprint: 'a'.repeat(64),
      settings: participantSettings,
    },
  );
  const allocated = store.collaborationConversation.recordAllocation(group, pending.joinId, {
    operationId: pending.allocationOperationId,
    sessionId,
    settings: participantSettings,
  });
  return state === 'allocated'
    ? allocated
    : store.collaborationConversation.linkJoin(group, pending.joinId, revision);
}
