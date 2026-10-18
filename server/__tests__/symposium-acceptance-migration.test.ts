import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { EventStore } from '../event-store.js';

it('migrates an actual older accepted owner snapshot without inventing schema or granting historical review authority', () => {
  const fixture = new URL('./fixtures/symposium-event-store-09f1090f.sqlite.gz', import.meta.url);
  const manifest = JSON.parse(
    readFileSync(
      new URL('./fixtures/symposium-event-store-09f1090f.json', import.meta.url),
      'utf8',
    ),
  );
  const bytes = readFileSync(fixture);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.snapshotSha256);
  const root = mkdtempSync(join(tmpdir(), 'symposium-migrated-owner-'));
  const path = join(root, 'events.db');
  let current: EventStore | undefined;
  try {
    // Byte-for-byte canonical owner backup; no hand-written CREATE/ALTER SQL.
    writeFileSync(path, gunzipSync(bytes));
    current = new EventStore(path);
    const snapshot = current.collaborationConversation.getSnapshot(
      manifest.group,
      manifest.snapshotId,
    )!;
    expect(snapshot.sha256).toBe(manifest.reviewSha256);
    expect(snapshot.capacity).toEqual({
      status: 'unverified',
      reason: 'Offline historical review; no native authority',
    });
    expect(current.collaborationConversation.view(manifest.group)).toMatchObject({
      membershipRevision: 1,
      participantSessionIds: ['migration-source'],
      messages: [],
    });
    expect(current.getOrdinarySessionPreparation('absent-allocation')).toBeFalsy();
    const before = current.collaborationConversation.view(manifest.group);
    expect(() =>
      current!.setSessionCollaboration(manifest.group, {
        expectedRevision: 1,
        participantSessionIds: ['migration-source', 'missing'],
      }),
    ).toThrow();
    expect(current.collaborationConversation.view(manifest.group)).toEqual(before);
    current.close();
    current = new EventStore(path);
    expect(
      current.collaborationConversation.getSnapshot(manifest.group, manifest.snapshotId),
    ).toEqual(snapshot);
    expect(current.listSessions()).toHaveLength(1);
  } finally {
    current?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
