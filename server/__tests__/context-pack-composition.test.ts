import { expect, it } from 'vitest';
import { ContextPackStore } from '../context-pack-store.js';
import { contextPackRouterDependencies } from '../context-pack-composition.js';
import { selectCustodianOperation, custodianRoute } from '../symposium-custodian-protocol.js';

it('previews an unpublished pack from the accepted source without publishing a revision', async () => {
  const contextPacks = new ContextPackStore(':memory:');
  try {
    const definition = {
      version: 1 as const,
      id: 'review',
      name: 'Review',
      description: '',
      tokenBudget: 1000,
      documents: [
        {
          path: 'review.md',
          revision: 'a'.repeat(40),
          mode: 'required' as const,
          headings: [],
          priority: 100,
        },
      ],
      retrievalGuidance: 'Read deeper evidence when needed.',
    };
    const runtime = {
      contextPacks,
      sourceIdentity: 'github:owner/knowledge@main',
      source: {
        allowed: () => true,
        read: async (path: string, revision: string) => ({
          path,
          revision,
          content: '# Review\nChallenge assumptions.',
        }),
      },
    };
    const deps = contextPackRouterDependencies(runtime, {
      list: () => ({ drafts: [], versions: [] }),
    });
    const result = (await deps.preview!(definition, new AbortController().signal)) as {
      context: { fullMarkdown: string };
      provenance: { documents: { storeId: string }[] };
    };
    expect(result.context.fullMarkdown).toContain('Challenge assumptions.');
    expect(result.context.fullMarkdown).toContain('Read deeper evidence when needed.');
    expect(result.provenance.documents[0]?.storeId).toBe(runtime.sourceIdentity);
    expect(contextPacks.list()).toEqual({ packs: [], drafts: [] });
  } finally {
    contextPacks.close();
  }
});
it('reports profiles with their exact pinned pack revisions rather than upgrading them', async () => {
  const deps = contextPackRouterDependencies({} as never, {
    list: () => ({
      drafts: [],
      versions: [
        {
          profileId: 'mitzo-review',
          revision: 3,
          contentHash: 'a'.repeat(64),
          definition: {
            name: 'Bob',
            role: 'reviewer',
            instructions: 'Review',
            expectedOutput: 'Findings',
            acceptanceCriteria: [],
            modelPolicyRole: 'reviewer',
            contextRecipe: {
              version: 2,
              source: 'packs',
              tokenBudget: 1000,
              packs: [{ id: 'review', revision: 2, hash: 'b'.repeat(64) }],
            },
          },
        },
      ],
    }),
  });
  expect(await deps.impact!('review')).toEqual([
    { profileId: 'mitzo-review', name: 'Bob', revision: 3, packRevision: 2 },
  ]);
  expect(await deps.impact!('other')).toEqual([]);
});
it.each([
  ['GET', '/api/context-packs', 'context.list'],
  ['POST', '/api/context-packs/drafts', 'context.create'],
  ['PUT', '/api/context-packs/drafts/aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa', 'context.save'],
  [
    'POST',
    '/api/context-packs/drafts/aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa/preview',
    'context.preview',
  ],
  [
    'POST',
    '/api/context-packs/drafts/aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa/publish',
    'context.publish',
  ],
  ['GET', '/api/context-packs/review/revisions/2', 'context.read'],
])('routes %s %s to the retained owner through a closed operation', (method, path, operation) => {
  const selected = selectCustodianOperation(method, path);
  expect(selected?.operation).toBe(operation);
  expect(custodianRoute(selected!)).toEqual({ method, path });
});
