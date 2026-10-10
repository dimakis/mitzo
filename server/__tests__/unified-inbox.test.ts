import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationStore } from '../notification-store.js';
import { UnifiedInbox, discardInboxSource } from '../unified-inbox.js';
import { approveInboxItem } from '../inbox.js';

let dir: string, store: NotificationStore, inbox: UnifiedInbox;
function file(name: string, agent: string, extra = '', body = 'Useful context', archive = false) {
  const path = archive ? join(dir, 'archive') : dir;
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, name),
    `---\nagent: ${agent}\ntimestamp: 2026-10-09T07:00:00Z\n${extra}---\n\n# ${name}\n\n${body}`,
  );
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unified-inbox-'));
  store = new NotificationStore(':memory:');
  inbox = new UnifiedInbox(store, () => dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
describe('one durable Inbox', () => {
  it('combines legacy content and session activity without duplicate arrivals or pending-file badges', () => {
    file('brief.md', 'morning-briefing');
    file('idea.md', 'troubadour');
    store.record({
      id: 'inbox:brief.md',
      kind: 'update',
      title: 'arrival',
      body: '',
      inboxFilename: 'brief.md',
    });
    store.record({
      id: 'permission:p',
      kind: 'approval',
      permId: 'p',
      title: 'Approve?',
      body: '',
      sessionId: 's',
    });
    expect(inbox.feed({ view: 'all' }).total).toBe(3);
    expect(inbox.feed({ view: 'needs' }).items.map((i) => i.id)).toEqual(['permission:p']);
    expect(inbox.feed({ view: 'all' }).needsYou).toBe(1);
    expect(store.due()).toEqual([]);
  });
  it('searches every view with bounded pagination and source/date/status filters', () => {
    for (let i = 0; i < 70; i++)
      file(`idea-${i}.md`, 'chat', 'kind: proposal\n', 'OpenShell budget');
    const feed = inbox.feed({ view: 'needs', query: 'OpenShell', limit: 20, offset: 20 });
    expect(feed.total).toBe(70);
    expect(feed.items).toHaveLength(20);
    expect(inbox.feed({ source: 'missing' }).total).toBe(0);
    expect(inbox.feed({ age: 'today' }).total).toBe(0);
  });
  it('keeps read, resolution and archive separate and restores archived file content', () => {
    file('alert.md', 'health_monitor', 'kind: alert\nseverity: warning\naction: review\n');
    inbox.feed({});
    store.markRead('inbox:alert.md');
    expect(inbox.feed({ view: 'needs' }).total).toBe(1);
    expect(store.archive('inbox:alert.md')).toBe(false);
    expect(store.resolveInbox('inbox:alert.md')).toBe(true);
    expect(store.archive('inbox:alert.md')).toBe(true);
    expect(inbox.feed({ view: 'archive' }).total).toBe(1);
    expect(store.restore('inbox:alert.md')).toBe(true);
    expect(inbox.feed({ status: 'resolved', view: 'all' }).total).toBe(1);
    file('old.md', 'morning-briefing', '', 'Historical briefing', true);
    expect(inbox.feed({ view: 'archive' }).items.some((i) => i.inboxFilename === 'old.md')).toBe(
      true,
    );
  });
  it('updates an ongoing alert without adding rows and resolves producer all-clear', () => {
    file('alert.md', 'health_monitor', 'kind: alert\nseverity: warning\naction: review\n');
    expect(inbox.feed({ view: 'needs' }).total).toBe(1);
    file(
      'alert.md',
      'health_monitor',
      'kind: alert\nseverity: warning\naction: review\nstatus: resolved\n',
    );
    expect(inbox.feed({ view: 'needs' }).total).toBe(0);
    expect(inbox.feed({ view: 'all' }).total).toBe(1);
  });
  it('brings a resolved archived alert back when fresh evidence becomes critical', () => {
    file('alert.md', 'health_monitor', 'kind: alert\nseverity: warning\naction: review\n');
    inbox.feed({});
    store.markRead('inbox:alert.md');
    store.resolveInbox('inbox:alert.md');
    store.archive('inbox:alert.md');
    file('alert.md', 'health_monitor', 'kind: alert\nseverity: critical\naction: review\n');
    const feed = inbox.feed({ view: 'needs' });
    expect(feed.needsYou).toBe(1);
    expect(feed.items[0].readAt).toBeNull();
    expect(feed.items[0].archivedAt).toBeNull();
  });
});

describe('reviewed lifecycle regressions', () => {
  it('discards persisted actionable evidence before the first reconciliation after restart', () => {
    const database = join(dir, 'notifications.db');
    store.close();
    store = new NotificationStore(database);
    inbox = new UnifiedInbox(store, () => dir);
    file('alert.md', 'health_monitor', 'kind: alert\nseverity: critical\naction: review\n');
    expect(inbox.feed({ view: 'needs' }).total).toBe(1);
    store.queue('inbox:alert.md', 1);
    store.close();
    store = new NotificationStore(database);
    inbox = new UnifiedInbox(store, () => dir);

    expect(discardInboxSource(store, dir, 'alert.md')).toBe(true);
    expect(inbox.feed({ view: 'needs' }).total).toBe(0);
    expect(inbox.feed({ view: 'archive' }).total).toBe(1);
    expect(store.get('inbox:alert.md')?.inbox?.content).toContain('Useful context');
    expect(store.due()).toEqual([]);
  });
  it('leaves ledger state intact when legacy discard fails', () => {
    file('alert.md', 'health_monitor', 'kind: alert\naction: review\n');
    inbox.feed({ view: 'needs' });
    expect(discardInboxSource(store, dir, '../alert.md')).toBe(false);
    expect(inbox.feed({ view: 'needs' }).total).toBe(1);
    expect(store.get('inbox:alert.md')?.archivedAt).toBeNull();
  });
  it('imports archive state over an earlier arrival and preserves explicit restoration', () => {
    file('old.md', 'chat', '', 'Old context', true);
    store.record({
      id: 'inbox:old.md',
      kind: 'update',
      title: 'arrival',
      body: '',
      inboxFilename: 'old.md',
    });
    expect(inbox.feed({ view: 'archive' }).total).toBe(1);
    store.restore('inbox:old.md');
    expect(inbox.feed({ view: 'all' }).total).toBe(1);
    expect(inbox.feed({ view: 'all' }).total).toBe(1);
  });
  it('synchronizes legacy approval and retains repeated stable-file history', () => {
    file(
      'alert.md',
      'health_monitor',
      'kind: alert\nseverity: critical\naction: review\n',
      'First incident',
    );
    inbox.feed({});
    expect(approveInboxItem(dir, 'alert.md')).toBe(true);
    expect(inbox.feed({ view: 'needs' }).total).toBe(0);
    expect(inbox.feed({ view: 'archive' }).total).toBe(1);
    file(
      'alert.md',
      'health_monitor',
      'kind: alert\nseverity: critical\naction: review\n',
      'Second incident',
    );
    expect(inbox.feed({ view: 'needs' }).total).toBe(1);
    expect(inbox.feed({ view: 'archive' }).total).toBe(1);
    expect(approveInboxItem(dir, 'alert.md')).toBe(true);
    expect(inbox.feed({ view: 'needs' }).total).toBe(0);
    expect(inbox.feed({ view: 'archive' }).total).toBe(2);
    expect(
      inbox
        .feed({ view: 'archive' })
        .items.map((i) => i.body)
        .join(' '),
    ).toContain('First incident');
  });
  it('fresh critical evidence reopens even when severity was already critical', () => {
    file(
      'alert.md',
      'health_monitor',
      'kind: alert\nseverity: critical\naction: review\n',
      'First evidence',
    );
    inbox.feed({});
    store.resolveInbox('inbox:alert.md');
    store.archive('inbox:alert.md');
    file(
      'alert.md',
      'health_monitor',
      'kind: alert\nseverity: critical\naction: review\n',
      'Fresh evidence',
    );
    expect(inbox.feed({ view: 'needs' }).total).toBe(1);
    expect(store.get('inbox:alert.md')?.readAt).toBeNull();
  });
});

it('restoring an imported archive never revives an old queued native delivery', () => {
  file('old.md', 'chat', '', 'Archived evidence', true);
  store.record({
    id: 'inbox:old.md',
    kind: 'update',
    title: 'arrival',
    body: '',
    inboxFilename: 'old.md',
  });
  store.queue('inbox:old.md', 1);
  inbox.feed({ view: 'archive' });
  store.restore('inbox:old.md');
  expect(inbox.feed({ view: 'all' }).total).toBe(1);
  expect(store.due()).toEqual([]);
});
