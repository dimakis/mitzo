import { vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { EventStore } from '../../event-store.js';
import type { createApplicationJourney } from './symposium-application-journey.js';

export function specialistArtifact(events: EventStore, content: string) {
  const messageId = randomUUID();
  const blockId = randomUUID();
  events.append('existing-chat', 'message_start', { messageId, role: 'assistant' });
  events.append('existing-chat', 'block_start', { messageId, blockId, blockType: 'text' });
  events.append('existing-chat', 'block_delta', { messageId, blockId, delta: content });
  events.append('existing-chat', 'block_end', { messageId, blockId, blockType: 'text' });
  const messageEndSeq = events.append('existing-chat', 'message_end', { messageId });
  const sha256 = createHash('sha256').update(content).digest('hex');
  const output = events.registerSessionOutput('existing-chat', {
    requestId: randomUUID(),
    title: 'Selected specialist evidence',
    source: { messageId, blockId, messageEndSeq, sha256 },
  });
  return { artifactId: output.outputId, revision: output.revision, sha256 };
}
export async function specialistAuthorizationFixture(
  journey: ReturnType<typeof createApplicationJourney>,
  role = 'authorization-reviewer',
) {
  const h = await journey.getApplicationUiJourney();
  const { getSpecialistConsultations } = await import('../../specialist-consultation-runtime.js');
  const { captureAgentLibraryAuthorization } = await import('../../agent-library-transport.js');
  const { getAgentLibrary } = await import('../../agent-library-runtime.js');
  const captured = captureAgentLibraryAuthorization(h.clientId);
  (await import('../../auth.js')).setAuthRevocationStore(h.events);
  const authority = {
    leadSessionId: 'existing-chat',
    operatorConnectionId: h.clientId,
    auth: captured.auth,
    signal: new AbortController().signal,
    assertCurrent: () => captured.assertCurrent(),
  };
  const library = getAgentLibrary();
  if (!library.version('user', role, 1)) {
    library.saveDraft('user', {
      profileId: role,
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: `draft-${role}`,
      definition: {
        name: role,
        role,
        modelPolicyRole: role,
        instructions: 'Review the bounded assignment.',
        expectedOutput: 'Evidence',
        acceptanceCriteria: ['Cite evidence'],
      },
    });
    library.publish('user', {
      profileId: role,
      expectedVersion: 1,
      idempotencyKey: `publish-${role}`,
    });
  }
  const view = await h.api.view(h.group);
  for (const policy of view.policies.filter((p) => p.readsFutureDiscussion))
    await h.api.setPolicy(h.group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedRevision: policy.revision,
      sessionId: policy.sessionId,
      readsFutureDiscussion: false,
      repliesByDefault: false,
    });
  const service = getSpecialistConsultations();
  const catalog = await service.catalog(authority);
  const input = {
    requestId: crypto.randomUUID(),
    connectionId: catalog.repositories[0].connectionId,
    repository: 'example/acceptance',
    durationMinutes: 10,
    routes: [
      {
        role,
        accountId: 'offline-personal',
        model: 'fixture-model',
        reasoningEffort: 'low',
        runOn: 'local',
        targetId: 'offline-observation',
      },
    ],
  };
  const approve = vi.fn(async (_display: Record<string, unknown>) => true);
  return { h, service, authority, input, approve };
}
