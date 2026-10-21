import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationSourceCatalog } from '../collaboration-source-catalog.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { revokeAuthSession } from '../auth.js';
import {
  fixture,
  cleanupApplicationReviewFixtures,
} from './fixtures/collaboration-application-review.js';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
afterEach(cleanupApplicationReviewFixtures);
it('catalogs exact retained origin revisions and visible references without content reads or session creation', async () => {
  const f = await fixture();
  const retained = createCollaborationRetainedArtifactFixture();
  try {
    const r1 = retained.store.save({
      itemId: retained.itemId,
      filename: ' plan.md',
      title: ' Plan ',
      bytes: Buffer.from('first'),
      sessionId: 'source',
    });
    const r2 = retained.store.save({
      itemId: retained.itemId,
      filename: ' plan.md',
      title: ' Plan ',
      bytes: Buffer.from('second'),
      sessionId: 'editor',
    });
    retained.store.save({
      itemId: retained.itemId,
      filename: ' plan.md',
      title: ' Plan ',
      bytes: Buffer.from('latest'),
      sessionId: 'editor',
    });
    const bytes = vi.spyOn(TelosArtifactStore.prototype, 'readBoundedRevision');
    const owner = new CollaborationSourceCatalog({
      store: f.store,
      openArtifacts: () => TelosArtifactStore.openReadOnly(retained.path),
      repositoryIntent: () => {
        throw Error('No repository claim expected');
      },
    });
    const query = { sourceConversationId: 'source', clientId: f.connectionId };
    const result = await owner.read(f.auth, query, f.controller.signal);
    expect(result.artifacts).toMatchObject([
      {
        kind: 'retainedArtifactVersion',
        revision: 1,
        title: ' Plan ',
        filename: ' plan.md',
        provenance: { sessionId: 'source' },
      },
    ]);
    expect(result.sourceRepository).toBeNull();
    expect(result.retainedAvailability).toBe('available');
    const versions = await owner.versions(
      f.auth,
      {
        ...query,
        boundary: result.boundary,
        artifact: {
          kind: 'retainedArtifactVersion',
          artifactId: r1.id,
          revision: r1.revision,
          sha256: r1.sha256,
        },
        beforeRevision: 3,
        limit: 1,
      },
      f.controller.signal,
    );
    expect(versions.artifacts.map((v) => [v.revision, v.sha256])).toEqual([[2, r2.sha256]]);
    expect(versions).toMatchObject({ hasMore: true, cursor: 2 });
    expect(bytes).not.toHaveBeenCalled();
    expect(f.store.listSessions()).toHaveLength(1);
    expect(f.store.collaborationConversation.view(f.group).joins).toEqual([]);
  } finally {
    retained.close();
  }
});
it('reports unavailable retention honestly and refuses caller supplied grants', async () => {
  const f = await fixture();
  const owner = new CollaborationSourceCatalog({
    store: f.store,
    openArtifacts: () => undefined,
    repositoryIntent: () => null,
  });
  const query = { sourceConversationId: 'source', clientId: f.connectionId };
  expect(await owner.read(f.auth, query, f.controller.signal)).toMatchObject({
    retainedAvailability: 'unavailable',
    artifacts: [],
    sourceRepository: null,
  });
  await expect(
    owner.read(f.auth, { ...query, allowed: true }, f.controller.signal),
  ).rejects.toThrow();
});
it('refuses revoked transport, hidden sources and unrelated retained version seeds', async () => {
  const f = await fixture();
  const retained = createCollaborationRetainedArtifactFixture();
  try {
    const unrelated = retained.store.save({
      itemId: retained.itemId,
      filename: 'unrelated.md',
      title: 'Other',
      bytes: Buffer.from('secret'),
      sessionId: 'another-chat',
    });
    const owner = new CollaborationSourceCatalog({
      store: f.store,
      openArtifacts: () => TelosArtifactStore.openReadOnly(retained.path),
      repositoryIntent: () => null,
    });
    const query = { sourceConversationId: 'source', clientId: f.connectionId };
    const result = await owner.read(f.auth, query, f.controller.signal);
    await expect(
      owner.versions(
        f.auth,
        {
          ...query,
          boundary: result.boundary,
          artifact: {
            kind: 'retainedArtifactVersion',
            artifactId: unrelated.id,
            revision: 1,
            sha256: unrelated.sha256,
          },
        },
        f.controller.signal,
      ),
    ).rejects.toThrow();
    f.store.hideSession('source');
    await expect(owner.read(f.auth, query, f.controller.signal)).rejects.toThrow();
    revokeAuthSession(f.auth);
    await expect(owner.read(f.auth, query, f.controller.signal)).rejects.toThrow();
  } finally {
    retained.close();
  }
});
it('uses exact visible references and reports unversioned links without substituting latest', async () => {
  const f = await fixture();
  const retained = createCollaborationRetainedArtifactFixture();
  try {
    const first = retained.store.save({
      itemId: retained.itemId,
      filename: 'plan.md',
      title: 'Plan',
      bytes: Buffer.from('first'),
      sessionId: 'other',
    });
    const second = retained.store.save({
      itemId: retained.itemId,
      filename: 'plan.md',
      title: 'Plan',
      bytes: Buffer.from('second'),
      sessionId: 'other',
    });
    f.store.append('source', 'user_message', {
      messageId: 'links',
      text: `[Exact](/api/telos/artifacts/${first.id}?revision=1) [Unversioned](/api/telos/artifacts/${second.id})`,
    });
    const owner = new CollaborationSourceCatalog({
      store: f.store,
      openArtifacts: () => TelosArtifactStore.openReadOnly(retained.path),
      repositoryIntent: () => null,
    });
    const result = await owner.read(
      f.auth,
      { sourceConversationId: 'source', clientId: f.connectionId },
      f.controller.signal,
    );
    expect(result.artifacts.map((a) => a.revision)).toEqual([1]);
    expect(result.unversionedRetainedReferences).toBe(true);
  } finally {
    retained.close();
  }
});
it('mounts strict same-origin observations behind real operator and transport authorization', async () => {
  const f = await fixture();
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createSessionCollaborationRouter } = await import('../session-collaboration-router.js');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header('x-test-operator') === 'yes') res.locals.authSession = f.auth;
    next();
  });
  app.use(
    '/api/session-collaborations',
    createSessionCollaborationRouter({
      store: f.store,
      catalog: () =>
        new CollaborationSourceCatalog({
          store: f.store,
          openArtifacts: () => undefined,
          repositoryIntent: () => null,
        }),
    }),
  );
  const input = { sourceConversationId: 'source', clientId: f.connectionId };
  const url = '/api/session-collaborations/source-catalog';
  expect((await request(app).post(url).send(input)).status).toBe(401);
  expect(
    (
      await request(app)
        .post(url)
        .set('x-test-operator', 'yes')
        .set('origin', 'https://foreign.invalid')
        .send(input)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post(url)
        .set('x-test-operator', 'yes')
        .send({ ...input, ready: true })
    ).status,
  ).toBe(400);
  const response = await request(app).post(url).set('x-test-operator', 'yes').send(input);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.body).toMatchObject({
    sourceConversationId: 'source',
    retainedAvailability: 'unavailable',
  });
  const unavailable = await request(app)
    .post(url)
    .set('x-test-operator', 'yes')
    .send({ ...input, clientId: 'foreign' });
  expect(unavailable.status).toBe(503);
  expect(f.store.listSessions()).toHaveLength(1);
});
it('pages actual source origin metadata without truncation or implicit latest revisions', async () => {
  const f = await fixture();
  const retained = createCollaborationRetainedArtifactFixture();
  try {
    for (let n = 0; n < 101; n++)
      retained.store.save({
        itemId: retained.itemId,
        filename: `plan-${n}.md`,
        title: `Plan ${n}`,
        bytes: Buffer.from('text'),
        sessionId: 'source',
      });
    const owner = new CollaborationSourceCatalog({
      store: f.store,
      openArtifacts: () => TelosArtifactStore.openReadOnly(retained.path),
      repositoryIntent: () => null,
    });
    const query = { sourceConversationId: 'source', clientId: f.connectionId };
    const first = await owner.read(f.auth, query, f.controller.signal);
    expect(first.artifacts).toHaveLength(100);
    expect(first.artifactHasMore).toBe(true);
    expect(first.artifactCursor).not.toBeNull();
    const second = await owner.read(
      f.auth,
      { ...query, artifactsAfter: first.artifactCursor },
      f.controller.signal,
    );
    expect(second.artifacts).toHaveLength(1);
    expect(second.artifactHasMore).toBe(false);
    expect(second.artifactCursor).toBeNull();
    expect(new Set([...first.artifacts, ...second.artifacts].map((a) => a.artifactId)).size).toBe(
      101,
    );
  } finally {
    retained.close();
  }
});
