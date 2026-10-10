import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, renameSync } from 'node:fs';
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
  delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it.each(['enrollment', 'configuration', 'archived configuration'])(
  'hides cached %s indexed before enrollment, including after restart and directory changes',
  (kind) => {
    const database = join(dir, 'notifications.db');
    store.close();
    store = new NotificationStore(database);
    let current = dir;
    inbox = new UnifiedInbox(store, () => current);
    const source = kind.startsWith('archived') ? join(dir, 'archive') : dir;
    mkdirSync(source, { recursive: true });
    const authority = join(source, 'cached-authority.md');
    const config = kind === 'enrollment' ? join(dir, 'provider.json') : authority;
    writeFileSync(
      config,
      JSON.stringify({
        gwsExecutable: '/synthetic/gws',
        jiraLibPath: '/synthetic/jira',
        marker: 'cached-private-marker',
      }),
      { mode: 0o600 },
    );
    const enrollment = kind === 'enrollment' ? authority : join(dir, 'enrollment.json');
    writeFileSync(
      enrollment,
      JSON.stringify({
        kind: 'workspace-runtime-v1',
        config: realpathSync(config),
        release: realpathSync(dir) + '/release',
        python: '/synthetic/python',
        marker: 'cached-private-marker',
      }),
      { mode: 0o600 },
    );
    file('public.md', 'chat');
    inbox.reconcile();
    const id = 'inbox:cached-authority.md';
    expect(store.get(id)?.inbox?.content).toContain('cached-private-marker');
    store.queue(id, 1);
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(enrollment);
    const assertHidden = () => {
      expect(inbox.get(id)).toBeUndefined();
      expect(store.get(id)).toBeUndefined();
      expect(store.feed('all').items.map((item) => item.id)).not.toContain(id);
      expect(store.feed('archived').items.map((item) => item.id)).not.toContain(id);
      expect(inbox.feed({ query: 'cached-private-marker' }).total).toBe(0);
      expect(inbox.feed({ view: 'all', limit: 1 }).total).toBe(1);
      expect(store.due().map((item) => item.id)).not.toContain(id);
      expect(store.get('inbox:public.md')?.inbox?.content).toContain('Useful context');
    };
    assertHidden();
    delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
    assertHidden();
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(enrollment);
    store.close();
    store = new NotificationStore(database);
    current = join(dir, 'another-inbox');
    mkdirSync(current);
    inbox = new UnifiedInbox(store, () => current);
    assertHidden();
  },
);
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

it('protects legacy cached rows without source provenance and removes them from attention counts', () => {
  const config = join(dir, 'legacy-config.json');
  writeFileSync(
    config,
    JSON.stringify({ gwsExecutable: '/synthetic/gws', jiraLibPath: '/synthetic/jira' }),
    { mode: 0o600 },
  );
  const enrollment = join(dir, 'legacy-authority.md');
  writeFileSync(
    enrollment,
    JSON.stringify({
      kind: 'workspace-runtime-v1',
      config: realpathSync(config),
      release: realpathSync(dir) + '/release',
      python: '/synthetic/python',
    }),
    { mode: 0o600 },
  );
  store.record({
    id: 'inbox:legacy-authority.md',
    kind: 'update',
    title: 'Legacy',
    body: 'cached-private-marker',
    inboxFilename: 'legacy-authority.md',
    inbox: {
      agent: 'legacy',
      tags: [],
      category: 'alert',
      severity: 'critical',
      needsAttention: true,
      status: 'pending',
      content: 'cached-private-marker',
    },
  });
  expect(store.feed('needs').needsYou).toBe(1);
  process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(enrollment);
  expect(inbox.get('inbox:legacy-authority.md')).toBeUndefined();
  expect(store.feed('needs').needsYou).toBe(0);
  expect(inbox.feed({ view: 'all' }).sources).not.toContain('legacy');
});

it('withholds Inbox content on policy failure without losing public history or session notices', () => {
  file('public.md', 'chat');
  inbox.reconcile();
  store.record({ id: 'session:s', kind: 'session', title: 'Safe session', body: 'Safe notice' });
  process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = '';
  expect(store.get('inbox:public.md')).toBeUndefined();
  expect(store.feed('all').items.map((item) => item.id)).toEqual(['session:s']);
  delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
  expect(store.get('inbox:public.md')?.inbox?.content).toContain('Useful context');
});

it.each(['stable', 'collision'] as const)(
  'denies cached authority moved to a %s archive name before enrollment',
  (kind) => {
    const database = join(dir, 'moved.db');
    store.close();
    store = new NotificationStore(database);
    inbox = new UnifiedInbox(store, () => dir);
    const config = join(dir, 'move-config.json');
    writeFileSync(
      config,
      JSON.stringify({ gwsExecutable: '/synthetic/gws', jiraLibPath: '/synthetic/jira' }),
      { mode: 0o600 },
    );
    const filename = 'moved-authority.md';
    const active = join(dir, filename);
    writeFileSync(
      active,
      JSON.stringify({
        kind: 'workspace-runtime-v1',
        config: realpathSync(config),
        release: realpathSync(dir) + '/release',
        python: '/synthetic/python',
      }),
      { mode: 0o600 },
    );
    inbox.reconcile();
    const id = `inbox:${filename}`;
    expect(store.get(id)?.inbox?.content).toContain('workspace-runtime-v1');
    mkdirSync(join(dir, 'archive'));
    const archived = join(
      dir,
      'archive',
      kind === 'stable' ? filename : filename.replace('.md', '_' + 'a'.repeat(32) + '.md'),
    );
    renameSync(active, archived);
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(archived);
    const assertHidden = () => {
      expect(inbox.get(id)).toBeUndefined();
      expect(store.get(id)).toBeUndefined();
      expect(inbox.feed({ query: 'workspace-runtime-v1' }).total).toBe(0);
      expect(store.feed('all').items.map((item) => item.id)).not.toContain(id);
    };
    assertHidden();
    store.close();
    store = new NotificationStore(database);
    inbox = new UnifiedInbox(store, () => dir);
    assertHidden();
  },
);
