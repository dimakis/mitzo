import { createHash } from 'node:crypto';
import { codexDynamicToolsOption } from '../codex-ordinary-packet.js';
import { CodexConversation } from '../codex-conversation.js';
import { AccountBindingSchema } from '@mitzo/protocol';
import { localRepositoryPreparationSourceFacts } from '../local-repository-preparation-source.js';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import {
  preparedRepositoryCandidateFixture,
  qualifiedPreparedRepositoryRecord,
} from './prepared-repository-candidate-fixture.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import { snapshotRepositoryTaskCheckout } from '../repository-task-checkout.js';
import { OrdinaryLocalCodexOwnedRuntime } from '../ordinary-local-codex-owned-runtime.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { withPreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';
import {
  PendingHostTaskDecisionScopeSchema,
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
} from '../pending-host-task.js';

vi.mock('../auth.js', async (original) => ({
  ...(await original<typeof import('../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));
const physical = vi.hoisted(() => ({ reader: vi.fn(), creation: vi.fn() }));
vi.mock('../local-repository-native-read.js', () => ({
  capturePreparedRepositoryReader: physical.reader,
}));
vi.mock('../qualified-local-repository-task.js', async (original) => ({
  ...(await original<typeof import('../qualified-local-repository-task.js')>()),
  captureQualifiedLocalRepositoryTask: physical.creation,
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
vi.setConfig({ testTimeout: 90000 }); // Multiple independent 30s physical validations plus setup/cleanup.
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
const numeric = (identity: { dev: string; ino: string }) => ({
  dev: Number(identity.dev),
  ino: Number(identity.ino),
});

/** Real runtime/bootstrap/login/selection/admission, SQLite producer+CAS+FIFO.
 * Creation actor is synthetic and physical read transport is the controlled
 * descriptor fixture, NOT SRT/native actor qualification or a real model call. */
async function fixture() {
  const f = await ownedRuntimeFixture(cleanups, { localRepository: true });
  const native = new CodexConversationStore(join(f.root, 'native-transition.db'));
  cleanups.push(() => native.close());
  native.create(f.reservation.conversationId, f.reservation.binding, f.reserved.directory!);
  const runtime = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    nativeStore: native,
    dispatchContinuation: async (value) => {
      const input = {
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.intent,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      };
      value.admission.assertBeforeEnqueue(input);
      native.enqueue(value.sessionId, value.lease.binding, input);
    },
    dispatch: async (value) => {
      await f.dispatch(value);
      value.admission.persistCustody(native);
      const input = {
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.intent,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      };
      value.admission.assertBeforeEnqueue(input);
      native.enqueue(value.sessionId, value.lease.binding, input);
    },
  });
  cleanups.push(() => runtime.close());
  await runtime.admit(f.request);
  const first = f.dispatch.mock.calls[0][0],
    admission = first.admission;
  const binding = AccountBindingSchema.parse(first.lease.binding);
  native.bindThread(
    first.sessionId,
    first.lease.binding,
    'thread',
    createHash('sha256')
      .update(JSON.stringify(codexDynamicToolsOption([])))
      .digest('hex'),
  );
  const command = native.claimNext(first.sessionId, first.lease.binding)!;
  admission.assertBeforeDispatch(command.id);
  const policy = () =>
    codexNativeExecutionPolicy({
      bindingRevision: first.lease.binding.profileRevision!,
      mode: 'agent',
      cwd: first.expected.workspace.cwd,
      readableRoots: ['/'],
      writableRoots: [first.expected.workspace.cwd],
      deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
      writeProtectedRoots: [],
    });
  native.prepareNativeExecution(first.sessionId, first.lease.binding, command, 'thread', policy());
  native.recordNativeTurnAck(first.sessionId, first.lease.binding, command, 'thread', 'turn');
  native.acceptNativeExecution(first.sessionId, first.lease.binding, command, 'thread', 'turn');
  const source = Object.freeze({
    commandId: command.id,
    attempt: command.attempt,
    threadId: 'thread',
    turnId: 'turn',
    generation: 0,
  });
  const privateCloses: Array<() => void> = [];
  const templates = preparedRepositoryCandidateFixture(privateCloses);
  cleanups.push(...privateCloses);
  let record = templates.pending();
  const sourcePath = join(f.root, 'source'),
    taskRoot = f.reservation.taskRoot,
    directory = join(taskRoot, `repo-${record.id}`),
    featureBranch = `mitzo/repo-${record.id}`;
  git(sourcePath, 'worktree', 'add', '-qb', featureBranch, directory);
  const sourceIdentity = {
    selection: 'existing' as const,
    repositoryId: 'existing-fixture',
    path: sourcePath,
    root: numeric((await fixtureReadAnchor(sourcePath)).identity),
    commonDirectory: join(sourcePath, '.git'),
    commonRoot: numeric((await fixtureReadAnchor(join(sourcePath, '.git'))).identity),
  };
  const taskIdentity = await snapshotRepositoryTaskCheckout(
    directory,
    featureBranch,
    sourceIdentity,
  );
  const request = {
    ...record.pendingHostTask!.request,
    binding,
    runtimeBinding: first.expected.binding,
    conversationId: first.sessionId,
    nativeTarget: source,
    taskRoot,
  };
  const oldWorkspace = {
    kind: 'repository' as const,
    id: first.workspace.id,
    directory: first.workspace.directory!,
  };
  const effect = {
    kind: 'local-repository-worktree' as const,
    workspaceId: record.id,
    featureBranch,
    baseOid: git(sourcePath, 'rev-parse', 'HEAD'),
    source: {
      path: sourcePath,
      gitDirectory: join(sourcePath, '.git'),
      commonDirectory: join(sourcePath, '.git'),
    },
    task: { taskRoot, directory, adminBasename: `repo-${record.id}` },
  };
  const scope = PendingHostTaskDecisionScopeSchema.parse({
    ...record.pendingHostTaskDecision!.scope,
    oldWorkspace,
    create: { ...effect, intent: 'create' },
    use: { ...effect, intent: 'use' },
    sourceIdentity,
    taskRootIdentity: numeric((await fixtureReadAnchor(taskRoot)).identity),
    sourceGitEffects: {
      administrationDirectory: taskIdentity.linkedGit!.directory,
      branchReference: join(sourcePath, '.git', 'refs', 'heads', featureBranch),
      branchReferenceLock: join(sourcePath, '.git', 'refs', 'heads', featureBranch) + '.lock',
      branchLog: join(sourcePath, '.git', 'logs', 'refs', 'heads', featureBranch),
    },
  });
  record = {
    ...record,
    binding,
    featureBranch,
    baseOid: effect.baseOid,
    localSource: sourceIdentity,
    ordinaryPreparation: {
      ...record.ordinaryPreparation!,
      originalBinding: binding,
      runtimeBinding: first.expected.binding,
    },
    pendingHostTask: {
      ...record.pendingHostTask!,
      request,
      rootIdentity: scope.taskRootIdentity,
      directory,
      taskIdentity,
    },
    pendingHostTaskDecision: {
      ...record.pendingHostTaskDecision!,
      request,
      scope,
      scopeSha256: pendingHostTaskDecisionHash(scope),
    },
  };
  record.pendingHostTaskDecision!.evidence = {
    ...record.pendingHostTaskDecision!.evidence,
    sessionId: first.sessionId,
    toolUseID: request.prepareCallId,
    input: pendingHostTaskDecisionPayload(request, scope),
    inputSha256: pendingHostTaskDecisionHash(pendingHostTaskDecisionPayload(request, scope)),
  };
  record = qualifiedPreparedRepositoryRecord(record, {
    binding,
    conversationId: first.sessionId,
    sourceTarget: source,
    oldWorkspace,
  });
  const qualified = record.qualifiedLocalPreparation!;
  qualified.allocationFacts = {
    ...qualified.allocationFacts,
    source: {
      ...qualified.allocationFacts.source,
      sourceAnchor: await fixtureReadAnchor(sourcePath),
      commonAnchor: await fixtureReadAnchor(join(sourcePath, '.git')),
    },
    taskRoot: await fixtureReadAnchor(taskRoot),
  };
  qualified.allocationFactsSha256 = pendingHostTaskDecisionHash(qualified.allocationFacts);
  record.sourceDigest = record.pendingHostTask!.sourceDigest = qualified.allocationFactsSha256;
  const decision = record.pendingHostTaskDecision!;
  decision.scope = PendingHostTaskDecisionScopeSchema.parse({
    ...decision.scope,
    sourceDigest: record.sourceDigest,
    allocationFactsSha256: record.sourceDigest,
    anchorsSha256: localRepositoryPreparationSourceFacts(qualified.allocationFacts).anchorsSha256,
  });
  decision.scopeSha256 = pendingHostTaskDecisionHash(decision.scope);
  decision.evidence.input = pendingHostTaskDecisionPayload(request, decision.scope);
  decision.evidence.inputSha256 = pendingHostTaskDecisionHash(decision.evidence.input);
  record.qualifiedLocalPreparation!.publication = { version: 1, directories: [], files: [] };
  const db = new Database(join(f.root, 'repositories', 'workspaces.db'));
  cleanups.push(() => {
    db.close();
  });
  db.prepare('INSERT INTO repository_workspaces VALUES(?,?,NULL)').run(
    record.id,
    JSON.stringify(record),
  );
  physical.creation.mockImplementation(async () => {
    const task = structuredClone(taskIdentity);
    delete task.localSource;
    return task;
  });
  const disposals = vi.fn(async () => {});
  physical.reader.mockImplementation(async (readScope, options) => {
    await readScope.revalidate();
    return {
      deadline: options.deadline,
      signal: readScope.signal,
      deniedRoots: readScope.deniedRoots,
      assertReadable: async () => readScope.assertCurrentSync(),
      assertCurrentSync: () => readScope.assertCurrentSync(),
      revalidate: () => readScope.revalidate(),
      captureReadAnchor: fixtureReadAnchor,
      dispose: disposals,
    };
  });
  const identity = {
    ...source,
    callId: request.prepareCallId,
    toolName: 'PrepareLocalRepository' as const,
    requestHash: request.requestHash,
  };
  native.claimTool(
    first.sessionId,
    first.lease.binding,
    command.id,
    request.prepareCallId,
    identity,
  );
  native.recordToolResult(
    first.sessionId,
    first.lease.binding,
    command.id,
    request.prepareCallId,
    identity,
    { content: JSON.stringify({ preparationId: record.id }), isError: false },
  );
  native.finish(first.sessionId, first.lease.binding, command.id, 'completed', 'turn');
  let cwd = first.expected.workspace.cwd;
  const currentPolicy = () =>
    codexNativeExecutionPolicy({
      bindingRevision: first.lease.binding.profileRevision!,
      mode: 'agent',
      cwd,
      readableRoots: ['/'],
      writableRoots: [cwd],
      deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
      writeProtectedRoots: [],
    });
  const owner = Object.freeze({
    signal: f.signal.signal,
    selectedPolicy: currentPolicy,
    assertCurrentSync: () => admission.assertCurrentSync(),
  });
  const conversation = vi.fn();
  const adopt = async () =>
    withPreparedRepositoryBarrierReadScope(
      currentPolicy(),
      source.commandId,
      {
        signal: f.signal.signal,
        selectedPolicy: currentPolicy,
        assertCurrentSync: () => admission.assertPreparedRepositoryBoundaryCurrentSync(),
        revalidate: () => admission.assertCurrent(),
      },
      (scope) => admission.adoptPreparedRepositoryAtBoundary(scope, source, conversation, owner),
    );
  return {
    ...f,
    runtime,
    native,
    first,
    admission,
    record,
    source,
    adopt,
    disposals,
    conversation,
    setCwd: (next: string) => {
      cwd = next;
    },
  };
}
it('adopts through the genuine retained bootstrap selection and actual repository CAS, then validates later add/commit without recursion', async () => {
  const f = await fixture();
  await writeFile(join(f.first.workspace.directory!, 'dirty.txt'), 'Retain original work');
  const result = await f.adopt();
  expect(result?.id).toBe(f.record.id);
  f.setCwd(result!.directory);
  expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.record.id);
  expect(f.events.getSession(f.first.sessionId)?.cwd).toBe(result!.directory);
  expect(f.native.read(f.first.sessionId, f.first.lease.binding).cwd).toBe(result!.directory);
  const child = f.native
    .commands(f.first.sessionId, f.first.lease.binding)
    .find((command) => command.status === 'queued')!;
  expect(child.environmentContinuation).toEqual({
    sourceCommandId: f.source.commandId,
    sourceThreadId: f.source.threadId,
    sourceTurnId: f.source.turnId,
    sourceGeneration: f.source.generation,
  });
  expect(f.events.observePreparedRepositoryContinuation(child.id).state).toBe('consumed');
  expect(f.admission.nativeExecutionWorkspace(child.id).cwd).toBe(result!.directory);
  expect(await readFile(join(f.first.workspace.directory!, 'dirty.txt'), 'utf8')).toBe(
    'Retain original work',
  );
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.first.lease.client).toBe(f.rpc);
  await writeFile(join(result!.directory, 'task.txt'), 'Legitimate new task work');
  git(result!.directory, 'add', '.');
  git(result!.directory, 'commit', '-qm', 'task change');
  await f.first.lease.assertCurrent();
  expect(f.disposals).toHaveBeenCalled();
});
it('admits a later explicit follow-up through the actual adopted primary and unchanged original bootstrap', async () => {
  const f = await fixture();
  const result = await f.adopt();
  f.setCwd(result!.directory);
  const followup = {
    ...structuredClone(f.request),
    clientMsgId: 'explicit-followup',
    payload: { text: 'Continue in the adopted primary' },
  };
  await expect(f.runtime.admitContinuation(followup)).resolves.toEqual({ dispatched: true });
  expect(f.admission.nativeExecutionWorkspace(followup.clientMsgId).cwd).toBe(result!.directory);
});
it('serializes config and metadata-only thread resume for the adopted primary on the already qualified client', async () => {
  const f = await fixture();
  const result = await f.adopt();
  f.setCwd(result!.directory);
  // Reinitialize the retained thread on the SAME admitted lease and SAME
  // mocked client. No new bootstrap, creation actor or model call occurs.
  const originalRequest = f.rpc.request.getMockImplementation()!;
  const request = vi.spyOn(f.first.lease.client, 'request');
  const packets: Array<{ method: string; params: Record<string, unknown> }> = [];
  request.mockImplementation(async (method, params) => {
    packets.push({ method, params });
    if (method === 'thread/resume')
      return {
        thread: { id: 'thread' },
        model: f.first.lease.binding.model,
        modelProvider: 'openai',
      };
    return originalRequest(method);
  });
  const policy = codexNativeExecutionPolicy({
    bindingRevision: f.first.lease.binding.profileRevision!,
    mode: 'agent',
    cwd: result!.directory,
    readableRoots: ['/'],
    writableRoots: [result!.directory],
    deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
    writeProtectedRoots: [],
  });
  const retained = new CodexConversation({
    conversationId: f.first.sessionId,
    cwd: result!.directory,
    profile: f.first.profile,
    storedBinding: f.first.lease.binding,
    store: f.native,
    systemPrompt: f.first.payload.systemPrompt,
    tools: [],
    // Packet-only reinitialization on the already attached client. The existing
    // bridge remains one-shot; this does not qualify post-loss reattachment.
    createClient: () => f.first.lease.client,
    emit: () => {},
    executeTool: async () => {
      throw Error('No tool dispatch during reinitialization');
    },
    verifyBinding: async () => {
      await f.admission.assertCurrent();
      return f.first.lease.binding;
    },
    nativeExecution: policy,
    assertNativeExecutionCurrent: () => f.admission.assertCurrentSync(),
    requestNativeApproval: async () => ({ decision: 'decline' }),
    startupSignal: f.signal.signal,
    transportClosure: 'terminal',
  });
  try {
    await retained.initialize();
    const configs = packets.filter((packet) => packet.method === 'config/read');
    expect(configs.length).toBeGreaterThan(0);
    expect(configs.every((packet) => packet.params.cwd === result!.directory)).toBe(true);
    expect(packets.find((packet) => packet.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread',
      cwd: result!.directory,
      permissions: policy.permissions,
    });
    expect(
      packets.some((packet) => packet.method === 'thread/start' || packet.method === 'turn/start'),
    ).toBe(false);
    expect(retained.getThreadId()).toBe('thread');
    expect(f.launch).toHaveBeenCalledOnce();
  } finally {
    retained.close();
  }
});
it('refuses queued old-workspace work before child reservation or repository custody changes', async () => {
  const f = await fixture();
  f.native.enqueue(f.first.sessionId, f.first.lease.binding, {
    id: 'later-user',
    prompt: 'Later user command',
  });
  await expect(f.adopt()).rejects.toThrow();
  expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.first.workspace.id);
  expect(
    f.native
      .commands(f.first.sessionId, f.first.lease.binding)
      .filter((command) => command.environmentContinuation),
  ).toHaveLength(0);
});

it.each(['close-during-capture', 'queue-during-capture'] as const)(
  'refuses %s through the original real barrier before reserving or adopting',
  async (phase) => {
    const f = await fixture();
    const original = physical.creation.getMockImplementation()!;
    physical.creation.mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      if (phase === 'close-during-capture') f.runtime.close();
      else
        f.native.enqueue(f.first.sessionId, f.first.lease.binding, {
          id: 'raced-followup',
          prompt: 'Later explicit user request',
        });
      return value;
    });
    const cas = vi.spyOn(f.workspace, 'adoptPreparedRepositoryTransition');
    await expect(f.adopt()).rejects.toThrow();
    expect(cas).not.toHaveBeenCalled();
    expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.first.workspace.id);
    expect(
      f.native
        .commands(f.first.sessionId, f.first.lease.binding)
        .filter((command) => command.environmentContinuation),
    ).toHaveLength(0);
  },
);
it('retains actual cross-store uncertainty and refuses a replay after native cwd persistence fails', async () => {
  const f = await fixture();
  const original = f.native.adoptPreparedRepositoryWorkspace.bind(f.native);
  vi.spyOn(f.native, 'adoptPreparedRepositoryWorkspace').mockImplementation((...args) => {
    original(...args);
    throw Error('Lost native cwd commit acknowledgment');
  });
  const cas = vi.spyOn(f.workspace, 'adoptPreparedRepositoryTransition');
  await expect(f.adopt()).rejects.toThrow('Lost native cwd');
  expect(cas).toHaveBeenCalledOnce();
  const record = f.workspace.getForConversation(f.first.sessionId)!;
  const childId = record.preparedRepositoryTransitionAdoption!.childCommandId;
  expect(record.id).toBe(f.record.id);
  expect(f.events.observePreparedRepositoryContinuation(childId).state).toBe('uncertain');
  expect(() => f.admission.canClaimCommand(childId)).toThrow();
  const reopened = new CodexConversationStore(join(f.root, 'native-transition.db'));
  try {
    expect(reopened.read(f.first.sessionId, f.first.lease.binding).cwd).toBe(record.directory);
    expect(
      reopened
        .commands(f.first.sessionId, f.first.lease.binding)
        .some((command) => command.id === childId),
    ).toBe(false);
  } finally {
    reopened.close();
  }
  await expect(f.adopt()).rejects.toThrow();
  expect(cas).toHaveBeenCalledOnce();
  expect(await readFile(join(f.first.workspace.directory!, 'task.txt'), 'utf8')).toBe(
    'accepted source',
  );
});
