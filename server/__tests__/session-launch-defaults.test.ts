import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionLaunchDefaultsStore } from '../session-launch-defaults.js';
import { SessionLaunchStore } from '../session-launch-store.js';

const configuration = {
  version: 1 as const,
  runtime: {
    version: 1 as const,
    account: { accountId: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    agentProfile: { kind: 'builtin' as const, profileId: 'default-mitzo', revision: 1 },
    execution: { location: 'local' as const, targetId: 'host-mac' },
  },
  mode: 'agent' as const,
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: ['Saved project context'],
  extraTools: [],
};
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function path() {
  const directory = mkdtempSync(join(tmpdir(), 'launch-defaults-'));
  directories.push(directory);
  return join(directory, 'events.db');
}

describe('persistent complete session defaults', () => {
  it('commits defaults with approval and leaves them unchanged for stale or conflicting approval', () => {
    const file = path();
    const defaults = new SessionLaunchDefaultsStore(file);
    const launches = new SessionLaunchStore(file);
    const request = launches.propose({
      operatorId: 'user',
      sourceSessionId: 'source',
      requestId: '4d51e33b-e58b-4e57-ab37-779ab19917ec',
      title: 'New chat',
      prompt: 'Handoff',
      configuration,
    });
    const edits = { title: request.title, prompt: request.prompt, configuration };
    const save = (database: import('better-sqlite3').Database) => {
      defaults.saveInTransaction('user', { expectedRevision: 0, configuration }, database);
    };
    expect(() => launches.approve(request.proposalId, 'user', edits, 99, save)).toThrow(
      /revision/i,
    );
    expect(defaults.get('user').revision).toBe(0);
    launches.approve(request.proposalId, 'user', edits, 1, save);
    expect(defaults.get('user')).toEqual({ revision: 1, configuration });
    expect(() =>
      launches.approve(request.proposalId, 'user', { ...edits, title: 'Changed' }, 1, save),
    ).toThrow(/identity/i);
    expect(defaults.get('user').revision).toBe(1);
    defaults.close();
    launches.close();
  });
  it('rolls back the approval when another device changed the default during review', () => {
    const file = path();
    const defaults = new SessionLaunchDefaultsStore(file);
    const launches = new SessionLaunchStore(file);
    const request = launches.propose({
      operatorId: 'user',
      sourceSessionId: 'source',
      requestId: '57c494af-a810-4c9b-90f7-11745002a46a',
      title: 'New chat',
      prompt: 'Handoff',
      configuration,
    });
    defaults.save('user', { expectedRevision: 0, configuration });
    expect(() =>
      launches.approve(
        request.proposalId,
        'user',
        { title: request.title, prompt: request.prompt, configuration },
        1,
        (database) => {
          defaults.saveInTransaction(
            'user',
            { expectedRevision: 0, configuration: null },
            database,
          );
        },
      ),
    ).toThrow(/changed/i);
    expect(launches.get(request.proposalId, 'user')).toMatchObject({
      state: 'pending',
      allocationId: null,
    });
    expect(defaults.get('user').configuration).toEqual(configuration);
    defaults.close();
    launches.close();
  });
  it('survives reopening the store with the same exact host and settings', () => {
    const file = path();
    const first = new SessionLaunchDefaultsStore(file);
    expect(first.get('user')).toEqual({ revision: 0, configuration: null });
    expect(first.save('user', { expectedRevision: 0, configuration })).toEqual({
      revision: 1,
      configuration,
    });
    first.close();
    const next = new SessionLaunchDefaultsStore(file);
    expect(next.get('user')).toEqual({ revision: 1, configuration });
    expect(next.get('another-user')).toEqual({ revision: 0, configuration: null });
    next.close();
  });
  it('preserves a newer default when another browser tries to save stale settings', () => {
    const store = new SessionLaunchDefaultsStore(path());
    store.save('user', { expectedRevision: 0, configuration });
    expect(() => store.save('user', { expectedRevision: 0, configuration: null })).toThrow(
      /changed/i,
    );
    expect(store.get('user').configuration).toEqual(configuration);
    expect(store.save('user', { expectedRevision: 1, configuration: null })).toEqual({
      revision: 2,
      configuration: null,
    });
    store.close();
  });
  it('validates settings before writing and never persists capability approval', () => {
    const store = new SessionLaunchDefaultsStore(path());
    expect(() =>
      store.save('user', {
        expectedRevision: 0,
        configuration: { ...configuration, grantId: 'secret' },
      }),
    ).toThrow();
    expect(store.get('user').revision).toBe(0);
    store.close();
  });
});
