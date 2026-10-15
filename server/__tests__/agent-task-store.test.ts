import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLibraryStore } from '../agent-library-store.js';
import { AgentTaskStore } from '../agent-task-store.js';
import { AgentTaskService } from '../agent-task-service.js';
import { EventStore } from '../event-store.js';

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  closers
    .splice(0)
    .reverse()
    .forEach((close) => close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'agent-tasks-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const library = new AgentLibraryStore(path);
  closers.push(() => library.close());
  const publish = (owner: string, revision: number) => {
    const draft = library.saveDraft(owner, {
      profileId: 'reviewer',
      expectedVersion: 0,
      expectedRevision: revision - 1,
      idempotencyKey: `draft-${revision}`,
      definition: {
        name: 'Reviewer',
        role: 'reviewer',
        instructions: `Review r${revision}`,
        expectedOutput: 'Findings',
        acceptanceCriteria: ['Evidence'],
        modelPolicyRole: 'reviewer',
      },
    });
    return library.publish(owner, {
      profileId: 'reviewer',
      expectedVersion: draft.version,
      idempotencyKey: `publish-${revision}`,
    });
  };
  for (const revision of [1, 2, 3]) publish('alice', revision);
  const version = library.version('alice', 'reviewer', 3)!;
  const definition = {
    name: 'Review changes',
    objective: 'Review the proposed patch',
    profile: { profileId: version.profileId, revision: 3, contentHash: version.contentHash },
    execution: {
      account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'account-r1' },
      harness: 'codex',
      targetId: 'local-mac',
      model: 'fake-luna',
      reasoningEffort: 'low',
      mode: 'ask',
      authorityRefs: ['grant-review'],
    },
    workspace: { workspaceId: 'repo', sourceRefs: ['accepted-main'] },
    schedule: null,
    notificationPolicy: 'results',
    outputPolicy: 'session',
  };
  const store = new AgentTaskStore(path);
  closers.push(() => store.close());
  const service = new AgentTaskService(store);
  const write = { taskId: 'task-1', expectedRevision: 0, idempotencyKey: 'create', definition };
  return { root, path, library, publish, definition, store, service, write };
}
it('pins exact owner profile r3 and execution intent across r4 publication and reopen', () => {
  const f = fixture();
  const saved = f.service.save('alice', f.write);
  expect(saved.configuration).toEqual({ state: 'blocked', reason: 'admission-unavailable' });
  f.publish('alice', 4);
  f.store.close();
  const reopened = new AgentTaskStore(f.path);
  closers.push(() => reopened.close());
  expect(reopened.get('alice', 'task-1')).toEqual(saved);
  expect(saved.definition).toEqual(f.definition);
  expect(reopened.get('alice', 'task-1')?.definition.profile.revision).toBe(3);
  expect(reopened.get('bob', 'task-1')).toBeNull();
  expect(reopened.list('bob')).toEqual([]);
  expect(() => reopened.save('bob', f.write)).toThrow(/profile.*not found/i);
  const bobProfile = f.publish('bob', 1);
  expect(() => reopened.save('bob', f.write)).toThrow(/profile.*not found/i);
  const bobTask = reopened.save('bob', {
    ...f.write,
    definition: {
      ...f.definition,
      profile: {
        profileId: bobProfile.profileId,
        revision: 1,
        contentHash: bobProfile.contentHash,
      },
    },
  });
  expect(reopened.list('bob')).toEqual([bobTask]);
  expect(reopened.get('alice', 'task-1')).toEqual(saved);
});
it('rejects missing revisions, hash mismatches and caller ownership without changing tasks', () => {
  const f = fixture();
  for (const profile of [
    { ...f.definition.profile, revision: 4 },
    { ...f.definition.profile, contentHash: '0'.repeat(64) },
  ])
    expect(() =>
      f.service.save('alice', { ...f.write, definition: { ...f.definition, profile } }),
    ).toThrow();
  expect(() => f.service.save('alice', { ...f.write, owner: 'bob' })).toThrow();
  expect(f.store.list('alice')).toEqual([]);
});
it('retains immutable revisions, rejects stale edits and deduplicates writes durably', () => {
  const f = fixture();
  const first = f.service.save('alice', f.write);
  const edit = {
    ...f.write,
    expectedRevision: 1,
    idempotencyKey: 'edit',
    definition: { ...f.definition, objective: 'Review again' },
  };
  const second = f.service.save('alice', edit);
  expect(second.revision).toBe(2);
  expect(f.store.get('alice', 'task-1', 1)).toEqual(first);
  expect(f.service.save('alice', f.write)).toEqual(first);
  expect(f.service.save('alice', edit)).toEqual(second);
  expect(() => f.service.save('alice', { ...edit, idempotencyKey: 'stale' })).toThrow(
    /revision conflict/i,
  );
  expect(() => f.service.save('alice', { ...edit, definition: f.definition })).toThrow(
    /idempotency/i,
  );
  const reopened = new AgentTaskStore(f.path);
  closers.push(() => reopened.close());
  expect(reopened.save('alice', f.write)).toEqual(first);
  expect(reopened.get('alice', 'task-1')).toEqual(second);
});
it('changes profile binding only by an explicit revision-checked edit, fencing competing owner connections', () => {
  const f = fixture();
  const first = f.service.save('alice', f.write);
  const r4 = f.publish('alice', 4);
  const other = new AgentTaskStore(f.path);
  closers.push(() => other.close());
  const edit = {
    ...f.write,
    expectedRevision: 1,
    idempotencyKey: 'select-r4',
    definition: {
      ...f.definition,
      profile: { profileId: r4.profileId, revision: r4.revision, contentHash: r4.contentHash },
    },
  };
  const second = other.save('alice', edit);
  expect(second.definition.profile.revision).toBe(4);
  expect(f.store.get('alice', 'task-1', 1)).toEqual(first);
  expect(() => f.service.save('alice', { ...edit, idempotencyKey: 'competing-write' })).toThrow(
    /conflict/i,
  );
  expect(f.service.save('alice', edit)).toEqual(second);
});
it('saves incomplete drafts and paused cron intent, but cannot enable execution', () => {
  const f = fixture();
  const draft = {
    ...f.definition,
    objective: '',
    execution: null,
    workspace: null,
    schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Dublin', state: 'paused' },
  };
  const saved = f.service.save('alice', { ...f.write, definition: draft });
  expect(saved.definition).toEqual(draft);
  expect(saved.configuration).toEqual({ state: 'draft' });
  for (const schedule of [
    { ...draft.schedule, state: 'enabled' },
    { ...draft.schedule, cron: '99 7 * * *' },
    { ...draft.schedule, timezone: 'Invalid/Zone' },
    { ...draft.schedule, timezone: '+01:00' },
  ])
    expect(() =>
      f.service.save('alice', {
        ...f.write,
        idempotencyKey: 'invalid',
        definition: { ...draft, schedule },
      }),
    ).toThrow();
});
it('deletes with revision and retry fences without losing old snapshots or reusing identity', () => {
  const f = fixture();
  const first = f.service.save('alice', f.write);
  const removal = { taskId: 'task-1', expectedRevision: 1, idempotencyKey: 'delete' };
  expect(() => f.service.remove('bob', removal)).toThrow(/not found/i);
  expect(() => f.service.remove('alice', { ...removal, expectedRevision: 2 })).toThrow(/conflict/i);
  const deleted = f.service.remove('alice', removal);
  expect(deleted).toMatchObject({ taskId: 'task-1', revision: 2, deleted: true });
  expect(f.service.remove('alice', removal)).toEqual(deleted);
  expect(f.store.list('alice')).toEqual([]);
  expect(f.store.get('alice', 'task-1')).toBeNull();
  expect(f.store.get('alice', 'task-1', 1)).toEqual(first);
  expect(() => f.service.save('alice', { ...f.write, idempotencyKey: 'recreate' })).toThrow(
    /conflict/i,
  );
});
it('recovers task history, retry receipts and legacy profiles from the existing event-owner backup', async () => {
  const f = fixture();
  const first = f.service.save('alice', f.write);
  const events = new EventStore(f.path);
  closers.push(() => events.close());
  const destination = join(f.root, 'snapshot.db');
  await events.backupSnapshot(destination);
  const tasks = new AgentTaskStore(destination);
  const library = new AgentLibraryStore(destination);
  closers.push(
    () => tasks.close(),
    () => library.close(),
  );
  expect(tasks.get('alice', 'task-1')).toEqual(first);
  expect(tasks.save('alice', f.write)).toEqual(first);
  expect(library.version('alice', 'reviewer', 3)?.contentHash).toBe(
    first.definition.profile.contentHash,
  );
  expect(library.list('alice').versions).toHaveLength(3);
  expect(tasks.list('bob')).toEqual([]);
});
