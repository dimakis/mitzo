import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { readSandboxOwnershipReview } from '../sandbox-ownership-review.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it('composes retained stopped Symposium seat evidence without a native artifact runtime or visible session list', () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-owners-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const store = new EventStore(path);
  store.upsertSession({ sessionId: 'parent', summary: 'Retained Symposium' });
  store.hideSession('parent');
  expect(store.listSessions()).toEqual([]);
  const raw = new Database(path);
  raw.pragma('foreign_keys = OFF');
  raw
    .prepare(
      `INSERT INTO symposium_seat_sandboxes
    (session_id,seat_id,generation,runtime_id,workspace,provider_name,provider_id,provider_type,model,sandbox_name,physical_id,state)
    VALUES ('parent','writer',1,'runtime','default','work-openai','private-provider-id','openai','test','seat-sandbox','physical','stopped')`,
    )
    .run();
  raw.close();
  try {
    const physical = {
      id: 'physical',
      name: 'seat-sandbox',
      phase: 'Stopped',
      workspace: 'default',
      gateway: 'gateway',
    };
    const native = { listSandboxOwnership: () => [] };
    const review = readSandboxOwnershipReview(physical, native, store);
    expect(review.owners).toEqual([
      expect.objectContaining({
        conversationId: 'parent',
        title: 'Retained Symposium',
        ownerKind: 'symposium',
        relation: 'symposium_seat',
      }),
    ]);
    expect(review.blockers).toEqual(
      expect.arrayContaining([
        'symposium',
        'gateway_scope_unverified',
        'lifecycle_missing',
        'checkpoint_unverified',
      ]),
    );
    expect(review.blockers).not.toContain('owner_unresolved');
    expect(review.canDelete).toBe(false);
    expect(JSON.stringify(review)).not.toContain('private-provider-id');
    for (const field of ['id', 'name', 'workspace']) {
      expect(
        readSandboxOwnershipReview({ ...physical, [field]: 'other' }, native, store).owners,
      ).toEqual([]);
    }
  } finally {
    store.close();
  }
});
