import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollaborationSettings } from '@mitzo/protocol';
import { EventStore } from '../../event-store.js';
import { RepositoryWorkspaces } from '../../repository-workspaces.js';
import { contextDigest } from '../../agent-context-compiler.js';
import { OrdinaryCollaborationJoining } from '../../collaboration-joining-owner.js';

const cleanups: (() => Promise<void>)[] = [];
export async function cleanupJoiningFixtures() {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
// Real Git/SQLite/workspace owners; external account/source authority is offline.
// Synthetic retained capacity is fixture evidence, never a runtime qualification.
export async function createJoiningFixture(ready = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'joining-owner-')));
  const source = join(root, 'source');
  const tasks = join(root, 'tasks');
  await mkdir(tasks);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'utf8' },
    ).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  git(source, 'config', 'user.name', 'Offline');
  git(source, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'task.txt'), 'source');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'fixture');
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    model: 'offline-fixture',
  };
  const runtime = {
    version: 2 as const,
    account: { accountId: binding.accountId, provider: binding.provider, profileRevision: 'r1' },
    harness: { implementation: 'codex' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'r1' },
  };
  const sourceInfo = {
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: git(source, 'rev-parse', 'HEAD'),
  };
  const openWorkspaces = () =>
    new RepositoryWorkspaces(join(root, 'private'), {
      authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
      inspect: async () => sourceInfo,
      prepare: async (_preview, directory, branch) => {
        await cp(source, directory, { recursive: true });
        git(directory, 'checkout', '-qb', branch);
        return { ...sourceInfo, directory, featureBranch: branch };
      },
      verify: async () => {},
      ordinaryPreparation: {
        capture: async () => ({
          version: 1,
          originalBinding: binding,
          runtimeBinding: runtime,
          credentialDigest: 'a'.repeat(64),
        }),
        assert: async () => {},
      },
    });
  let workspaces = openWorkspaces();
  let store = new EventStore(join(root, 'events.db'));
  cleanups.push(async () => {
    store.close();
    workspaces.close();
    await rm(root, { recursive: true, force: true });
  });
  const signal = new AbortController().signal;
  const preview = await workspaces.preview(binding, 'connection', 'example/repo', signal, {
    runOn: 'local',
    runtime: { account: runtime.account, harness: 'codex', targetId: 'mac' },
  });
  const workspace = await workspaces.prepare(preview.id, binding, signal);
  const definition = {
    name: 'Agent',
    descriptor: 'Fixture',
    role: 'agent' as const,
    instructions: 'Offline',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Evidence'],
    modelPolicyRole: 'agent' as const,
  };
  const agentProfile = {
    profileId: 'agent',
    revision: 1,
    definition,
    contentHash: contextDigest(definition),
  };
  const settings: CollaborationSettings = {
    binding: runtime,
    repositoryWorkspaceId: workspace.id,
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: binding.model,
      thinking: null,
    },
  };
  const group = randomUUID();
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'source' });
  const snapshot = store.collaborationConversation.saveSnapshot(group, {
    requestId: randomUUID(),
    sourceConversationId: 'source',
    boundary: { sequence: 0, messageId: null },
    mode: 'selected',
    purpose: 'Review',
    joiningBrief: 'Check recovery',
    messages: [],
    artifacts: [],
    summary: null,
    capacity: ready
      ? {
          status: 'ready',
          assessments: [
            {
              settings,
              availableTokens: 100,
              estimatedTokens: 10,
              estimatorRevision: 'offline-fixture',
            },
          ],
        }
      : { status: 'unverified', reason: 'No native exact capacity.' },
  });
  const input = {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'New agent',
    settings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  };
  const authority = {
    authorizeConfirmation: vi.fn(
      async (
        _input: Parameters<
          import('../../collaboration-joining-owner.js').OrdinaryCollaborationJoiningAuthority['authorizeConfirmation']
        >[0],
      ) => {},
    ),
    authorizeJoin: vi.fn(
      async (
        _input: Parameters<
          import('../../collaboration-joining-owner.js').OrdinaryCollaborationJoiningAuthority['authorizeJoin']
        >[0],
      ) => {},
    ),
  };
  const resolvePreparation = vi.fn(async () => ({ binding, taskRoot: tasks, agentProfile }));
  const owner = () =>
    new OrdinaryCollaborationJoining({ store, workspaces, authority, resolvePreparation });
  return {
    group,
    input,
    authority,
    resolvePreparation,
    owner,
    signal,
    get store() {
      return store;
    },
    get workspaces() {
      return workspaces;
    },
    forkOwner() {
      const otherStore = new EventStore(join(root, 'events.db'));
      const otherWorkspaces = openWorkspaces();
      cleanups.push(async () => {
        otherStore.close();
        otherWorkspaces.close();
      });
      return new OrdinaryCollaborationJoining({
        store: otherStore,
        workspaces: otherWorkspaces,
        authority,
        resolvePreparation,
      });
    },
    reopen() {
      store.close();
      workspaces.close();
      store = new EventStore(join(root, 'events.db'));
      workspaces = openWorkspaces();
    },
  };
}
