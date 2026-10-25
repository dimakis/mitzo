import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rm,
  rename,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { contextDigest } from '../agent-context-compiler.js';

// Never import the host's token provider, even transitively through owner modules.
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-internal-token-for-ordinary-workspace-tests',
  isValidInternalToken: () => false,
  createSignalCallbackToken: vi.fn(() => 'synthetic-callback-token'),
  revokeSignalCallbackToken: vi.fn(),
  isValidSignalCallbackToken: () => false,
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
const binding = {
  accountId: 'offline-account',
  accountLabel: 'Offline fixture',
  provider: 'openai-codex' as const,
  profileRevision: 'offline-profile-v1',
  model: 'fixture-model',
};
const runtimeBinding = {
  version: 2 as const,
  account: {
    accountId: binding.accountId,
    provider: binding.provider,
    profileRevision: binding.profileRevision,
  },
  harness: { implementation: 'codex' as const },
  execution: {
    location: 'local' as const,
    targetId: 'offline-target',
    targetRevision: 'offline-native-v1',
  },
};
const commandSelection = {
  version: 1 as const,
  agent: { profileId: 'ordinary-agent', revision: 1 },
  context: { source: 'none' as const, revision: null },
  permission: { mode: 'agent' as const, revision: 0 as const },
  model: binding.model,
  thinking: null,
};
const definition = {
  name: 'Ordinary work',
  descriptor: 'Offline fixture',
  role: 'agent' as const,
  instructions: 'Use the retained materials.',
  expectedOutput: 'A report',
  acceptanceCriteria: ['Retain evidence'],
  modelPolicyRole: 'agent' as const,
};
const agentProfile = {
  profileId: commandSelection.agent.profileId,
  revision: 1,
  definition,
  contentHash: contextDigest(definition),
};
async function fixture<P extends 'openai' | 'openai-codex' | 'anthropic-vertex' = 'openai-codex'>(
  options: {
    location?: 'local' | 'openshell';
    provider?: P;
  } = {},
) {
  const selectedBinding = { ...binding, provider: options.provider ?? binding.provider };
  const selectedRuntime = {
    ...runtimeBinding,
    harness: {
      implementation:
        selectedBinding.provider === 'anthropic-vertex'
          ? ('claude-sdk' as const)
          : ('codex' as const),
    },
    account: { ...runtimeBinding.account, provider: selectedBinding.provider },
    execution: { ...runtimeBinding.execution, location: options.location ?? 'local' },
  };

  const root = await realpath(await mkdtemp(join(tmpdir(), 'ordinary-no-git-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv('REPO_PATH', join(root, 'forbidden-repository-fallback'));
  const taskRoot = join(root, 'tasks');
  await mkdir(taskRoot, { mode: 0o700 });
  const forbidden = vi.fn(async () => {
    throw Error('Repository/Git authority must never be used');
  });
  const proof = {
    version: 1 as const,
    originalBinding: selectedBinding,
    runtimeBinding: selectedRuntime,
    ...(options.location === 'openshell' ? { sandboxWorkdir: '/sandbox/workspaces/mgmt' } : {}),
    credentialDigest: 'a'.repeat(64),
  };
  const capture = vi.fn(async () => structuredClone(proof));
  const assert = vi.fn(async () => {});
  const deps = {
    authorize: forbidden,
    inspect: forbidden,
    prepare: forbidden,
    verify: forbidden,
    ordinaryPreparation: { capture, assert },
  };
  let owner = new RepositoryWorkspaces(join(root, 'private'), deps);
  cleanups.push(() => owner.close());
  const prepare = () =>
    owner.prepareOrdinaryWorkspace({
      binding: selectedBinding,
      selection: {
        runOn: selectedRuntime.execution.location,
        runtime: {
          account: selectedRuntime.account,
          harness: selectedRuntime.harness.implementation,
          targetId: 'offline-target',
        },
      },
      signal: new AbortController().signal,
    });
  const input = (preparationId: string, allocationOperationId = randomUUID()) => ({
    preparationId,
    allocationOperationId,
    binding: selectedBinding,
    taskRoot,
    agentProfile,
    settings: {
      version: 2 as const,
      binding: selectedRuntime,
      selection: commandSelection,
      workspace: { kind: 'ordinary' as const, preparationId },
    },
    signal: new AbortController().signal,
  });
  return {
    root,
    taskRoot,
    binding: selectedBinding,
    runtimeBinding: selectedRuntime,
    get owner() {
      return owner;
    },
    prepare,
    input,
    capture,
    assert,
    forbidden,
    reopen() {
      owner.close();
      owner = new RepositoryWorkspaces(join(root, 'private'), deps);
    },
  };
}

it('retains real ordinary preparation and reserves independent non-Git identities without repository authority', async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  expect(prepared).toMatchObject({
    kind: 'ordinary',
    preparationId: expect.any(String),
    runtimeBinding,
    capabilities: expect.arrayContaining(['writable_files', 'task_execution']),
  });
  expect(prepared).not.toHaveProperty('credentialDigest');
  const input = f.input(prepared.preparationId);
  const first = await f.owner.reserveOrdinaryWorkspace(input);
  const second = await f.owner.reserveOrdinaryWorkspace(f.input(prepared.preparationId));
  expect(first).toMatchObject({
    kind: 'ordinary',
    preparationId: prepared.preparationId,
    state: 'reserved',
  });
  expect(first.id).not.toBe(prepared.preparationId);
  expect(first.id).not.toBe(first.conversationId);
  expect(second.id).not.toBe(first.id);
  expect(second.conversationId).not.toBe(first.conversationId);
  for (const field of ['repository', 'baseOid', 'baseBranch', 'featureBranch', 'connectionId'])
    expect(first).not.toHaveProperty(field);
  await expect(lstat(first.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('concurrent exact operations and owner restart recover the original reservation; changed input cannot replace it', async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  const input = f.input(prepared.preparationId);
  const [a, b] = await Promise.all([
    f.owner.reserveOrdinaryWorkspace(input),
    f.owner.reserveOrdinaryWorkspace(input),
  ]);
  expect(a).toEqual(b);
  f.reopen();
  expect(await f.owner.reserveOrdinaryWorkspace(input)).toEqual(a);
  await expect(
    f.owner.reserveOrdinaryWorkspace({
      ...input,
      settings: { ...input.settings, selection: { ...commandSelection, thinking: 'high' } },
    }),
  ).rejects.toThrow(/original|changed|replace/i);
  expect(await f.owner.reserveOrdinaryWorkspace(input)).toEqual(a);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('claims a private plain directory once and preserves edited files across exact replay and restart', async () => {
  const f = await fixture();
  const p = await f.prepare();
  const reserved = await f.owner.reserveOrdinaryWorkspace(f.input(p.preparationId));
  const request = {
    id: reserved.id,
    conversationId: reserved.conversationId,
    binding,
    taskRoot: f.taskRoot,
    signal: new AbortController().signal,
  };
  const claimed = await f.owner.claimOrdinaryWorkspace(request);
  expect(claimed.state).toBe('claimed');
  expect((await lstat(claimed.directory)).mode & 0o077).toBe(0);
  await expect(lstat(join(claimed.directory, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(join(claimed.directory, 'report.txt'), 'Original output; do not overwrite.');
  f.reopen();
  expect(await f.owner.claimOrdinaryWorkspace(request)).toEqual(claimed);
  expect(await readFile(join(claimed.directory, 'report.txt'), 'utf8')).toBe(
    'Original output; do not overwrite.',
  );
  await expect(
    f.owner.claimOrdinaryWorkspace({ ...request, conversationId: 'unrelated-session' }),
  ).rejects.toThrow(/original|scope|identity|conversation/i);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('refuses unsupported isolation and Git capability requirements before any durable allocation', async () => {
  const f = await fixture();
  await expect(
    f.owner.prepareOrdinaryWorkspace({
      binding,
      selection: {
        runOn: 'local',
        runtime: {
          account: runtimeBinding.account,
          harness: 'responses',
          targetId: 'offline-target',
        },
      },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/isolation|unsupported|local/i);
  expect(f.capture).not.toHaveBeenCalled();
  const p = await f.prepare();
  const input = f.input(p.preparationId);
  await expect(
    f.owner.reserveOrdinaryWorkspace({ ...input, requiredCapabilities: ['git_repository'] }),
  ).rejects.toThrow(/capabilit|repository|unsupported/i);
  // Refusal did not burn this operation identity or create an allocation.
  const reserved = await f.owner.reserveOrdinaryWorkspace(input);
  expect(reserved.state).toBe('reserved');
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('rechecks readiness across awaits and does not persist a preparation after authority changes', async () => {
  const f = await fixture();
  f.assert.mockRejectedValueOnce(Error('Readiness changed'));
  await expect(f.prepare()).rejects.toThrow('Readiness changed');
  const p = await f.prepare();
  f.assert.mockRejectedValueOnce(Error('Readiness revoked'));
  const input = f.input(p.preparationId);
  await expect(f.owner.reserveOrdinaryWorkspace(input)).rejects.toThrow('Readiness revoked');
  expect((await f.owner.reserveOrdinaryWorkspace(input)).state).toBe('reserved');
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('rejects replaced or symlinked task custody without deleting or recreating the original output', async () => {
  const f = await fixture();
  const p = await f.prepare();
  const input = f.input(p.preparationId);
  const reserved = await f.owner.reserveOrdinaryWorkspace(input);
  const request = {
    id: reserved.id,
    conversationId: reserved.conversationId,
    binding,
    taskRoot: f.taskRoot,
    signal: new AbortController().signal,
  };
  const claimed = await f.owner.claimOrdinaryWorkspace(request);
  await writeFile(join(claimed.directory, 'report.txt'), 'Retain uncertain original');
  const retained = claimed.directory + '-retained';
  await rename(claimed.directory, retained);
  await symlink(retained, claimed.directory);
  await expect(f.owner.claimOrdinaryWorkspace(request)).rejects.toThrow(
    /custody|identity|changed|canonical/i,
  );
  await expect(f.owner.reserveOrdinaryWorkspace(input)).rejects.toThrow(
    /custody|identity|changed|canonical/i,
  );
  expect(await readFile(join(retained, 'report.txt'), 'utf8')).toBe('Retain uncertain original');
  expect((await lstat(claimed.directory)).isSymbolicLink()).toBe(true);
});

it('requires readiness to bind the selected account to the original account, not just echo a different target', async () => {
  const f = await fixture();
  const other = { ...runtimeBinding.account, accountId: 'unrelated-account' };
  f.capture.mockResolvedValueOnce({
    version: 1,
    originalBinding: binding,
    runtimeBinding: { ...runtimeBinding, account: other },
    credentialDigest: 'b'.repeat(64),
  });
  await expect(
    f.owner.prepareOrdinaryWorkspace({
      binding,
      selection: {
        runOn: 'local',
        runtime: { account: other, harness: 'codex', targetId: runtimeBinding.execution.targetId },
      },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/account|scope/i);
});

it('rejects an unsupported provider before asking the credential readiness owner', async () => {
  const f = await fixture();
  const apiBinding = { ...binding, provider: 'google-vertex' as const };
  await expect(
    f.owner.prepareOrdinaryWorkspace({
      binding: apiBinding,
      selection: {
        runOn: 'local',
        runtime: {
          account: { ...runtimeBinding.account, provider: 'google-vertex' },
          harness: 'codex',
          targetId: runtimeBinding.execution.targetId,
        },
      },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/supported|local|provider/i);
  expect(f.capture).not.toHaveBeenCalled();
});

it('retains the original identity and files when authority is lost after directory creation, without reporting readiness', async () => {
  const f = await fixture();
  const p = await f.prepare();
  const input = f.input(p.preparationId);
  const reserved = await f.owner.reserveOrdinaryWorkspace(input);
  const request = {
    id: reserved.id,
    conversationId: reserved.conversationId,
    binding,
    taskRoot: f.taskRoot,
    signal: new AbortController().signal,
  };
  f.assert
    .mockImplementationOnce(async () => {})
    .mockRejectedValueOnce(Error('Readiness lost after directory creation'));
  await expect(f.owner.claimOrdinaryWorkspace(request)).rejects.toThrow(
    'Readiness lost after directory creation',
  );
  await writeFile(
    join(reserved.directory, 'uncertain-output.txt'),
    'Preserve this original directory',
  );
  f.reopen();
  expect(f.owner.getOrdinaryWorkspace(reserved.id)).toMatchObject({
    id: reserved.id,
    conversationId: reserved.conversationId,
    state: 'claiming',
  });
  await expect(f.owner.claimOrdinaryWorkspace(request)).rejects.toThrow(/uncertain/i);
  await expect(f.owner.reserveOrdinaryWorkspace(input)).rejects.toThrow(/uncertain/i);
  expect(await readFile(join(reserved.directory, 'uncertain-output.txt'), 'utf8')).toBe(
    'Preserve this original directory',
  );
});

it.each(['prepare', 'reserve', 'claim', 'qualify', 'revalidate'] as const)(
  'keeps shared persistence active across suspended ordinary %s',
  async (stage) => {
    const f = await fixture();
    const prepared = stage === 'prepare' ? undefined : await f.prepare();
    const input = prepared ? f.input(prepared.preparationId) : undefined;
    const reservation =
      stage === 'claim' || stage === 'revalidate'
        ? await f.owner.reserveOrdinaryWorkspace(input!)
        : undefined;
    const claim = reservation
      ? {
          id: reservation.id,
          conversationId: reservation.conversationId,
          binding,
          taskRoot: f.taskRoot,
          signal: new AbortController().signal,
        }
      : undefined;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    f.assert.mockClear();
    f.assert.mockImplementationOnce(() => gate);
    const operation =
      stage === 'prepare'
        ? f.prepare()
        : stage === 'reserve'
          ? f.owner.reserveOrdinaryWorkspace(input!)
          : stage === 'qualify'
            ? f.owner.qualifyOrdinaryWorkspace(input!)
            : stage === 'revalidate'
              ? f.owner.revalidateOrdinaryWorkspace(claim!)
              : f.owner.claimOrdinaryWorkspace(claim!);
    try {
      await vi.waitFor(() => expect(f.assert).toHaveBeenCalledOnce());
      expect(() => f.owner.closeIdle()).toThrow('active');
    } finally {
      release();
      await operation.catch(() => undefined);
    }
    expect(await operation).toBeDefined();
  },
);

it('fences ordinary entrypoints after shared persistence is released without reacquiring readiness', async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  const input = f.input(prepared.preparationId);
  const reservation = await f.owner.reserveOrdinaryWorkspace(input);
  const claim = {
    id: reservation.id,
    conversationId: reservation.conversationId,
    binding,
    taskRoot: f.taskRoot,
    signal: new AbortController().signal,
  };
  const materialized = await f.owner.claimOrdinaryWorkspace(claim);
  f.owner.closeIdle();
  f.capture.mockClear();
  f.assert.mockClear();
  await expect(f.prepare()).rejects.toThrow('released');
  await expect(f.owner.reserveOrdinaryWorkspace(input)).rejects.toThrow('released');
  await expect(f.owner.claimOrdinaryWorkspace(claim)).rejects.toThrow('released');
  expect(() => f.owner.getOrdinaryWorkspace(reservation.id)).toThrow('released');
  expect(() => f.owner.getOrdinaryWorkspaceForConversation(reservation.conversationId)).toThrow(
    'released',
  );
  expect(() =>
    f.owner.validateOrdinaryWorkspace(reservation.conversationId, materialized.directory),
  ).toThrow('released');
  await expect(async () => f.owner.qualifyOrdinaryWorkspace(input)).rejects.toThrow('released');
  await expect(async () => f.owner.revalidateOrdinaryWorkspace(claim)).rejects.toThrow('released');
  expect(() => f.owner.validateRetainedOrdinaryWorkspace(reservation.conversationId)).toThrow(
    'released',
  );
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.assert).not.toHaveBeenCalled();
});

it.each(['openai', 'openai-codex'] as const)(
  'retains the configured default OpenShell workspace for %s without preparing a repository or creating its sandbox path on the host',
  async (provider) => {
    const f = await fixture({ location: 'openshell', provider });
    const prepared = await f.prepare();
    expect(prepared.runtimeBinding).toEqual(f.runtimeBinding);
    const input = f.input(prepared.preparationId);
    const reserved = await f.owner.reserveOrdinaryWorkspace(input);
    expect(reserved).toMatchObject({
      kind: 'ordinary',
      sandbox: true,
      directory: '/sandbox/workspaces/mgmt',
      state: 'reserved',
    });
    const claim = {
      id: reserved.id,
      conversationId: reserved.conversationId,
      binding: f.binding,
      taskRoot: f.taskRoot,
      signal: input.signal,
    };
    const claimed = await f.owner.claimOrdinaryWorkspace(claim);
    expect(claimed).toMatchObject({ id: reserved.id, sandbox: true, state: 'claimed' });
    expect(claimed).not.toHaveProperty('taskIdentity');
    f.reopen();
    expect(await f.owner.claimOrdinaryWorkspace(claim)).toEqual(claimed);
    expect(f.owner.validateOrdinaryWorkspace(claimed.conversationId, claimed.directory)).toEqual(
      claimed,
    );
    await expect(
      f.owner.revalidateOrdinaryWorkspace({
        ...claim,
        binding: { ...f.binding, accountId: 'another-account' },
      }),
    ).rejects.toThrow();
    expect(f.forbidden).not.toHaveBeenCalled();
  },
);

it.each(['readiness failure', 'startup abort'] as const)(
  'recovers the original logical sandbox reservation after %s before any physical effect',
  async (failure) => {
    const f = await fixture({ location: 'openshell', provider: 'openai' });
    const prepared = await f.prepare();
    const input = f.input(prepared.preparationId);
    const reserved = await f.owner.reserveOrdinaryWorkspace(input);
    const controller = new AbortController();
    const claim = {
      id: reserved.id,
      conversationId: reserved.conversationId,
      binding: f.binding,
      taskRoot: f.taskRoot,
      signal: controller.signal,
    };
    f.assert.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      if (failure === 'startup abort') controller.abort();
      else throw Error('Transient readiness failure');
    });
    await expect(f.owner.claimOrdinaryWorkspace(claim)).rejects.toThrow();
    expect(f.owner.getOrdinaryWorkspace(reserved.id)).toMatchObject({
      state: 'reserved',
      conversationId: reserved.conversationId,
      directory: reserved.directory,
    });
    f.reopen();
    const recovered = await f.owner.claimOrdinaryWorkspace({
      ...claim,
      signal: new AbortController().signal,
    });
    expect(recovered).toMatchObject({ id: reserved.id, state: 'claimed', sandbox: true });
    expect(recovered).not.toHaveProperty('taskIdentity');
    expect(f.forbidden).not.toHaveBeenCalled();
  },
);

it('refuses a changed logical sandbox path before claiming its reservation', async () => {
  const f = await fixture({ location: 'openshell', provider: 'openai' });
  const prepared = await f.prepare();
  const input = f.input(prepared.preparationId);
  const reserved = await f.owner.reserveOrdinaryWorkspace(input);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(join(f.root, 'private', 'workspaces.db'));
  try {
    const changed = { ...reserved, directory: '/sandbox/workspaces/another-task' };
    db.prepare('UPDATE ordinary_workspaces SET record=? WHERE id=?').run(
      JSON.stringify(changed),
      reserved.id,
    );
    await expect(
      f.owner.claimOrdinaryWorkspace({
        id: reserved.id,
        conversationId: reserved.conversationId,
        binding: f.binding,
        taskRoot: f.taskRoot,
        signal: input.signal,
      }),
    ).rejects.toThrow(/identity|custody|scope/i);
    const row = db
      .prepare('SELECT record FROM ordinary_workspaces WHERE id=?')
      .get(reserved.id) as { record: string };
    expect(JSON.parse(row.record).state).toBe('reserved');
  } finally {
    db.close();
  }
});

it('recovers the original default allocation after owner restart without new preparation or repository access', async () => {
  const f = await fixture({ location: 'openshell', provider: 'openai' });
  const prepared = await f.prepare();
  const input = f.input(prepared.preparationId);
  expect(f.owner.getOrdinaryWorkspaceForOperation(input.allocationOperationId)).toBeUndefined();
  const original = await f.owner.reserveOrdinaryWorkspace(input);
  f.reopen();
  expect(f.owner.getOrdinaryWorkspaceForOperation(input.allocationOperationId)).toEqual(original);
  expect(f.capture).toHaveBeenCalledOnce();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('normalizes a fresh default OpenShell send once and recovers its exact workspace and session after restart', async () => {
  const f = await fixture({ location: 'openshell', provider: 'openai' });
  const { EventStore } = await import('../event-store.js');
  const { prepareDefaultOpenShellCommand } =
    await import('../ordinary-openshell-default-workspace.js');
  const events = new EventStore(':memory:');
  cleanups.push(() => events.close());
  const qualify = vi.fn(() => ({ binding: f.binding, agentProfile }));
  const input = {
    runOn: 'openshell' as const,
    clientMsgId: randomUUID(),
    capabilityRevision: 'offline-capability',
    runtime: {
      account: f.runtimeBinding.account,
      harness: 'codex' as const,
      targetId: 'offline-target',
      mode: 'agent' as const,
    },
    selection: commandSelection,
    payload: { text: 'Hello without a repository' },
  };
  const options = {
    input,
    authSessionId: 'original-operator',
    events,
    taskRoot: () => f.taskRoot,
    qualify,
    signal: new AbortController().signal,
  };
  const original = await prepareDefaultOpenShellCommand({ ...options, workspaces: f.owner });
  f.reopen();
  expect(await prepareDefaultOpenShellCommand({ ...options, workspaces: f.owner })).toEqual(
    original,
  );
  expect(events.getSession(original.sessionId)).toMatchObject({
    ordinaryWorkspaceId: original.workspace.workspaceId,
  });
  expect(events.getOrdinaryInitialCommandId(original.sessionId)).toBeUndefined();
  expect(qualify).toHaveBeenCalledOnce();
  expect(f.capture).toHaveBeenCalledOnce();
  expect(f.forbidden).not.toHaveBeenCalled();
  await expect(
    prepareDefaultOpenShellCommand({
      ...options,
      workspaces: f.owner,
      input: { ...input, selection: { ...input.selection, model: 'different' } },
    }),
  ).rejects.toThrow('Original default OpenShell settings');
  const differentOperator = await prepareDefaultOpenShellCommand({
    ...options,
    authSessionId: 'other-operator',
    workspaces: f.owner,
  });
  expect(differentOperator.sessionId).not.toBe(original.sessionId);
});

it.each(['openai', 'anthropic-vertex'] as const)(
  'uses existing empty workspace custody for selected local %s without Git or credential substitution',
  async (provider) => {
    const f = await fixture({ provider });
    const prepared = await f.prepare();
    const input = f.input(prepared.preparationId);
    const record = await f.owner.reserveOrdinaryWorkspace(input);
    expect(record.binding).toEqual(f.binding);
    expect(record.settings.binding.account.provider).toBe(provider);
    expect(f.capture).toHaveBeenCalledOnce();
    expect(f.forbidden).not.toHaveBeenCalled();
  },
);
