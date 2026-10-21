import { expect, it, vi } from 'vitest';
import { CollaborationApiClient } from '../collaboration-api.js';
const digest = 'a'.repeat(64);
const boundary = { sequence: 1, messageId: 'question' };
const message = {
  conversationId: 'source',
  messageId: 'question',
  sequence: 1,
  author: 'operator',
  source: null,
  blocks: [{ blockId: 'text', content: 'Hello', sha256: digest }],
};
const catalog = {
  sourceConversationId: 'source',
  boundary,
  messages: [message],
  artifacts: [],
  artifactCursor: null,
  artifactHasMore: false,
  retainedAvailability: 'unavailable',
  unversionedRetainedReferences: false,
  sourceRepository: { repository: 'example/repo' },
};
it('uses a cancellable explicit observation with source and live transport selectors only', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog)));
  const signal = new AbortController().signal;
  const input = { sourceConversationId: 'source', clientId: 'live' };
  expect(await new CollaborationApiClient(fetch).sourceCatalog(input, signal)).toEqual(catalog);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/session-collaborations/source-catalog', {
    credentials: 'include',
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
});
it.each([
  { ...catalog, sourceConversationId: 'foreign' },
  { ...catalog, boundary: { ...boundary, messageId: 'foreign' } },
  { ...catalog, artifactHasMore: true },
  { ...catalog, ready: true },
])('refuses foreign, contradictory or invented catalog state', async (value) => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value)));
  await expect(
    new CollaborationApiClient(fetch).sourceCatalog({
      sourceConversationId: 'source',
      clientId: 'live',
    }),
  ).rejects.toThrow();
});
it('rejects a version response for another artifact even with valid public metadata', async () => {
  const artifact = {
    kind: 'retainedArtifactVersion' as const,
    artifactId: 'a'.repeat(32),
    revision: 2,
    sha256: digest,
  };
  const value = {
    sourceConversationId: 'source',
    boundary,
    artifacts: [
      {
        ...artifact,
        artifactId: 'b'.repeat(32),
        retention: 'independent',
        itemId: 'c'.repeat(16),
        filename: 'plan.md',
        title: 'Plan',
        provenance: { sessionId: 'origin', sourceKind: 'session_artifact', sourcePath: null },
        mediaType: 'application/octet-stream',
        sizeBytes: 2,
      },
    ],
    hasMore: false,
    cursor: null,
  };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value)));
  await expect(
    new CollaborationApiClient(fetch).sourceArtifactVersions({
      sourceConversationId: 'source',
      clientId: 'live',
      boundary,
      artifact,
    }),
  ).rejects.toThrow();
});
