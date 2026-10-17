import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  createAcceptanceFixture,
  cleanupAcceptanceFixtures,
} from '../../server/__tests__/fixtures/symposium-acceptance.js';
import { createCollaborationRetainedArtifactFixture } from '../../server/__tests__/fixtures/collaboration-retained-artifacts.js';
import { createRetainedCollaborationArtifactSource } from '../../server/collaboration-retained-artifact-source.js';
import { createCollaborationContextSource } from '../../server/collaboration-context-source.js';
import { prepareCollaborationForward } from '../../server/collaboration-forwarding.js';

const artifacts: ReturnType<typeof createCollaborationRetainedArtifactFixture>[] = [];
afterEach(() => {
  cleanupAcceptanceFixtures();
  for (const item of artifacts.splice(0)) item.close();
});

async function reviewedHandoff() {
  const f = createAcceptanceFixture();
  const retained = createCollaborationRetainedArtifactFixture();
  artifacts.push(retained);
  const bytes = Buffer.from('  Reviewed older\r\nπ artifact bytes\t');
  const older = retained.store.save({
    itemId: retained.itemId,
    filename: 'review.md',
    title: 'Reviewed artifact',
    bytes,
    sessionId: 'removed-original-session',
    requestId: 'save-original',
  });
  retained.store.save({
    itemId: retained.itemId,
    filename: 'review.md',
    title: 'Reviewed artifact',
    bytes: Buffer.from('Latest unreviewed edit'),
    sessionId: 'removed-original-session',
    requestId: 'save-later',
  });
  retained.restart();
  let allowed = true;
  const handoff = await prepareCollaborationForward(
    {
      requestId: randomUUID(),
      sourceConversationId: 'architect',
      boundary: { sequence: 0, messageId: null },
      messages: [],
      target: { collaborationId: f.group, expectedMembershipRevision: 1, sessionIds: ['reviewer'] },
      artifacts: [
        {
          kind: 'retained_artifact',
          artifactId: older.id,
          revision: older.revision,
          sha256: older.sha256,
        },
      ],
    },
    {
      source: createCollaborationContextSource({
        store: f.store,
        authorizeConversation: async () => {},
      }),
      retainedArtifacts: createRetainedCollaborationArtifactSource({
        store: retained.store,
        authorizeArtifact: async () => {
          if (!allowed) throw Error('Artifact access revoked');
        },
      }),
      authorizeTarget: async (target) => {
        expect(target.sessionIds).toEqual(['reviewer']);
        expect(f.store.getSessionCollaboration(target.collaborationId)?.revision).toBe(
          target.expectedMembershipRevision,
        );
      },
    },
  );
  return {
    f,
    retained,
    bytes,
    older,
    handoff,
    revoke: () => {
      allowed = false;
    },
  };
}

it('carries the reviewed saved version and provenance unchanged through ordinary context serialization to its intended recipient', async () => {
  const { f, retained, bytes, older, handoff } = await reviewedHandoff();
  expect(f.store.getSession('removed-original-session')).toBeNull();
  retained.store.save({
    itemId: retained.itemId,
    filename: 'review.md',
    title: 'Reviewed artifact',
    bytes: Buffer.from('Another edit after review'),
    sessionId: 'removed-original-session',
    requestId: 'save-after-review',
  });
  const runtime = f.runtime('reviewer', [], handoff.serialized, () => handoff.assertCurrent());
  await runtime.driver.initialize();
  expect(f.samplingRequests()).toEqual([]);
  await runtime.driver.send({
    id: 'initial-reviewer',
    prompt: 'Review the selected saved version explicitly',
  });
  const turn = runtime.requests.find((row) => row.method === 'turn/start')!.params as {
    additionalContext: Record<string, { value: string }>;
  };
  const context = Object.values(turn.additionalContext)
    .map((fragment) => fragment.value)
    .join('');
  expect(context).toBe(handoff.serialized);
  const packet = JSON.parse(context);
  expect(packet.target.sessionIds).toEqual(['reviewer']);
  expect(packet.artifacts[0]).toMatchObject({
    artifactId: older.id,
    revision: 1,
    sha256: older.sha256,
    retention: 'independent',
    provenance: { sessionId: 'removed-original-session' },
  });
  expect(Buffer.from(packet.artifacts[0].contentBase64, 'base64')).toEqual(bytes);
  expect(context).not.toContain('Latest unreviewed edit');
  expect(context).not.toContain('Another edit after review');
  expect(f.samplingRequests()).toHaveLength(1);
});

it('renews retained artifact access at the ordinary pre-dispatch barrier without sending when access changed', async () => {
  const { f, handoff, revoke } = await reviewedHandoff();
  const runtime = f.runtime('reviewer', [], handoff.serialized, () => handoff.assertCurrent());
  await runtime.driver.initialize();
  revoke();
  await expect(
    runtime.driver.send({ id: 'initial-reviewer', prompt: 'Explicit request' }),
  ).rejects.toThrow('Artifact access revoked');
  expect(f.samplingRequests()).toEqual([]);
});
