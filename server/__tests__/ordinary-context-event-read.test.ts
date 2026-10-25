import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { resolveTelosWorkRoleContext } from '../telos-work-role-context.js';
import {
  resolveOrdinaryContributorGuidance,
  saveOrdinaryContributorGuidance,
} from '../ordinary-contributor-guidance.js';

const stores: EventStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline-luna',
  profileRevision: 'v1',
};
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  return store;
}

it('revalidates ordinary context without loading a retained transcript', () => {
  const store = fixture();
  for (let i = 0; i < 3000; i++) store.append('chat', 'block_delta', { text: 'x'.repeat(400) });
  const replay = vi.spyOn(store, 'getSessionEvents').mockImplementation(() => {
    throw Error('Full transcript read in authority fence');
  });
  expect(resolveTelosWorkRoleContext(store, 'chat', binding)).toBeUndefined();
  expect(resolveOrdinaryContributorGuidance(store, 'chat', binding)).toBeUndefined();
  saveOrdinaryContributorGuidance(store, 'chat', binding, 'Original guidance');
  expect(resolveOrdinaryContributorGuidance(store, 'chat', binding)).toBe('Original guidance');
  store.append('chat', 'contributor_guidance', {
    version: 1,
    sessionId: 'chat',
    binding: { ...binding, accountLabel: undefined },
    guidance: 'Changed guidance',
    guidanceHash: '0'.repeat(64),
  });
  expect(() => resolveOrdinaryContributorGuidance(store, 'chat', binding)).toThrow();
  expect(replay).not.toHaveBeenCalled();
});

it('observes newly retained role context and rejects missing guidance on every check', () => {
  const store = fixture();
  vi.spyOn(store, 'getSessionEvents').mockImplementation(() => {
    throw Error('Full transcript read in authority fence');
  });
  expect(resolveTelosWorkRoleContext(store, 'chat', binding)).toBeUndefined();
  store.append('chat', 'telos_work_role_context', { guidance: 'Missing its immutable guidance' });
  expect(() => resolveOrdinaryContributorGuidance(store, 'chat', binding)).toThrow(/role context/i);
  expect(() => resolveTelosWorkRoleContext(store, 'chat', binding)).toThrow();
});
