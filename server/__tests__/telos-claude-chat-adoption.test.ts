import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createTelosOrdinaryWorkFixture } from './fixtures/telos-ordinary-work.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eventStore as startupStore } from '../chat.js';
import { setAuthRevocationStore } from '../auth.js';
import { TelosItemStore } from '../telos-item-store.js';
import { createTelosSessionLaunchHost } from '../telos-session-launch-host.js';
import { TelosSessionProposalRefusal } from '../telos-session-proposal-refusal.js';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { createTelosAdoptionRuntime } from '../telos-adoption-runtime.js';
import { resolveTelosRepositoryChatSelection } from '../telos-repository-chat-selection.js';
import { telosWorkContext } from '../telos-work-observation.js';
import { resolveTelosWorkRoleContext } from '../telos-work-role-context.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
import { SessionLaunchStore } from '../session-launch-store.js';
import { SessionLaunchService } from '../session-launch-service.js';
import { sessionLaunchFailureCause } from '../session-launch-diagnostics.js';
import { sessionLaunchStartupBlocker } from '../session-launch-runtime.js';
import {
  isAvailableTelosWorkConversation,
  isAvailableTelosSourceConversation,
} from '../telos-work-conversation.js';
import type { RepositoryWorkspace } from '../repository-workspaces.js';
import type { SessionLaunchConfig, SessionRuntimeBindingV2 } from '@mitzo/protocol';
import { SessionRegistry } from '@mitzo/harness';

// Isolate chat's startup metadata before imports, exactly as the Codex role tests do.
const startup = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adoption-startup-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'controller-private'));
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', undefined);
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-only-claude-adoption-token',
  isValidInternalToken: () => false,
  createSignalCallbackToken: vi.fn(() => 'synthetic-callback'),
  revokeSignalCallbackToken: vi.fn(),
  isValidSignalCallbackToken: () => false,
}));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
beforeAll(() => setAuthRevocationStore(startupStore));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
afterAll(() => {
  startupStore.close();
  startup.remove();
  vi.unstubAllEnvs();
});

const claudeAccount = {
  accountId: 'claude-personal',
  accountLabel: 'Personal Claude',
  provider: 'anthropic-claude' as const,
  profileRevision: 'claude-profile-v1',
  model: 'opus',
};
const claudeBinding: SessionRuntimeBindingV2 = {
  version: 2,
  account: {
    accountId: claudeAccount.accountId,
    provider: claudeAccount.provider,
    profileRevision: claudeAccount.profileRevision,
  },
  harness: { implementation: 'claude-sdk' },
  execution: { location: 'local', targetId: 'local-mac', targetRevision: 'claude-target-v1' },
};
const hostIdentity = (path: string) => ({ path, dev: '1', ino: '2', uid: '501', mode: '448' });

/** Offline Telos owners over the existing Codex lead fixture, plus real
 * EventStore command, SDK custody and context owners for Local Mac Claude chats.
 * Only the repository checkout ledger lookup is synthetic for the Claude chats. */
async function adoptionFixture() {
  const f = await createTelosOrdinaryWorkFixture(cleanup);
  const items = new TelosItemStore(f.canonical.dbPath);
  cleanup.push(() => items.close());
  const profile = f.native.library.version(
    'user',
    f.input.settings.selection.agent.profileId,
    f.input.settings.selection.agent.revision,
  )!;
  const workspaces = new Map<string, RepositoryWorkspace>();
  const getForConversation = f.native.workspaces.getForConversation.bind(f.native.workspaces);
  vi.spyOn(f.native.workspaces, 'getForConversation').mockImplementation(
    (id) => workspaces.get(id) ?? getForConversation(id),
  );
  const validateHostTask = f.native.workspaces.validateHostTask.bind(f.native.workspaces);
  const hostValidations: string[] = [];
  vi.spyOn(f.native.workspaces, 'validateHostTask').mockImplementation(async (id, cwd) => {
    const record = workspaces.get(id);
    if (!record) return validateHostTask(id, cwd);
    if (record.directory !== cwd) throw Error('Changed Claude checkout');
    hostValidations.push(id);
    // Adoption only awaits the identity check; the checkout value is unused.
    return { directory: cwd } as unknown as Awaited<ReturnType<typeof validateHostTask>>;
  });
  /** An executed, idle Local Mac Claude chat: one consumed SDK command,
   * retained SDK custody and a claimed repository task. */
  const claudeChat = (options: { operator?: string; summary?: string } = {}) => {
    const sessionId = randomUUID(),
      workspaceId = randomUUID(),
      commandId = randomUUID();
    const cwd = join(f.native.root, 'claude-tasks', sessionId);
    mkdirSync(cwd, { recursive: true });
    const selection = {
      version: 1 as const,
      agent: f.input.settings.selection.agent,
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: 'opus',
      thinking: null,
    };
    const meta = {
      sessionId,
      repositoryWorkspaceId: workspaceId,
      cwd,
      accountBinding: claudeAccount,
      agentProfile: profile,
      selectedModel: 'opus',
      reasoningEffort: null,
      mode: 'agent' as const,
    };
    const events = f.native.events;
    events.admitOrdinaryLocalVertexCommand(meta, claudeBinding, {
      clientMsgId: commandId,
      requestFingerprint: randomUUID(),
      selection,
      payload: { text: 'Earlier Claude work' },
    });
    events.claimOrdinaryLocalVertexCommandDispatch(commandId);
    events.completeOrdinaryLocalVertexCommand(commandId);
    // The SDK took this input and its turn finished: no queued or live work.
    const fingerprint = randomUUID();
    const execution = events.beginExecution(sessionId, randomUUID(), commandId, fingerprint);
    events.transitionExecution(execution.token, 'TERMINAL', 'completed');
    events.retainOrdinaryLocalVertexCustody({
      version: 1,
      sessionId,
      sdkSessionId: sessionId,
      authSessionId: options.operator ?? f.actor.id,
      initialCommandId: commandId,
      repositoryWorkspaceId: workspaceId,
      cwd,
      binding: claudeBinding,
      credentialAuthority: {
        kind: 'claude-host-login',
        version: 1,
        email: 'person@example.test',
        planType: 'max',
        config: hostIdentity(join(f.native.root, 'claude-config')),
        executable: {
          ...hostIdentity(join(f.native.root, 'claude')),
          size: '1',
          mtimeNs: '1',
          ctimeNs: '1',
        },
      },
    });
    events.upsertSession({ sessionId, summary: options.summary ?? 'Existing Opus chat' });
    workspaces.set(sessionId, {
      id: workspaceId,
      conversationId: sessionId,
      state: 'claimed',
      sandbox: false,
      directory: cwd,
      featureBranch: `mitzo/repo-${workspaceId}`,
      binding: claudeAccount,
      hostReservation: { taskRoot: join(f.native.root, 'claude-tasks') },
    } as unknown as RepositoryWorkspace);
    return sessionId;
  };
  const registry = new SessionRegistry();
  const runtime = createTelosAdoptionRuntime({
    events: f.native.events,
    registry,
    native: () =>
      ({
        hasConversation: () => false,
        assertContextTransitionQuiescent: () => {},
      }) as never,
  });
  const retire = vi.spyOn(runtime, 'retire');
  const available = (id: string) =>
    isAvailableTelosWorkConversation(f.native.events.getSession(id));
  const sourceConversation = (id: string) =>
    isAvailableTelosSourceConversation(f.native.events.getSession(id));
  const resolveRuntime = vi.fn(async (settings: { binding: SessionRuntimeBindingV2 }) =>
    structuredClone(settings.binding),
  );
  const roleHost = createTelosWorkRoleHost({
    dbPath: () => f.canonical.dbPath,
    events: f.native.events,
    ordinaryConversation: available,
    sourceConversation,
    workspaces: () => f.native.workspaces,
    resolvePreparation: async () => {
      throw Error('Repository allocation must not run');
    },
    authorizeSettings: async () => {
      throw Error('Repository settings must not run');
    },
    ordinary: {
      adoption: runtime,
      resolveSelection: (scope, signal) =>
        scope.input.settings.workspace.kind === 'repository'
          ? resolveTelosRepositoryChatSelection(scope.input, signal, {
              events: f.native.events,
              workspaces: f.native.workspaces,
              resolveRuntime,
            })
          : Promise.resolve({
              binding: f.native.binding,
              agentProfile: profile,
              taskRoot: f.native.taskRoot,
            }),
      authorizeSettings: async (scope, signal) => {
        if (scope.setup.input.settings.workspace.kind === 'repository')
          await resolveTelosRepositoryChatSelection(scope.setup.input, signal, {
            events: f.native.events,
            workspaces: f.native.workspaces,
            resolveRuntime,
          });
      },
    },
  });
  const store = new SessionLaunchStore(':memory:');
  cleanup.push(() => store.close());
  const qualify = vi.fn(async () => {});
  const host = createTelosSessionLaunchHost({
    store,
    events: f.native.events,
    workspaces: () => f.native.workspaces,
    dbPath: () => f.canonical.dbPath,
    ordinaryConversation: available,
    sourceConversation,
    roleHost: () => roleHost,
    qualify,
    adoption: runtime,
    prepareSettings: async () => {
      throw Error('Adoption never prepares new settings');
    },
  });
  const ordinary = { validate: vi.fn(), start: vi.fn(), inspect: vi.fn() };
  const service = new SessionLaunchService(store, ordinary, host);
  const authority = {
    operatorConnectionId: 'reviewing-operator',
    authSessionId: f.actor.id,
    signal: f.native.signal.signal,
    assertCurrent: () => {},
  };
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  /** The same proposal → operator review → approval path as the tool and card. */
  const adopt = async (
    sourceSessionId: string,
    target: string,
    itemId: string,
    extra: { replaceOwner?: true } = {},
  ) => {
    const input = {
      requestId: randomUUID(),
      title: 'Adopt existing Claude chat',
      prompt: 'Review the adoption.',
      itemId,
      expectedRevision: items.read(itemId).revision,
      existingConversationId: target,
      sourceSnapshotIds: [],
      artifactRefs: [],
      ...extra,
    };
    const proposal = await host.propose(sourceSessionId, input, authority);
    const configuration = proposal.configuration as SessionLaunchConfig;
    const record = store.propose({
      title: input.title,
      prompt: input.prompt,
      configuration,
      ...proposal,
      sourceSessionId,
      requestId: input.requestId,
      operatorId: 'user',
      originalInput: input,
    });
    const edits = { title: input.title, prompt: input.prompt, configuration };
    const result = await service.approve(
      record.proposalId,
      'user',
      edits,
      record.revision,
      authority,
    );
    return { proposal, record, result, configuration };
  };
  const child = (parentId: string, summary: string, actorId: string) =>
    items.createChildGuarded(
      {
        parentId,
        expectedParentRevision: items.read(parentId).revision,
        requestId: randomUUID(),
        summary,
        intent: summary,
        rationale: 'Offline adoption coverage',
        acceptanceCriteria: ['Adopted Claude chat owns this work'],
        note: 'Offline fixture',
      },
      actorId,
      () => {},
      () => {},
    ).item.id;
  return {
    f,
    items,
    claudeChat,
    registry,
    runtime,
    retire,
    host,
    service,
    store,
    authority,
    qualify,
    reserve,
    ordinary,
    adopt,
    child,
    hostValidations,
  };
}

it('adopts an idle Claude chat as feature lead, which then adopts another Claude chat as slice worker', async () => {
  const x = await adoptionFixture();
  // Semantic outcome (runtime coordinator) -> feature (outcome) -> slice (work_item).
  const classify = (itemId: string, kind: 'coordinator' | 'outcome') =>
    x.f.work.execute(
      {
        operation: 'classify',
        itemId,
        kind,
        requestId: randomUUID(),
        expectedRevision: x.f.work.read(itemId, x.f.actor).revision,
      },
      x.f.actor,
    );
  classify('studio', 'coordinator');
  x.f.input.contextSelection = reviewTelosWorkRoleContext({
    work: x.f.work,
    artifacts: x.f.canonical.artifacts,
    actor: x.f.actor,
    itemId: 'studio',
    role: 'lead',
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: x.f.input.contextSelection.artifacts,
  });
  x.f.input.expectedRevision = x.f.input.contextSelection.brief.revision;
  // Current Codex outcome orchestrator, created through the existing owner.
  const outcome = await x.f.owner.setup(x.f.actor, x.f.input, x.f.native.signal.signal);
  x.reserve.mockClear(); // Only the Codex orchestrator's own creation allocates.
  const orchestrator = outcome.work.assignments.find((a) => a.role === 'lead')!.conversation
    .conversationId;
  const feature = x.child('studio', 'Claude-led feature', orchestrator);
  classify(feature, 'outcome');
  const lead = x.claudeChat({ summary: 'Opus feature lead' });
  const leadHistory = x.f.native.events.getSessionEvents(lead);
  const leadBefore = x.f.native.events.getSession(lead)!;

  const first = await x.adopt(orchestrator, lead, feature);
  expect(first.proposal.telos?.adoption).toMatchObject({
    conversationId: lead,
    workspaceKind: 'repository',
    title: 'Opus feature lead',
  });
  // Same review card configuration, on the chat's own Claude engine.
  expect(first.configuration.runtime.accountReference).toEqual(claudeBinding.account);
  expect(sessionLaunchStartupBlocker(first.configuration, 'session')).toBeNull();
  expect(x.qualify).toHaveBeenCalledWith(first.configuration, expect.anything(), {
    adoption: true,
  });
  if (first.result.state !== 'assigned')
    throw sessionLaunchFailureCause(first.record.proposalId) ?? Error(first.result.error);
  expect(first.result).toMatchObject({ state: 'assigned', childSessionId: lead, commandId: null });
  const featureWork = x.f.work.read(feature, x.f.actor);
  expect(
    featureWork.assignments.find((a) => a.role === 'lead')?.conversation.conversationId,
    JSON.stringify({ role: first.proposal.telos?.role, assignments: featureWork.assignments }),
  ).toBe(lead);
  // TelosManageItem overview projection: the Claude chat is the current lead.
  expect(telosWorkContext(featureWork, x.f.native.events).currentLead).toMatchObject({
    conversationId: lead,
    engine: 'claude-sdk',
  });
  // Retained account, model, workspace and history; no allocation or command.
  const leadAfter = x.f.native.events.getSession(lead)!;
  for (const field of [
    'accountBinding',
    'selectedModel',
    'reasoningEffort',
    'mode',
    'cwd',
    'repositoryWorkspaceId',
    'agentProfile',
  ] as const)
    expect(leadAfter[field]).toEqual(leadBefore[field]);
  expect(x.f.native.events.getSessionEvents(lead).slice(0, leadHistory.length)).toEqual(
    leadHistory,
  );
  expect(x.reserve).not.toHaveBeenCalled();
  expect(x.ordinary.start).not.toHaveBeenCalled();
  expect(x.retire).toHaveBeenCalledOnce();
  expect(x.hostValidations).toContain(lead);
  expect(
    resolveTelosWorkRoleContext(x.f.native.events, lead, leadAfter.accountBinding ?? undefined),
  ).toMatchObject({ role: 'lead', itemId: feature });

  // The adopted Claude lead now holds TelosCreateSession authority for its child.
  const slice = x.child(feature, 'Claude worker slice', lead);
  const worker = x.claudeChat({ summary: 'Opus slice worker' });
  const second = await x.adopt(lead, worker, slice);
  if (second.result.state !== 'assigned')
    throw sessionLaunchFailureCause(second.record.proposalId) ?? Error(second.result.error);
  expect(second.proposal.telos).toMatchObject({ role: 'worker', parentItemId: feature });
  const sliceWork = x.f.work.read(slice, x.f.actor);
  const context = telosWorkContext(sliceWork, x.f.native.events);
  expect(context.currentWorker).toMatchObject({ conversationId: worker, engine: 'claude-sdk' });
  // Worker startup through TelosStartSlice remains Codex-only, with a named reason.
  expect(context.startExistingWorker).toEqual({
    supported: false,
    conversationId: worker,
    reason: 'claude_worker_start_unavailable',
  });
  expect(x.ordinary.start).not.toHaveBeenCalled();
  // An exact retry is a read of the original receipt.
  expect(await x.service.refresh(second.record.proposalId, 'user', x.authority)).toMatchObject({
    state: 'assigned',
    childSessionId: worker,
  });
}, 30_000);

it('replaces a current owner with the proposing idle Claude chat and retains former attribution', async () => {
  const x = await adoptionFixture();
  const outcome = await x.f.owner.setup(x.f.actor, x.f.input, x.f.native.signal.signal);
  const former = outcome.work.assignments.find((a) => a.role === 'lead')!;
  const incoming = x.claudeChat({ summary: 'Opus orchestrator' });
  // The proposing chat is the incoming owner: mid-turn now, idle by approval.
  x.registry.register('incoming-live', {
    sessionId: incoming,
    mode: 'agent',
    sessionAllowList: new Set(),
    abortController: new AbortController(),
    transport: { isOpen: () => true, send: vi.fn() },
  });
  const close = vi.fn(() => x.registry.remove('incoming-live'));
  x.registry.get('incoming-live')!.ordinaryRuntimeOwner = { close } as never;
  const queryLoop = await import('../query-loop.js');
  vi.spyOn(queryLoop, 'drainQueryLoopFinalization').mockResolvedValue();
  const { result, record } = await x.adopt(incoming, incoming, 'studio', { replaceOwner: true });
  if (result.state !== 'assigned')
    throw sessionLaunchFailureCause(record.proposalId) ?? Error(result.error);
  // Warm idle SDK owner was closed (no turn interrupted) before the context.
  expect(close).toHaveBeenCalledOnce();
  const studio = x.f.work.read('studio', x.f.actor);
  expect(studio.assignments.find((a) => a.role === 'lead')).toMatchObject({
    revision: former.revision + 1,
    conversation: { conversationId: incoming },
  });
  expect(x.f.work.assignmentHistory('studio', x.f.actor)).toEqual(expect.arrayContaining([former]));
}, 30_000);

it('refuses owner replacement on unowned work as a definite unstarted refusal', async () => {
  const x = await adoptionFixture();
  const incoming = x.claudeChat({ summary: 'Opus orchestrator' });
  const refusal = await x.host
    .propose(
      incoming,
      {
        requestId: randomUUID(),
        title: 'Replace an absent owner',
        prompt: 'Review the replacement.',
        itemId: 'studio',
        expectedRevision: x.items.read('studio').revision,
        existingConversationId: incoming,
        replaceOwner: true,
        sourceSnapshotIds: [],
        artifactRefs: [],
      },
      x.authority,
    )
    .catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(TelosSessionProposalRefusal);
  expect(refusal).toMatchObject({
    code: 'conflict',
    stage: 'proposal_scope',
    effectStatus: 'not_started',
    message: 'No current owner exists; use reviewed initial role setup',
  });
  expect(x.f.work.read('studio', x.f.actor).assignments).toEqual([]);
  expect(x.store.forSession(incoming, 'user')).toEqual([]);
}, 30_000);

it.each(['busy', 'openshell', 'foreign operator', 'busy at approval'] as const)(
  'refuses a %s Claude chat with a named reason and no assignment',
  async (scenario) => {
    const x = await adoptionFixture();
    const outcome = await x.f.owner.setup(x.f.actor, x.f.input, x.f.native.signal.signal);
    x.reserve.mockClear();
    const orchestrator = outcome.work.assignments.find((a) => a.role === 'lead')!.conversation
      .conversationId;
    const feature = x.child('studio', 'Refused feature', orchestrator);
    let target: string;
    if (scenario === 'openshell') {
      target = randomUUID();
      x.f.native.events.createSessionWithRuntimeBinding(
        {
          sessionId: target,
          repositoryWorkspaceId: randomUUID(),
          cwd: '/sandbox/workdir',
          accountBinding: { ...claudeAccount, provider: 'openai-codex' },
          selectedModel: 'opus',
          mode: 'agent',
        },
        {
          ...claudeBinding,
          harness: { implementation: 'codex' },
          account: { ...claudeBinding.account, provider: 'openai-codex' },
          execution: { ...claudeBinding.execution, location: 'openshell' },
        },
      );
    } else
      target = x.claudeChat(scenario === 'foreign operator' ? { operator: 'other-login' } : {});
    const busy = () =>
      x.registry.register(`busy-${target}`, {
        sessionId: target,
        mode: 'agent',
        sessionAllowList: new Set(),
        abortController: new AbortController(),
        transport: { isOpen: () => true, send: vi.fn() },
      });
    if (scenario === 'busy') busy();
    const expected = {
      busy: /^existing_chat_busy:/,
      'busy at approval': /^existing_chat_busy:/,
      openshell: /^existing_chat_openshell:/,
      'foreign operator': /^existing_chat_foreign_operator:/,
    }[scenario];
    if (scenario !== 'busy at approval') {
      const refusal = await x.adopt(orchestrator, target, feature).catch((error) => error);
      expect(refusal).toBeInstanceOf(TelosSessionProposalRefusal);
      expect(refusal.message).toMatch(expected);
      // Named before any write: the agent sees a definite, unstarted refusal.
      expect(refusal).toMatchObject({
        code: 'conflict',
        reason: expected.source.slice(1, -1),
        effectStatus: 'not_started',
      });
    } else {
      const propose = x.host.propose.bind(x.host);
      vi.spyOn(x.host, 'propose').mockImplementation(async (...args) => {
        const proposal = await propose(...args);
        busy(); // The chat starts a turn after review, before approval.
        return proposal;
      });
      const { result, record } = await x.adopt(orchestrator, target, feature);
      expect(result.state).toBe('uncertain');
      expect((sessionLaunchFailureCause(record.proposalId)?.cause as Error).message).toMatch(
        expected,
      );
      expect(x.retire).not.toHaveBeenCalled();
    }
    expect(x.f.work.read(feature, x.f.actor).assignments).toEqual([]);
    expect(x.reserve).not.toHaveBeenCalled();
    expect(x.ordinary.start).not.toHaveBeenCalled();
  },
  30_000,
);
