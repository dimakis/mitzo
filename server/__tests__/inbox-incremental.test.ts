import './fixtures/offline-user-home.js';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationStore } from '../notification-store.js';
import { UnifiedInbox } from '../unified-inbox.js';
import { readFile } from 'node:fs/promises';
import { InboxQuery } from '@mitzo/protocol';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

const directory = mkdtempSync(join(tmpdir(), 'inbox-incremental-'));
const store = new NotificationStore(':memory:');
const inbox = new UnifiedInbox(store, () => directory);
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
});
afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function file(name: string, text: string) {
  writeFileSync(join(directory, name), `# ${name}\n${text}`);
}

it('coalesces reads and avoids rewriting unchanged sources, including archives', async () => {
  file('first.md', 'old content');
  mkdirSync(join(directory, 'archive'));
  writeFileSync(join(directory, 'archive/old.md'), '# Historical\nretained');
  await inbox.reconcileAsync();
  const sync = vi.spyOn(store, 'syncInbox');
  vi.mocked(readFile).mockClear();
  await Promise.all([inbox.reconcileAsync(), inbox.reconcileAsync()]);
  expect(sync).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
  file('first.md', 'changed content');
  await inbox.reconcileAsync();
  expect(sync).toHaveBeenCalledTimes(1);
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(store.get('inbox:first.md')?.inbox?.content).toContain('changed content');
  renameSync(join(directory, 'first.md'), join(directory, 'archive/first.md'));
  await inbox.reconcileAsync();
  expect(store.get('inbox:first.md')?.archivedAt).not.toBeNull();
});

it('applies current private-path policy to already indexed sources', async () => {
  const authority = join(directory, 'authority.md');
  writeFileSync(
    authority,
    JSON.stringify({
      gwsExecutable: '/synthetic/gws',
      jiraLibPath: '/synthetic/jira',
      marker: 'private-value',
    }),
    { mode: 0o600 },
  );
  await inbox.reconcileAsync();
  expect(store.get('inbox:authority.md')?.inbox?.content).toContain('private-value');
  const enrollment = join(directory, 'enrollment.json');
  writeFileSync(
    enrollment,
    JSON.stringify({
      kind: 'workspace-runtime-v1',
      config: realpathSync(authority),
      release: realpathSync(directory) + '/release',
      python: '/synthetic/python',
      marker: 'private-value',
    }),
    { mode: 0o600 },
  );
  process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(enrollment);
  await inbox.reconcileAsync();
  expect(store.get('inbox:authority.md')).toBeUndefined();
  expect(store.inboxFeed(InboxQuery.parse({ view: 'all', query: 'private-value' })).total).toBe(0);
});
