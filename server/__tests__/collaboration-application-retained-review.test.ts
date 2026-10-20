import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApplicationReview } from '../collaboration-application-review.js';
import {
  fixture,
  cleanupApplicationReviewFixtures,
} from './fixtures/collaboration-application-review.js';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';
import Database from 'better-sqlite3';
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
afterEach(cleanupApplicationReviewFixtures);
it('reviews and recovers an exact independent revision through actual kind-aware labels and current privacy', async () => {
  const f = await fixture();
  const retained = createCollaborationRetainedArtifactFixture();
  try {
    retained.store.save({
      itemId: retained.itemId,
      filename: ' plan.md',
      title: ' Plan ',
      bytes: Buffer.from('first'),
      sessionId: 'source',
    });
    const second = retained.store.save({
      itemId: retained.itemId,
      filename: ' plan.md',
      title: ' Plan ',
      bytes: Buffer.from('exact second'),
      sessionId: 'hidden-origin',
    });
    retained.store.save({
      itemId: retained.itemId,
      filename: ' plan.md',
      title: ' Plan ',
      bytes: Buffer.from('latest'),
      sessionId: 'editor',
    });
    const owner = new CollaborationApplicationReview({
      store: f.store,
      workspaces: f.workspaces,
      retainedArtifacts: retained.store,
    });
    const input = {
      ...f.input,
      selection: {
        ...f.input.selection,
        mode: 'selected',
        messageIds: [],
        artifacts: [
          {
            kind: 'retainedArtifactVersion',
            artifactId: second.id,
            revision: second.revision,
            sha256: second.sha256,
          },
        ],
      },
    };
    const review = () => owner.review(f.auth, f.connectionId, f.group, input, f.controller.signal);
    const result = await review();
    expect(result.snapshot.artifacts).toMatchObject([
      {
        kind: 'retainedArtifactVersion',
        revision: 2,
        contentBase64: Buffer.from('exact second').toString('base64'),
        provenance: { sessionId: 'hidden-origin' },
      },
    ]);
    expect(result.artifactLabels).toEqual([
      {
        kind: 'retainedArtifactVersion',
        artifactId: second.id,
        revision: 2,
        sha256: second.sha256,
        filename: ' plan.md',
        title: ' Plan ',
      },
    ]);
    expect(await review()).toEqual(result);
    const db = new Database(retained.path);
    db.prepare("UPDATE items SET profile='lifeops' WHERE id=?").run(retained.itemId);
    db.close();
    await expect(review()).rejects.toThrow();
    expect(f.store.listSessions()).toHaveLength(1);
    expect(result.snapshot.capacity.status).toBe('unverified');
  } finally {
    retained.close();
  }
});
