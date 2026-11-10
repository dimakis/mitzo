import { expect, it } from 'vitest';
import { SessionLaunchStore } from '../session-launch-store.js';
it('stores symmetric idempotent navigation links within the owner and unlinks without touching launches', () => {
  const store = new SessionLaunchStore(':memory:');
  try {
    store.link('owner', 'first', 'second', 'First', 'Second');
    store.link('owner', 'second', 'first', 'Second', 'First');
    expect(store.linked('first', 'owner')).toEqual([{ sessionId: 'second', title: 'Second' }]);
    expect(store.linked('second', 'owner')).toEqual([{ sessionId: 'first', title: 'First' }]);
    expect(store.linked('first', 'other')).toEqual([]);
    expect(() => store.link('owner', 'first', 'first', 'First', 'First')).toThrow();
    store.unlink('other', 'first', 'second');
    expect(store.linked('first', 'owner')).toHaveLength(1);
    store.unlink('owner', 'second', 'first');
    expect(store.linked('first', 'owner')).toEqual([]);
    expect(store.forSession('first', 'owner')).toEqual([]);
  } finally {
    store.close();
  }
});
