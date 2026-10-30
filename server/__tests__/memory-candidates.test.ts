import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';

const store = new EventStore(':memory:');
afterEach(() => store.close());

it('records a sourced candidate once without a model, Git, or another database', () => {
  store.upsertSession({
    sessionId: 'chat',
    accountBinding: {
      accountId: 'work',
      accountLabel: 'Work fixture',
      profileRevision: 'fixture-revision',
      provider: 'openai-codex',
      model: 'fixture',
    },
  });
  store.append('chat', 'user_message', { messageId: 'user-1', text: 'Keep one shared ledger.' });
  const input = {
    requestId: 'a186b239-7960-4791-97fb-15c4be27da6d',
    summary: 'Use one shared ledger.',
    quotes: ['Keep one shared ledger.'],
  };
  const first = store.recordMemoryCandidate('chat', 'work', input);
  expect(first).toMatchObject({ status: 'captured', accepted: false });
  expect(store.recordMemoryCandidate('chat', 'work', input)).toEqual(first);
  expect(store.getEventsOfType('chat', 'memory_candidate')).toHaveLength(1);
  expect(() =>
    store.recordMemoryCandidate('chat', 'work', { ...input, summary: 'Changed request.' }),
  ).toThrow();
  expect(() => store.recordMemoryCandidate('chat', 'personal', input)).toThrow();
  expect(() =>
    store.recordMemoryCandidate('chat', 'work', {
      ...input,
      requestId: 'a186b239-7960-4791-97fb-15c4be27da6e',
      quotes: ['Invented quote.'],
    }),
  ).toThrow();
});
