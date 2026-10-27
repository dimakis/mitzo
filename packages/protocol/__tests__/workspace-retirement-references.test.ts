import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.upsertSession({ sessionId: 'owner', cwd: '/tasks/checkout' });
  return store;
}
it.each(['/tasks/checkout', '/tasks/checkout/subdirectory'])(
  'protects another retained conversation at %s',
  (cwd) => {
    const store = fixture();
    store.upsertSession({ sessionId: 'borrower', cwd, isActive: false });
    expect(() => store.assertNoOtherWorkspaceReferences('owner', '/tasks/checkout')).toThrow(
      /referenc/i,
    );
  },
);
it('protects retained peer worktree paths even without session metadata', () => {
  const store = fixture();
  store.append('borrower', 'worktree_opened', {
    repoName: 'project',
    path: '/tasks/checkout/subdirectory',
  });
  expect(() => store.assertNoOtherWorkspaceReferences('owner', '/tasks/checkout')).toThrow(
    /referenc/i,
  );
});
it('does not confuse parent or similarly prefixed directories with a borrowed task', () => {
  const store = fixture();
  store.upsertSession({ sessionId: 'parent', cwd: '/tasks' });
  store.upsertSession({ sessionId: 'other', cwd: '/tasks/checkout-other' });
  store.append('owner', 'worktree_opened', { repoName: 'project', path: '/tasks/checkout' });
  expect(() => store.assertNoOtherWorkspaceReferences('owner', '/tasks/checkout')).not.toThrow();
});
