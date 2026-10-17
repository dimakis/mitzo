import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountBinding, CollaborationSettings } from '@mitzo/protocol';
import { AccountBindingSchema } from '@mitzo/protocol';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import type { OrdinaryRepositoryRuntimeSelection } from '../ordinary-repository-preparation.js';
import { EventStore } from '../event-store.js';
import { contextDigest } from '../agent-context-compiler.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(silent = false, runOn: 'local' | 'openshell' = 'local') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delegated-workspace-')));
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
  await writeFile(join(source, 'task.txt'), 'pinned');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'base');
  const binding = AccountBindingSchema.parse({
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai-codex',
    profileRevision: 'r1',
    model: 'offline-fixture',
  });
  const runtime = {
    version: 2 as const,
    account: { accountId: binding.accountId, provider: binding.provider, profileRevision: 'r1' },
    harness: { implementation: 'codex' as const },
    execution: { location: runOn, targetId: 'mac', targetRevision: 'r1' },
  };
  const sourceInfo = {
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: git(source, 'rev-parse', 'HEAD'),
  };
  const authorize = vi.fn(
    async (
      _binding: AccountBinding,
      _connectionId: string,
      _repository: string,
      _signal: AbortSignal,
    ) => ({ revision: 1, allowedBaseBranches: ['main'] }),
  );
  const inspect = vi.fn(async () => sourceInfo);
  const capture = vi.fn(
    async (
      selected: AccountBinding,
      _selection: OrdinaryRepositoryRuntimeSelection,
      _signal: AbortSignal,
    ) => ({
      version: 1 as const,
      originalBinding: AccountBindingSchema.parse(selected),
      runtimeBinding: structuredClone(runtime),
      credentialDigest: 'a'.repeat(64),
    }),
  );
  const prepare = vi.fn(async (preview: typeof sourceInfo, directory: string, branch: string) => {
    await cp(source, directory, { recursive: true });
    git(directory, 'checkout', '-qB', branch, preview.baseOid);
    return { ...preview, directory, featureBranch: branch };
  });
  const dependencies = {
    authorize,
    inspect,
    prepare,
    verify: async () => {},
    ordinaryPreparation: { capture, assert: async () => {} },
  };
  let workspaces = new RepositoryWorkspaces(join(root, 'private'), dependencies);
  const signal = new AbortController().signal;
  const preview = await workspaces.preview(binding, 'connection', 'example/repo', signal, {
    runOn,
    runtime: { account: runtime.account, harness: 'codex', targetId: 'mac' },
  });
  await workspaces.prepare(preview.id, binding, signal);
  const reservation = {
    id: preview.id,
    binding,
    conversationId: 'lead-chat',
    taskRoot: tasks,
    signal,
    runtimeBinding: runtime,
    commandFingerprint: 'b'.repeat(64),
  };
  const settings: CollaborationSettings = {
    binding: runtime,
    repositoryWorkspaceId: preview.id,
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: binding.model,
      thinking: null,
    },
  };
  let sourceConversationId = 'lead-chat';
  if (silent) {
    const events = new EventStore(join(root, 'events.db'));
    const definition = {
      name: 'Agent',
      descriptor: 'Offline',
      role: 'agent' as const,
      instructions: 'Offline',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent' as const,
    };
    try {
      const prepared = await workspaces.prepareOrdinarySession(
        {
          allocationOperationId: randomUUID(),
          id: preview.id,
          binding,
          taskRoot: tasks,
          settings,
          ...(runOn === 'openshell' ? { sandboxWorkdir: '/sandbox/workspaces/lead/mgmt' } : {}),
          agentProfile: {
            profileId: 'agent',
            revision: 1,
            definition,
            contentHash: contextDigest(definition),
          },
          signal,
        },
        events,
      );
      sourceConversationId = prepared.receipt.sessionId;
    } finally {
      events.close();
    }
  } else {
    await workspaces.reserveHostTask(reservation);
    await workspaces.claimReservedHostTask(reservation);
  }
  const input = {
    allocationOperationId: randomUUID(),
    sourceConversationId,
    settings,
    binding,
    signal,
  };
  const db = new Database(join(root, 'private', 'workspaces.db'));
  cleanups.push(async () => {
    db.close();
    workspaces.close();
    await rm(root, { recursive: true, force: true });
  });
  capture.mockClear();
  inspect.mockClear();
  prepare.mockClear();
  authorize.mockClear();
  return {
    root,
    source,
    tasks,
    git,
    input,
    db,
    dependencies,
    capture,
    inspect,
    prepare,
    authorize,
    get workspaces() {
      return workspaces;
    },
    fork() {
      const other = new RepositoryWorkspaces(join(root, 'private'), dependencies);
      cleanups.push(async () => {
        other.close();
      });
      return other;
    },
    reopen() {
      workspaces.close();
      workspaces = new RepositoryWorkspaces(join(root, 'private'), dependencies);
    },
  };
}

it('prepares a separate worker at the original base and recovers it after restart without inspecting main', async () => {
  const f = await fixture();
  const original = f.workspaces.get(f.input.settings.repositoryWorkspaceId);
  await writeFile(join(f.source, 'task.txt'), 'later main');
  f.git(f.source, 'commit', '-qam', 'later');
  const worker = await f.workspaces.prepareDelegatedWorkspace(f.input);
  expect(worker).toMatchObject({
    id: f.input.allocationOperationId,
    state: 'ready',
    baseOid: original.baseOid,
    featureBranch: `mitzo/repo-${f.input.allocationOperationId}`,
  });
  expect(f.git(join(f.root, 'private', worker.id, 'mgmt'), 'rev-parse', 'HEAD')).toBe(
    original.baseOid,
  );
  expect(f.workspaces.get(original.id)).toEqual(original);
  expect(f.capture).toHaveBeenCalledOnce();
  expect(f.inspect).not.toHaveBeenCalled();
  f.reopen();
  expect(await f.workspaces.prepareDelegatedWorkspace(f.input)).toEqual(worker);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.capture).toHaveBeenCalledOnce();
});

it('allows only a model change within the original account and retains exact selected settings', async () => {
  const f = await fixture();
  const input = structuredClone({ ...f.input, signal: undefined });
  input.binding.model = 'offline-worker';
  input.settings.selection.model = 'offline-worker';
  const worker = await f.workspaces.prepareDelegatedWorkspace({ ...input, signal: f.input.signal });
  expect(f.workspaces.get(worker.id).binding.model).toBe('offline-worker');
  expect(f.authorize.mock.calls.some(([binding]) => binding.model === f.input.binding.model)).toBe(
    true,
  );
  await expect(
    f.workspaces.prepareDelegatedWorkspace({
      ...f.input,
      binding: { ...f.input.binding, accountId: 'other' },
    }),
  ).rejects.toThrow();
  await expect(
    f.workspaces.prepareDelegatedWorkspace({
      ...f.input,
      settings: { ...f.input.settings, repositoryWorkspaceId: 'other' },
    }),
  ).rejects.toThrow();
  await expect(
    f.workspaces.prepareDelegatedWorkspace({
      ...f.input,
      settings: {
        ...f.input.settings,
        selection: { ...f.input.settings.selection, thinking: 'high' },
      },
    }),
  ).rejects.toThrow(/identity|changed|conflict/i);
  expect(f.prepare).toHaveBeenCalledOnce();
});

it('retains preparing and failed identities rather than acquiring replacement workspaces', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.prepare.mockImplementationOnce(async () => {
    await gate;
    throw new Error('offline acquisition failed');
  });
  const pending = f.workspaces.prepareDelegatedWorkspace(f.input);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  await expect(f.fork().prepareDelegatedWorkspace(f.input)).rejects.toThrow(
    /preparing|uncertain|original/i,
  );
  release();
  await expect(pending).rejects.toThrow(/offline acquisition failed/);
  expect(f.workspaces.get(f.input.allocationOperationId).state).toBe('failed');
  await expect(f.workspaces.prepareDelegatedWorkspace(f.input)).rejects.toThrow(
    /failed|uncertain|original/i,
  );
  expect(f.prepare).toHaveBeenCalledOnce();
});

it('delegates from a silently prepared reserved lead without claiming or changing its workspace', async () => {
  const f = await fixture(true);
  const source = f.workspaces.get(f.input.settings.repositoryWorkspaceId);
  expect(source.state).toBe('reserved');
  expect(() => f.workspaces.getForConversation(f.input.sourceConversationId)).toThrow();
  const worker = await f.workspaces.prepareDelegatedWorkspace(f.input);
  expect(worker).toMatchObject({
    id: f.input.allocationOperationId,
    state: 'ready',
    baseOid: source.baseOid,
  });
  expect(f.workspaces.get(source.id)).toEqual(source);
});

it('delegates from an exactly reserved silent OpenShell lead before its first turn', async () => {
  const f = await fixture(true, 'openshell');
  const source = f.workspaces.get(f.input.settings.repositoryWorkspaceId);
  expect(source).toMatchObject({
    state: 'ready',
    ordinaryFirstReservation: { conversationId: f.input.sourceConversationId },
  });
  expect(source.conversationId).toBeUndefined();
  const worker = await f.workspaces.prepareDelegatedWorkspace(f.input);
  expect(worker).toMatchObject({
    state: 'ready',
    ordinaryPreparation: { runtimeBinding: f.input.settings.binding },
  });
  expect(f.workspaces.get(source.id)).toEqual(source);
  await expect(
    f.workspaces.prepareDelegatedWorkspace({
      ...f.input,
      allocationOperationId: randomUUID(),
      sourceConversationId: 'wrong-conversation',
    }),
  ).rejects.toThrow();
  expect(f.prepare).toHaveBeenCalledOnce();
});

it('joins same-owner concurrent delegated preparation and retains one acquisition outcome', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepare = f.prepare.getMockImplementation()!;
  f.prepare.mockImplementationOnce(async (...args) => {
    await gate;
    return prepare(...args);
  });
  const first = f.workspaces.prepareDelegatedWorkspace(f.input);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  const second = f.workspaces.prepareDelegatedWorkspace(f.input);
  await expect(
    f.workspaces.prepareDelegatedWorkspace({
      ...f.input,
      settings: {
        ...f.input.settings,
        selection: { ...f.input.settings.selection, thinking: 'high' },
      },
    }),
  ).rejects.toThrow(/identity|conflict/);
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.capture).toHaveBeenCalledOnce();
});

it('rechecks the source after fresh runtime capture and preserves a concurrent owner', async () => {
  const f = await fixture();
  const capture = f.capture.getMockImplementation()!;
  f.capture.mockImplementationOnce(async (...args) => {
    const proof = await capture(...args);
    const source = f.workspaces.get(f.input.settings.repositoryWorkspaceId);
    source.conversationId = 'changed-lead';
    f.db
      .prepare('UPDATE repository_workspaces SET record=?,conversation_id=? WHERE id=?')
      .run(JSON.stringify(source), source.conversationId, source.id);
    return proof;
  });
  await expect(f.workspaces.prepareDelegatedWorkspace(f.input)).rejects.toThrow(
    /source|changed|unavailable/i,
  );
  expect(f.prepare).not.toHaveBeenCalled();
  expect(() => f.workspaces.get(f.input.allocationOperationId)).toThrow();
});

it('does not overwrite an allocation id already owned by another workspace', async () => {
  const f = await fixture();
  const other = await f.workspaces.preview(
    f.input.binding,
    'connection',
    'example/repo',
    f.input.signal,
  );
  const before = f.workspaces.get(other.id);
  await expect(
    f.workspaces.prepareDelegatedWorkspace({ ...f.input, allocationOperationId: other.id }),
  ).rejects.toThrow(/identity|conflict|delegat/i);
  expect(f.workspaces.get(other.id)).toEqual(before);
  expect(f.prepare).not.toHaveBeenCalled();
});

it('recovers a worker reservation and claimed checkout without creating a new branch or source', async () => {
  const f = await fixture();
  const worker = await f.workspaces.prepareDelegatedWorkspace(f.input);
  const reservation = {
    id: worker.id,
    binding: f.input.binding,
    conversationId: 'worker-chat',
    taskRoot: f.tasks,
    signal: f.input.signal,
    runtimeBinding: f.input.settings.binding,
    commandFingerprint: 'c'.repeat(64),
  };
  await f.workspaces.reserveHostTask(reservation);
  expect(await f.workspaces.prepareDelegatedWorkspace(f.input)).toMatchObject({
    id: worker.id,
    state: 'reserved',
    conversationId: 'worker-chat',
  });
  await f.workspaces.claimReservedHostTask(reservation);
  const before = f.workspaces.get(worker.id);
  f.reopen();
  expect(await f.workspaces.prepareDelegatedWorkspace(f.input)).toEqual(before);
  expect(f.workspaces.getForConversation('lead-chat')?.id).toBe(
    f.input.settings.repositoryWorkspaceId,
  );
  expect(f.workspaces.getForConversation('worker-chat')?.id).toBe(worker.id);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.capture).toHaveBeenCalledOnce();
});

it('rejects changed runtime proof or cancellation across fresh capture before retaining a worker', async () => {
  const f = await fixture();
  const capture = f.capture.getMockImplementation()!;
  f.capture.mockImplementationOnce(async (...args) => {
    const proof = await capture(...args);
    proof.runtimeBinding.execution.targetId = 'different-target';
    return proof;
  });
  await expect(f.workspaces.prepareDelegatedWorkspace(f.input)).rejects.toThrow(
    /identity|conflict/,
  );
  expect(() => f.workspaces.get(f.input.allocationOperationId)).toThrow();
  const controller = new AbortController();
  f.capture.mockImplementationOnce(async (...args) => {
    const proof = await capture(...args);
    controller.abort();
    return proof;
  });
  await expect(
    f.workspaces.prepareDelegatedWorkspace({ ...f.input, signal: controller.signal }),
  ).rejects.toThrow();
  expect(() => f.workspaces.get(f.input.allocationOperationId)).toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
});

it('preserves a different record inserted while runtime capture is pending', async () => {
  const f = await fixture();
  const capture = f.capture.getMockImplementation()!;
  let other: ReturnType<RepositoryWorkspaces['get']>;
  f.capture.mockImplementationOnce(async (...args) => {
    const proof = await capture(...args);
    other = {
      ...f.workspaces.get(f.input.settings.repositoryWorkspaceId),
      id: f.input.allocationOperationId,
      state: 'preview',
      conversationId: undefined,
    };
    f.db
      .prepare('INSERT INTO repository_workspaces(id,record,conversation_id) VALUES(?,?,NULL)')
      .run(other.id, JSON.stringify(other));
    return proof;
  });
  await expect(f.workspaces.prepareDelegatedWorkspace(f.input)).rejects.toThrow(
    /identity|conflict/,
  );
  expect(f.workspaces.get(f.input.allocationOperationId)).toEqual(other!);
  expect(f.prepare).not.toHaveBeenCalled();
});
