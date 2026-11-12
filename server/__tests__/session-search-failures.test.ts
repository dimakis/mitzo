import { afterEach, expect, it } from 'vitest';
import { SessionSearchIndex } from '../../packages/protocol/src/session-search-index.js';

const indexes: SessionSearchIndex[] = [];
afterEach(async () => {
  await Promise.all(indexes.splice(0).map((index) => index.close()));
});

it('retains the worker cause and exposes only bounded search diagnostics', async () => {
  const index = new SessionSearchIndex({
    highWater: () => 1,
    page: () => [
      {
        seq: 1,
        session_id: 'public-chat',
        type: 'user_message',
        payload: 'private-transcript-marker',
        created_at: 1,
      },
    ],
    sessions: () => [],
  });
  indexes.push(index);
  const failure = await index.search('query-marker', 20).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    message: 'Search index unavailable',
    cause: { name: 'SyntaxError' },
    diagnostic: {
      code: 'session_search_failed',
      stage: 'append',
      requestId: 1,
      causeName: 'SyntaxError',
    },
  });
  const diagnostic = JSON.stringify((failure as { diagnostic: unknown }).diagnostic);
  expect(diagnostic).not.toContain('private-transcript-marker');
  expect(diagnostic).not.toContain('query-marker');
});

it('reports a failed query without poisoning the next search', async () => {
  const index = new SessionSearchIndex({ highWater: () => 0, page: () => [], sessions: () => [] });
  indexes.push(index);
  await expect(index.search('x'.repeat(513), 20)).rejects.toMatchObject({
    cause: { name: 'RangeError' },
    diagnostic: { code: 'session_search_failed', stage: 'search', requestId: 1 },
  });
  await expect(index.search('valid query', 20)).resolves.toEqual([]);
});
