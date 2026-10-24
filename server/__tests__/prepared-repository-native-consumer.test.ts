import { createHash } from 'node:crypto';
import { nativeToolDefinitions } from '../native-tool-executor.js';
import { CodexAppServerClient } from '../codex-app-server-client.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { codexDynamicToolsOption } from '../codex-ordinary-packet.js';
import { CodexConversation } from '../codex-conversation.js';
import { FrozenHostCodexBootstrapAuthority } from '../frozen-host-codex-bootstrap.js';
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
vi.mock('../local-repository-native-read.js', async (original) => ({
  ...(await original<typeof import('../local-repository-native-read.js')>()),
  capturePreparedRepositoryReader: physical.reader,
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Offline fixture forbids SDK/model calls');
  },
  listSessions: () => [],
}));
// Synthetic frozen executable classification only; real artifact and SRT
// qualification remain separate. All native provider RPC is controlled below.
vi.mock('../codex-native-artifact-qualification.js', async (original) => ({
  ...(await original<typeof import('../codex-native-artifact-qualification.js')>()),
  assertQualifiedNativeMacExecutionArtifact: vi.fn(),
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

async function materializePreparation(
  f: Awaited<ReturnType<typeof ownedRuntimeFixture>>,
  first: import('../ordinary-local-codex-owned-runtime.js').OrdinaryLocalCodexOwnedDispatch,
  source: import('../codex-conversation-store.js').CodexNativeTurnTarget,
) {
  const binding = AccountBindingSchema.parse(first.lease.binding);
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
    prepareCallId: `prepare-${source.commandId}`,
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
  return { record, request, taskIdentity };
}

/** Real runtime/bootstrap/login/selection/admission, SQLite producer+CAS+FIFO.
 * Creation actor is synthetic and physical read transport is the controlled
 * descriptor fixture, NOT SRT/native actor qualification or a real model call. */
async function fixture(chatRoute = false, operatorLifetimeMs?: number) {
  const f = await ownedRuntimeFixture(cleanups, {
    localRepository: true,
    chatRoute,
    operatorLifetimeMs,
    ...(chatRoute
      ? {
          tools: ['Bash', 'Read', 'Write', 'Edit'].map((name) => ({
            id: `mitzo:${name}`,
            version: 1,
          })),
        }
      : {}),
  });
  if (chatRoute) {
    vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', join(f.root, 'internal-token'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No network/model calls in qualified cold fixture');
      }),
    );
    const chat = await import('../chat.js');
    const { login, authenticateToken, setAuthRevocationStore } = await import('../auth.js');
    setAuthRevocationStore(chat.eventStore);
    f.detach();
    const auth = (await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!))!;
    cleanups.push(bindAgentLibraryTransport(f.dependencies.operatorConnectionId, auth));
    f.auth = auth;
    cleanups.push(() => chat.eventStore.close());
  }
  const native = chatRoute
    ? (await import('../codex-chat-session.js')).getCodexConversationStore()
    : new CodexConversationStore(join(f.root, 'native-transition.db'));
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
  native.bindThread(
    first.sessionId,
    first.lease.binding,
    'thread',
    createHash('sha256')
      .update(
        JSON.stringify(
          codexDynamicToolsOption(
            chatRoute
              ? nativeToolDefinitions.filter((tool) => tool.name === 'AskUserQuestion')
              : [],
          ),
        ),
      )
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
  const { record, request, taskIdentity } = await materializePreparation(f, first, source);
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

it('cold-resumes a consumed qualified primary through a new genuine bootstrap, preserving queued-child FIFO and current history', async () => {
  const f = await fixture(false, 300000);
  const result = await f.adopt();
  f.setCwd(result!.directory);
  const sessionId = f.first.sessionId,
    binding = f.first.lease.binding;
  const queued = f.native
    .commands(sessionId, binding)
    .find((command) => command.status === 'queued')!;
  const originalCustody = f.native.readHostCustody(sessionId, binding);
  const originalThread = f.native.read(sessionId, binding).threadId;
  const later = join(result!.directory, 'later-cold.txt');
  await writeFile(later, 'Uncommitted task data remains');
  f.runtime.close();
  const request = {
    ...structuredClone(f.request),
    clientMsgId: 'clean-cold-command',
    payload: { text: 'Continue original work after clean retirement' },
  };
  const freshClient = { ...f.rpc, close: vi.fn() };
  const dispatch = vi.fn(
    async (
      value: import('../ordinary-local-codex-owned-runtime.js').OrdinaryLocalCodexOwnedDispatch,
    ) => {
      expect(value.resume).toBe(true);
      expect(value.workspace.id).toBe(result!.id);
      expect(value.expected.workspace.cwd).toBe(result!.directory);
      expect(value.lease.privateHome).toBe(f.first.lease.privateHome);
      expect(value.lease.binding).toEqual(binding);
      expect(value.lease).not.toBe(f.first.lease);
      expect(value.lease.client).not.toBe(f.first.lease.client);
      await value.admission.assertCurrent();
      value.admission.assertOptions({
        conversationId: sessionId,
        messageId: request.clientMsgId,
        binding: value.lease.binding,
        profile: value.profile,
        session: { cwd: result!.directory, mode: 'agent' },
        prompt: value.payload.text,
        intent: value.payload.intent ?? value.payload.text,
        systemPrompt: value.payload.systemPrompt,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
        agentProfile: value.expected.agentProfile,
        agentContext: value.expected.agentContext,
        repositoryWorkspace: value.workspace,
        resume: true,
      });
      const input = {
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.intent ?? value.payload.text,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      };
      value.admission.assertBeforeEnqueue(input);
      f.native.enqueue(sessionId, binding, input);
    },
  );
  const cold = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    nativeStore: f.native,
    commandId: request.clientMsgId,
    reservation: { ...f.reservation, id: result!.id },
    launch: () => freshClient,
    dispatch,
  });
  cleanups.push(() => cold.close());
  await expect(cold.admitResume(request)).resolves.toEqual({ dispatched: true });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)).toMatchObject({
    state: 'consumed',
    preparedRepositoryPrimaryCommandId: queued.id,
  });
  expect(f.native.readHostCustody(sessionId, binding)).toEqual(originalCustody);
  expect(f.native.read(sessionId, binding).threadId).toBe(originalThread);
  expect(
    f.native
      .commands(sessionId, binding)
      .filter((c) => c.status === 'queued')
      .map((c) => c.id),
  ).toEqual([queued.id, request.clientMsgId]);
  const current = dispatch.mock.calls[0][0].admission;
  expect(current.canClaimCommand(queued.id)).toBe(true);
  expect(current.currentPreparedRepositoryPrimaryCommandId()).toBe(queued.id);
  expect(f.native.claimNext(sessionId, binding)?.id).toBe(queued.id);
  current.assertBeforeDispatch(queued.id);
  expect(await readFile(later, 'utf8')).toBe('Uncommitted task data remains');
  // Renew the SAME authenticated operator through the existing real owner,
  // rather than extending the old fixture's expiry for this longer journey.
  const renewedConnection = 'renewed-cold-operator';
  cleanups.push(
    bindAgentLibraryTransport(renewedConnection, { ...f.auth, expiresAt: Date.now() + 300000 }),
  );
  cold.reauthorize(renewedConnection);
  const packet = dispatch.mock.calls[0][0];
  const currentPolicy = () =>
    codexNativeExecutionPolicy({
      bindingRevision: binding.profileRevision!,
      mode: 'agent',
      cwd: result!.directory,
      readableRoots: ['/'],
      writableRoots: [result!.directory],
      deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
      writeProtectedRoots: [],
    });
  const queuedCommand = f.native.commands(sessionId, binding).find((c) => c.id === queued.id)!;
  f.native.prepareNativeExecution(sessionId, binding, queuedCommand, 'thread', currentPolicy());
  f.native.recordNativeTurnAck(sessionId, binding, queuedCommand, 'thread', 'queued-cold-turn');
  f.native.acceptNativeExecution(sessionId, binding, queuedCommand, 'thread', 'queued-cold-turn');
  f.native.finish(sessionId, binding, queuedCommand.id, 'completed', 'queued-cold-turn');
  const sourceCommand = f.native.claimNext(sessionId, binding)!;
  current.assertBeforeDispatch(sourceCommand.id);
  f.native.prepareNativeExecution(sessionId, binding, sourceCommand, 'thread', currentPolicy());
  f.native.recordNativeTurnAck(sessionId, binding, sourceCommand, 'thread', 'explicit-cold-turn');
  f.native.acceptNativeExecution(sessionId, binding, sourceCommand, 'thread', 'explicit-cold-turn');
  const source = Object.freeze({
    commandId: sourceCommand.id,
    attempt: sourceCommand.attempt,
    threadId: 'thread',
    turnId: 'explicit-cold-turn',
    generation: 0,
  });
  const second = await materializePreparation(f, packet, source);
  physical.creation.mockImplementation(async () => {
    const task = structuredClone(second.taskIdentity);
    delete task.localSource;
    return task;
  });
  const identity = {
    ...source,
    callId: second.request.prepareCallId,
    toolName: 'PrepareLocalRepository' as const,
    requestHash: second.request.requestHash,
  };
  f.native.claimTool(sessionId, binding, source.commandId, second.request.prepareCallId, identity);
  f.native.recordToolResult(
    sessionId,
    binding,
    source.commandId,
    second.request.prepareCallId,
    identity,
    { content: JSON.stringify({ preparationId: second.record.id }), isError: false },
  );
  f.native.finish(sessionId, binding, source.commandId, 'completed', source.turnId);
  expect(
    f.native.completedPreparedRepositoryResultSha256(
      sessionId,
      binding,
      source,
      second.request.prepareCallId,
      second.request.requestHash,
    ),
  ).toMatch(/^[a-f0-9]{64}$/);

  const policyOwner = Object.freeze({
    signal: f.signal.signal,
    selectedPolicy: currentPolicy,
    assertCurrentSync: () => current.assertCurrentSync(),
  });
  const secondResult = await withPreparedRepositoryBarrierReadScope(
    currentPolicy(),
    source.commandId,
    {
      signal: f.signal.signal,
      selectedPolicy: currentPolicy,
      assertCurrentSync: () => current.assertPreparedRepositoryBoundaryCurrentSync(),
      revalidate: () => current.assertCurrent(),
    },
    (scope) => current.adoptPreparedRepositoryAtBoundary(scope, source, () => {}, policyOwner),
  );
  expect(secondResult?.id).toBe(second.record.id);
  const nextPrimary =
    f.workspace.getForConversation(sessionId)!.preparedRepositoryTransitionAdoption!.childCommandId;
  expect(f.events.observePreparedRepositoryContinuation(nextPrimary)).toMatchObject({
    state: 'consumed',
    preparedRepositoryTransition: {
      priorPrimaryCommandId: queued.id,
      source: { commandId: request.clientMsgId },
    },
  });
  expect(f.native.readHostCustody(sessionId, binding)).toEqual(originalCustody);
  expect(f.native.read(sessionId, binding).threadId).toBe(originalThread);
  expect(await readFile(later, 'utf8')).toBe('Uncommitted task data remains');
}, 180000);

it('refuses partial, mismatched and revoked qualified cold owners before effects, and requires fresh physical validation before config', async () => {
  const f = await fixture();
  const result = await f.adopt();
  f.setCwd(result!.directory);
  f.runtime.close();
  const sessionId = f.first.sessionId,
    binding = f.first.lease.binding;
  const primary =
    f.workspace.getForConversation(sessionId)!.preparedRepositoryTransitionAdoption!.childCommandId;
  const eventDb = new Database(join(f.root, 'events.db'));
  const repositoryDb = new Database(join(f.root, 'repositories', 'workspaces.db'));
  const nativeDb = new Database(join(f.root, 'native-transition.db'));
  cleanups.push(
    () => {
      eventDb.close();
    },
    () => {
      repositoryDb.close();
    },
    () => {
      nativeDb.close();
    },
  );
  const savedEvent = (
    eventDb
      .prepare('SELECT ordinary_admission FROM send_commands WHERE client_msg_id=?')
      .get(primary) as { ordinary_admission: string }
  ).ordinary_admission;
  const savedRepository = (
    repositoryDb.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(result!.id) as {
      record: string;
    }
  ).record;
  const make = (name: string) => {
    const request = {
      ...structuredClone(f.request),
      clientMsgId: `refused-cold-${name}`,
      payload: { text: 'Continue only current authorized work' },
    };
    const dispatch = vi.fn(async () => {}),
      launch = vi.fn(() => f.rpc);
    const driver = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: result!.id },
      dispatch,
      launch,
    });
    cleanups.push(() => driver.close());
    return { driver, request, dispatch, launch };
  };
  for (const changed of [
    'uncertain',
    'missing-witness',
    'wrong-cwd',
    'running',
    'wrong-account',
  ] as const) {
    if (changed === 'uncertain')
      eventDb
        .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
        .run(JSON.stringify({ ...JSON.parse(savedEvent), state: 'uncertain' }), primary);
    if (changed === 'missing-witness') {
      const row = JSON.parse(savedRepository);
      delete row.preparedRepositoryTransitionAdoption;
      repositoryDb
        .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
        .run(JSON.stringify(row), result!.id);
    }
    if (changed === 'wrong-cwd')
      nativeDb
        .prepare('UPDATE codex_conversations SET cwd=? WHERE id=?')
        .run(f.first.workspace.directory, sessionId);
    if (changed === 'running')
      nativeDb.prepare("UPDATE codex_commands SET status='running' WHERE id=?").run(primary);
    const next = make(changed);
    if (changed === 'wrong-account') next.request.runtime.account.accountId = 'other';
    await expect(next.driver.admitResume(next.request)).rejects.toThrow();
    expect(next.launch).not.toHaveBeenCalled();
    expect(next.dispatch).not.toHaveBeenCalled();
    expect(f.events.getSendCommand(next.request.clientMsgId)).toBeUndefined();
    next.driver.close();
    eventDb
      .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
      .run(savedEvent, primary);
    repositoryDb
      .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
      .run(savedRepository, result!.id);
    nativeDb
      .prepare('UPDATE codex_conversations SET cwd=? WHERE id=?')
      .run(result!.directory, sessionId);
    nativeDb.prepare("UPDATE codex_commands SET status='queued' WHERE id=?").run(primary);
  }
  const failed = make('physical');
  f.rpc.request.mockClear();
  f.rpc.close.mockClear();
  physical.reader.mockRejectedValueOnce(Error('Fresh physical owner unavailable'));
  await expect(failed.driver.admitResume(failed.request)).rejects.toThrow();
  expect(failed.launch).toHaveBeenCalledOnce();
  expect(failed.dispatch).not.toHaveBeenCalled();
  expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('config/read');
  expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('model/list');
  expect(f.rpc.close).toHaveBeenCalled();
  expect(f.events.getOrdinaryLocalCommandAdmission(failed.request.clientMsgId)?.state).toBe(
    'uncertain',
  );
  expect(
    f.native
      .commands(sessionId, binding)
      .some((command) => command.id === failed.request.clientMsgId),
  ).toBe(false);
});

it('reaches fresh qualified cold admission through the actual public owned entry after clean retirement and refuses a competing registered owner', async () => {
  const f = await fixture(true),
    result = await f.adopt();
  f.setCwd(result!.directory);
  const completedPrimary = f.native.claimNext(f.first.sessionId, f.first.lease.binding)!;
  f.admission.assertBeforeDispatch(completedPrimary.id);
  const completedPolicy = codexNativeExecutionPolicy({
    bindingRevision: f.first.lease.binding.profileRevision!,
    mode: 'agent',
    cwd: result!.directory,
    readableRoots: ['/'],
    writableRoots: [result!.directory],
    deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
    writeProtectedRoots: [],
  });
  f.native.prepareNativeExecution(
    f.first.sessionId,
    f.first.lease.binding,
    completedPrimary,
    'thread',
    completedPolicy,
  );
  f.native.recordNativeTurnAck(
    f.first.sessionId,
    f.first.lease.binding,
    completedPrimary,
    'thread',
    'pre-public-turn',
  );
  f.native.acceptNativeExecution(
    f.first.sessionId,
    f.first.lease.binding,
    completedPrimary,
    'thread',
    'pre-public-turn',
  );
  f.native.finish(
    f.first.sessionId,
    f.first.lease.binding,
    completedPrimary.id,
    'completed',
    'pre-public-turn',
  );
  f.runtime.close();
  const chat = await import('../chat.js'),
    native = await import('../codex-chat-session.js');
  const workspaceRuntime = await import('../repository-workspace-runtime.js'),
    libraryRuntime = await import('../agent-library-runtime.js');
  vi.spyOn(workspaceRuntime, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(libraryRuntime, 'getAgentLibrary').mockReturnValue(f.library);
  const sessionId = f.first.sessionId,
    binding = f.first.lease.binding;
  const custody = f.native.readHostCustody(sessionId, binding);
  expect(chat.registry.findBySessionId(sessionId)).toBeFalsy();
  expect(chat.canResumeOwnedLocalCodexDriver(sessionId, f.auth.id)).toBe(true);
  const request = {
    ...structuredClone(f.request),
    clientMsgId: 'public-qualified-cold',
    payload: { text: 'Continue the same saved task' },
  };
  const underlying = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method, params?: Record<string, unknown>) => {
    if (method === 'thread/resume')
      return { thread: { id: 'thread' }, model: 'fixture-model', modelProvider: 'openai' };
    if (method === 'turn/start')
      return { turn: { id: `public-cold-${String(params?.clientUserMessageId)}` } };
    return underlying(method);
  });
  const launch = vi
    .spyOn(CodexAppServerClient, 'launchIsolated')
    .mockReturnValue({ ...f.rpc, close: vi.fn() } as never);
  const clientId = `public-cold:${sessionId}`;
  cleanups.push(async () => {
    chat.registry.abort(clientId);
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeFalsy());
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  let startupFailure: string | undefined;
  const initialize = CodexConversation.prototype.initialize;
  vi.spyOn(CodexConversation.prototype, 'initialize').mockImplementation(async function (
    this: CodexConversation,
  ) {
    try {
      return await initialize.call(this);
    } catch (error) {
      startupFailure = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      throw error;
    }
  });
  const attempt = chat.startOwnedLocalCodexCommand(
    { send: vi.fn(), isOpen: () => true },
    clientId,
    {
      command: request,
      reservation: { ...f.reservation, id: result!.id },
      commandId: request.clientMsgId,
      operatorConnectionId: f.dependencies.operatorConnectionId,
      ownerConnectionId: f.dependencies.operatorConnectionId,
      signal: f.signal.signal,
      resume: true,
    },
  );
  const evidencePath = `/private/tmp/qualified-cold-public-${Date.now()}.json`;
  try {
    await expect(attempt).resolves.toMatchObject({ dispatched: true, sessionId });
  } finally {
    await writeFile(
      evidencePath,
      JSON.stringify(
        { startupFailure, methods: f.rpc.request.mock.calls.map(([method]) => method) },
        null,
        2,
      ),
    );
  }

  let cleanRetired = false;
  try {
    const registered = chat.registry.findBySessionId(sessionId)!;
    expect(registered.session.cwd).toBe(result!.directory);
    expect(chat.canResumeOwnedLocalCodexDriver(sessionId, f.auth.id)).toBe(false);
    const competitor = { ...request, clientMsgId: 'competing-cold-command' };
    await expect(
      chat.startOwnedLocalCodexCommand({ send: vi.fn(), isOpen: () => true }, 'competing-client', {
        command: competitor,
        reservation: { ...f.reservation, id: result!.id },
        commandId: competitor.clientMsgId,
        operatorConnectionId: f.dependencies.operatorConnectionId,
        signal: f.signal.signal,
        resume: true,
      }),
    ).rejects.toThrow();

    expect(launch).toHaveBeenCalledOnce();
    expect(f.native.readHostCustody(sessionId, binding)).toEqual(custody);
    const packets = f.rpc.request.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(packets.find(([method]) => method === 'thread/resume')?.[1]).toMatchObject({
      threadId: 'thread',
      cwd: result!.directory,
      permissions: 'mitzo-native-agent',
    });
    expect(packets.some(([method]) => method === 'thread/start')).toBe(false);
    expect(native.getCodexRuntime(registered.session)).toBeDefined();
    await vi.waitFor(
      () => {
        const command = f.native
          .commands(sessionId, binding)
          .find((c) => c.id === request.clientMsgId)!;
        expect(f.native.readNativeExecution(sessionId, binding, command)).toMatchObject({
          phase: 'accepted',
          turnId: `public-cold-${request.clientMsgId}`,
        });
        expect(
          f.native.nativeTurnTarget(sessionId, binding, command.id, command.attempt)?.turnId,
        ).toBe(`public-cold-${request.clientMsgId}`);
      },
      { timeout: 120000 },
    );
    const lifecycle = launch.mock.calls[0][2]!;
    lifecycle.onNotification('turn/completed', {
      threadId: 'thread',
      turn: { id: `public-cold-${request.clientMsgId}`, status: 'completed' },
    });
    await vi.waitFor(
      () =>
        expect(f.native.commandStatus(sessionId, binding, request.clientMsgId)).toBe('completed'),
      { timeout: 30000 },
    );
    registered.session.queryInstance!.close();
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeFalsy());
    expect(chat.eventStore.getSession(sessionId)?.state).toBe('ENDED');
    expect(chat.canResumeOwnedLocalCodexDriver(sessionId, f.auth.id)).toBe(true);
    expect(f.native.readHostCustody(sessionId, binding)).toEqual(custody);
    cleanRetired = true;
  } finally {
    const command = f.native.commands(sessionId, binding).find((c) => c.id === request.clientMsgId);
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          startupFailure,
          methods: f.rpc.request.mock.calls.map(([method]) => method),
          status: command?.status,
          nativeReceiptPhase:
            command && f.native.readNativeExecution(sessionId, binding, command)?.phase,
          registryPresent: !!chat.registry.findBySessionId(sessionId),
          sessionState: chat.eventStore.getSession(sessionId)?.state,
          cleanRetired,
        },
        null,
        2,
      ),
    );
  }
}, 300000);

it.each(['native-custody', 'bootstrap-lease'] as const)(
  'rejects original %s owner method replacement during cold reopening before any physical read',
  async (ownerKind) => {
    const f = await fixture(),
      result = await f.adopt();
    f.setCwd(result!.directory);
    f.runtime.close();
    const request = {
      ...structuredClone(f.request),
      clientMsgId: 'cold-replaced-owner',
      payload: { text: 'Continue saved work' },
    };
    const dispatch = vi.fn(async () => {}),
      originalRpc = f.rpc.request.getMockImplementation()!,
      originalRead = f.native.read,
      originalLease = FrozenHostCodexBootstrapAuthority.prototype.currentLease;
    let replaced: ReturnType<typeof vi.spyOn> | undefined;
    f.rpc.request.mockImplementationOnce(async (method) => {
      replaced =
        ownerKind === 'native-custody'
          ? vi.spyOn(f.native, 'read').mockImplementation(function (...args) {
              return originalRead.apply(f.native, args);
            })
          : vi
              .spyOn(FrozenHostCodexBootstrapAuthority.prototype, 'currentLease')
              .mockImplementation(function (this: FrozenHostCodexBootstrapAuthority) {
                return originalLease.call(this);
              });
      return originalRpc(method);
    });
    const before = physical.reader.mock.calls.length,
      originalReader = physical.reader.getMockImplementation()!;
    physical.reader.mockRejectedValueOnce(
      Error('A substituted custody owner must not reach physical read'),
    );
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: result!.id },
      launch: () => ({ ...f.rpc, close: vi.fn() }),
      dispatch,
    });
    cleanups.push(() => cold.close());
    try {
      await expect(cold.admitResume(request)).rejects.toThrow();
      expect(replaced).toBeDefined();
      expect(physical.reader.mock.calls.length).toBe(before);
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)?.state).toBe(
        'uncertain',
      );
    } finally {
      replaced?.mockRestore();
      physical.reader.mockReset().mockImplementation(originalReader);
    }
  },
);

it.each(['physical-facet', 'lease-getter'] as const)(
  'enforces genuine async credential revocation despite a poisoned original %s call property',
  async (kind) => {
    const f = await fixture(),
      result = await f.adopt();
    f.setCwd(result!.directory);
    f.runtime.close();
    const prototype = FrozenHostCodexBootstrapAuthority.prototype;
    const originalGetter = prototype.currentLease;
    const previousCall = Object.getOwnPropertyDescriptor(originalGetter, 'call');
    const poisoned = vi.fn(
      async (
        _receiver: unknown,
        signal: AbortSignal,
        action: (owner: unknown) => Promise<void>,
      ) => {
        if (kind === 'lease-getter') return undefined;
        await action({
          signal,
          client: f.rpc,
          binding: f.first.lease.binding,
          assertCurrentSync() {},
          async revalidate() {},
        });
      },
    );
    let getter: ReturnType<typeof vi.spyOn> | undefined;
    if (kind === 'lease-getter') {
      Object.defineProperty(originalGetter, 'call', { value: poisoned, configurable: true });
    } else {
      getter = vi.spyOn(prototype, 'currentLease').mockImplementation(function (
        this: FrozenHostCodexBootstrapAuthority,
      ) {
        const lease = Reflect.apply(originalGetter, this, []);
        if (lease?.withQualifiedWorkspaceReadOwner)
          Object.defineProperty(lease.withQualifiedWorkspaceReadOwner, 'call', {
            value: poisoned,
            configurable: true,
          });
        return lease;
      });
    }
    const originalRpc = f.rpc.request.getMockImplementation()!;
    let reads = 0;
    f.rpc.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'account/read' && ++reads > 1)
        return {
          account: { type: 'chatgpt', email: 'revoked@example.invalid', planType: 'plus' },
        } as never;
      return Reflect.apply(originalRpc, f.rpc, [method, params]);
    });
    const before = physical.reader.mock.calls.length;
    const request = {
      ...structuredClone(f.request),
      clientMsgId: `cold-call-poison-${kind}`,
      payload: { text: 'Continue saved work' },
    };
    const dispatch = vi.fn(async () => {});
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: result!.id },
      launch: () => ({ ...f.rpc, close: vi.fn() }),
      dispatch,
    });
    cleanups.push(() => cold.close());
    f.rpc.request.mockClear();
    try {
      await expect(cold.admitResume(request)).rejects.toThrow();
      expect(poisoned).not.toHaveBeenCalled();
      expect(reads).toBeGreaterThan(1);
      expect(physical.reader.mock.calls.length).toBe(before);
      expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('config/read');
      expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('model/list');
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)?.state).toBe(
        'uncertain',
      );
    } finally {
      getter?.mockRestore();
      if (previousCall) Object.defineProperty(originalGetter, 'call', previousCall);
      else Reflect.deleteProperty(originalGetter, 'call');
    }
  },
);
