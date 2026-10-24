import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotificationStore } from '../notification-store.js';
import { UnifiedInbox } from '../unified-inbox.js';
import { InboxQuery } from '@mitzo/protocol';

vi.mock('fs', { spy: true });
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.restoreAllMocks();
});

it('reads each active and archived source once per reconciliation', () => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-scan-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'archive'));
  const paths = [join(root, 'one.md'), join(root, 'two.md'), join(root, 'archive', 'old.md')];
  paths.forEach((path) => writeFileSync(path, '---\nagent: offline\n---\n# Example\n\nContent'));
  const store = new NotificationStore(':memory:');
  cleanup.push(() => store.close());
  const inbox = new UnifiedInbox(store, () => root);
  vi.mocked(fs.readFileSync).mockClear();
  inbox.reconcile();
  for (const path of paths) {
    expect(vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => file === path)).toHaveLength(1);
  }
  expect(store.inboxFeed(InboxQuery.parse({ view: 'all' })).total).toBe(2);
  expect(store.feed('archived').items).toHaveLength(1);
});

it('retains the filename validation used by individual source reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-source-name-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'unsafe..md'), '# Excluded source');
  const store = new NotificationStore(':memory:');
  cleanup.push(() => store.close());
  const sync = vi.spyOn(store, 'syncInbox');
  new UnifiedInbox(store, () => root).reconcile();
  expect(sync).not.toHaveBeenCalled();
  expect(store.get('inbox:unsafe..md')).toBeUndefined();
});
