import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';

describe('durable account binding', () => {
  it('survives restart and unrelated metadata updates, leaving legacy sessions unbound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-binding-'));
    const path = join(dir, 'events.db');
    const binding = {
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'anthropic-vertex',
      model: 'sonnet',
      profileRevision: 'abc',
    };
    let store = new EventStore(path);
    try {
      store.upsertSession({ sessionId: 'new', accountBinding: binding });
      store.upsertSession({ sessionId: 'new', summary: 'Renamed' });
      store.upsertSession({ sessionId: 'legacy' });
      store.close();
      store = new EventStore(path);
      expect(store.getSession('new')?.accountBinding).toEqual(binding);
      expect(store.getSession('legacy')?.accountBinding).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
