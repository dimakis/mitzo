import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollaborationSettings } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { contextDigest } from '../agent-context-compiler.js';
import { OrdinaryCollaborationJoining } from '../collaboration-joining-owner.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
// Real Git/SQLite/workspace owners; external account/source authority is offline.
// Synthetic retained capacity is fixture evidence, never a runtime qualification.
async function fixture(ready = true) {
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
          import('../collaboration-joining-owner.js').OrdinaryCollaborationJoiningAuthority['authorizeConfirmation']
        >[0],
      ) => {},
    ),
    authorizeJoin: vi.fn(
      async (
        _input: Parameters<
          import('../collaboration-joining-owner.js').OrdinaryCollaborationJoiningAuthority['authorizeJoin']
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

it('confirms through real silent preparation and recovers linked joins without a command or second allocation', async () => {
  const f = await fixture();
  const first = await f.owner().confirm('operator', f.group, f.input, f.signal);
  expect(first.state).toBe('linked');
  expect(f.store.getOrdinarySessionPreparation(first.allocationOperationId)?.sessionId).toBe(
    first.sessionId,
  );
  expect(f.store.getOrdinaryInitialCommandId(first.sessionId!)).toBeUndefined();
  expect(f.store.listSessions()).toHaveLength(2);
  f.reopen();
  f.resolvePreparation.mockClear();
  expect(await f.owner().recover('operator', f.group, first.joinId, f.signal)).toEqual(first);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
  expect(await f.owner().confirm('operator', f.group, f.input, f.signal)).toEqual(first);
  expect(f.store.listSessions()).toHaveLength(2);
});

it('refuses unverified capacity and denied confirmation before any join or reservation', async () => {
  const f = await fixture(false);
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow();
  expect(f.store.collaborationConversation.view(f.group).joins).toEqual([]);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
  f.authority.authorizeConfirmation.mockRejectedValueOnce(new Error('operator denied'));
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow(
    'operator denied',
  );
  expect(f.store.listSessions()).toHaveLength(1);
});

it('recovers crash after actual preparation before allocation recording from the original receipt', async () => {
  const f = await fixture();
  const record = vi
    .spyOn(f.store.collaborationConversation, 'recordAllocation')
    .mockImplementationOnce(() => {
      throw new Error('crash');
    });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow('crash');
  record.mockRestore();
  const pending = f.store.collaborationConversation.view(f.group).joins[0];
  const receipt = f.store.getOrdinarySessionPreparation(pending.allocationOperationId)!;
  expect(receipt).toBeDefined();
  f.reopen();
  f.resolvePreparation.mockRejectedValue(new Error('must not allocate again'));
  const recovered = await f.owner().recover('operator', f.group, pending.joinId, f.signal);
  expect(recovered).toMatchObject({
    state: 'linked',
    sessionId: receipt.sessionId,
    allocationOperationId: receipt.allocationOperationId,
  });
  expect(f.store.listSessions()).toHaveLength(2);
});

it('retains allocation when access changes during preparation and requires fresh recovery authority', async () => {
  const f = await fixture();
  let revoked = false;
  const prepare = f.workspaces.prepareOrdinarySession.bind(f.workspaces);
  vi.spyOn(f.workspaces, 'prepareOrdinarySession').mockImplementation(async (...args) => {
    const result = await prepare(...args);
    revoked = true;
    return result;
  });
  f.authority.authorizeJoin.mockImplementation(async () => {
    if (revoked) throw new Error('source changed');
  });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow(
    'source changed',
  );
  const retained = f.store.collaborationConversation.view(f.group).joins[0];
  expect(f.store.getOrdinarySessionPreparation(retained.allocationOperationId)).toBeDefined();
  await expect(f.owner().recover('operator', f.group, retained.joinId, f.signal)).rejects.toThrow(
    'source changed',
  );
  f.authority.authorizeJoin.mockResolvedValue(undefined);
  expect((await f.owner().recover('operator', f.group, retained.joinId, f.signal)).state).toBe(
    'linked',
  );
});

it('preserves the allocated session when membership linking conflicts across restart', async () => {
  const f = await fixture();
  f.authority.authorizeJoin
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      f.store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
      f.store.setSessionCollaboration(f.group, {
        expectedRevision: 1,
        participantSessionIds: ['source', 'other'],
      });
    });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow();
  const allocated = f.store.collaborationConversation.view(f.group).joins[0];
  expect(allocated.state).toBe('allocated');
  f.reopen();
  await expect(
    f.owner().recover('operator', f.group, allocated.joinId, f.signal),
  ).rejects.toThrow();
  expect(f.store.collaborationConversation.getJoin(f.group, allocated.joinId)).toEqual(allocated);
  expect(f.store.listSessions()).toHaveLength(3);
});

it('freezes caller and authority inputs across awaits', async () => {
  const f = await fixture();
  const original = structuredClone(f.input);
  f.authority.authorizeConfirmation.mockImplementationOnce(async (passed) => {
    passed.input.settings.selection.model = 'callback-mutated';
    f.input.settings.selection.model = 'mutated';
  });
  f.authority.authorizeJoin.mockImplementation(async (passed) => {
    passed.join.settings.selection.model = 'callback-mutated';
    passed.join.allocationOperationId = randomUUID();
    f.input.name = 'mutated';
  });
  const joined = await f.owner().confirm('operator', f.group, f.input, f.signal);
  expect(joined.settings).toEqual(original.settings);
  expect(joined.name).toBe(original.name);
});

it('serializes identity through existing owners across concurrent coordinators', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    f.owner().confirm('operator', f.group, f.input, f.signal),
    f.forkOwner().confirm('operator', f.group, f.input, f.signal),
  ]);
  expect(a).toEqual(b);
  expect(f.store.listSessions()).toHaveLength(2);
});

it('rejects settings absent from the retained assessment before recording a join', async () => {
  const f = await fixture();
  f.input.settings.selection.model = 'changed-model';
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow();
  expect(f.store.collaborationConversation.view(f.group).joins).toEqual([]);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
});

it('honors cancellation before authority and after resolver without preparing a session', async () => {
  const f = await fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(f.owner().confirm('operator', f.group, f.input, cancelled.signal)).rejects.toThrow();
  expect(f.authority.authorizeConfirmation).not.toHaveBeenCalled();
  const later = new AbortController();
  f.resolvePreparation.mockImplementationOnce(async () => {
    later.abort();
    return {
      binding: {
        accountId: 'unused',
        accountLabel: 'Unused',
        provider: 'openai-codex',
        profileRevision: 'r1',
        model: 'offline-fixture',
      },
      taskRoot: '/unused',
      agentProfile: {} as never,
    };
  });
  await expect(f.owner().confirm('operator', f.group, f.input, later.signal)).rejects.toThrow();
  const pending = f.store.collaborationConversation.view(f.group).joins[0];
  expect(pending.state).toBe('pending_preparation');
  expect(f.store.getOrdinarySessionPreparation(pending.allocationOperationId)).toBeUndefined();
  expect(f.store.listSessions()).toHaveLength(1);
});

it('reauthorizes after a host resolver await before reserving the ordinary session', async () => {
  const f = await fixture();
  const resolve = f.resolvePreparation.getMockImplementation()!;
  f.resolvePreparation.mockImplementationOnce(async () => {
    const input = await resolve();
    f.authority.authorizeJoin.mockRejectedValue(new Error('revoked while resolving'));
    return input;
  });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow(
    'revoked while resolving',
  );
  const pending = f.store.collaborationConversation.view(f.group).joins[0];
  expect(pending.state).toBe('pending_preparation');
  expect(f.store.getOrdinarySessionPreparation(pending.allocationOperationId)).toBeUndefined();
  expect(f.store.listSessions()).toHaveLength(1);
});
