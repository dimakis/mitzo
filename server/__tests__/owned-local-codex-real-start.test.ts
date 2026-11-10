import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { getLocalCommit } from '../git-version.js';
import { publishPrivateOperationFile } from '../private-operation-file.js';
import { MaintenancePlan, MaintenanceSeal } from '../deployment-maintenance-format.js';
import {
  assertMaintenanceBootstrap,
  persistMaintenanceRequirement,
  validateMaintenanceBootstrap,
} from '../deployment-maintenance-bootstrap.js';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { maintenanceFingerprint } from '@mitzo/protocol/event-store';
import { createDeploymentRuntime } from '../deployment-runtime.js';
import {
  captureMaintenanceOwner,
  assertMaintenanceOwnerDrained,
  drainedMaintenanceSession,
} from '../deployment-maintenance-observation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { assertOwnedCodexQueueControl } from '../owned-codex-queue-control.js';
import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { ConnectionRegistry } from '@mitzo/harness';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
const setup = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's6-real-owned-start-')));
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    MITZO_INTERNAL_TOKEN_PATH: path.join(root, 'internal-token'),
    MITZO_CODEX_PRIVATE_DIR: path.join(root, 'private'),
    TELOS_DB_PATH: path.join(root, 'todo.db'),
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Offline test forbids external network/model calls');
    }),
  );
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Offline test forbids SDK/model calls');
  },
  listSessions: () => [],
}));
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { CodexAppServerClient } from '../codex-app-server-client.js';
import { login, authenticateToken, setAuthRevocationStore } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import * as workspaces from '../repository-workspace-runtime.js';
import * as library from '../agent-library-runtime.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setup.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('the actual owned consumer recovers exact and saved inputs once, serializes retries and retains historical failures', async () => {
  const f = await ownedRuntimeFixture(cleanups, {
    chatRoute: true,
    tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
  });
  const chat = await import('../chat.js');
  const native = await import('../codex-chat-session.js');
  setAuthRevocationStore(chat.eventStore);
  vi.spyOn(workspaces, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  f.detach();
  const auth = (await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!))!;
  cleanups.push(bindAgentLibraryTransport(f.dependencies.operatorConnectionId, auth));
  const first = f.rpc.request.getMockImplementation()!;
  let providerCalls = 0;
  let currentCommandId: string = f.request.clientMsgId;
  let lifecycle: CodexLifecycleTransport | undefined;
  f.rpc.request.mockImplementation(async (method) => {
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        thread: { id: 'real-host-thread' },
        model: 'fixture-model',
        modelProvider: 'openai',
      };
    if (method === 'turn/start') {
      expect(
        chat.eventStore.getOrdinaryLocalCommandExecutionAdmission(currentCommandId)?.state,
      ).toBe('consumed');
      providerCalls++;
      {
        // This synthetic peer retains native policy before its ACK, as a
        // native-enabled runtime does. The consumer fixture otherwise uses
        // host tools, so it does not request native execution permissions.
        const store = native.getCodexConversationStore();
        const command = store
          .commands(f.reservation.conversationId, f.reservation.binding)
          .find((entry) => entry.id === currentCommandId)!;
        const cwd = store.read(f.reservation.conversationId, f.reservation.binding).cwd;
        store.prepareNativeExecution(
          f.reservation.conversationId,
          f.reservation.binding,
          command,
          'real-host-thread',
          codexNativeExecutionPolicy({
            bindingRevision: 'offline-original-policy',
            mode: 'agent',
            cwd,
            readableRoots: [cwd],
            writableRoots: [cwd],
            deniedRoots: [setup.root + '/private'],
          }),
        );
      }
      return { turn: { id: `real-host-turn-${providerCalls}` } };
    }
    if (method === 'thread/turns/list')
      // Recovery must observe the latest exact turn retained by this peer,
      // including the second turn completed before the saved queue is resumed.
      return {
        data: [{ id: `real-host-turn-${providerCalls}`, status: 'completed' }],
        nextCursor: null,
      };
    return first(method);
  });
  const launch = vi
    .spyOn(CodexAppServerClient, 'launchIsolated')
    .mockImplementation((_home, _base, callbacks) => {
      lifecycle = callbacks;
      return f.rpc as never;
    });
  let clientId = `${f.dependencies.operatorConnectionId}:${f.reservation.conversationId}`;
  cleanups.push(async () => {
    const current = chat.registry.findBySessionId(f.reservation.conversationId);
    if (current) chat.registry.abort(current.clientId);
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
    );
    native.getCodexConversationStore().close();
    chat.eventStore.close();
  });
  const transport = { send: vi.fn(), isOpen: () => true };
  const connections = new ConnectionRegistry();
  connections.register(f.dependencies.operatorConnectionId, transport);
  chat.setConnectionRegistry(connections);
  claimTransportConnection(f.dependencies.operatorConnectionId, auth.id);
  cleanups.push(() => releaseTransportConnection(f.dependencies.operatorConnectionId, auth.id));
  const input = {
    command: f.request,
    reservation: f.reservation,
    commandId: f.request.clientMsgId,
    operatorConnectionId: f.dependencies.operatorConnectionId,
    ownerConnectionId: f.dependencies.operatorConnectionId,
    signal: new AbortController().signal,
  };
  const result = await chat.startOwnedLocalCodexCommand(transport, clientId, input);
  expect(result.dispatched).toBe(true);
  await vi.waitFor(() => expect(providerCalls).toBe(1));
  expect(launch).toHaveBeenCalledOnce();
  expect(
    native
      .getCodexConversationStore()
      .commandStatus(f.reservation.conversationId, f.reservation.binding, f.request.clientMsgId),
  ).toBe('running');
  expect(await chat.startOwnedLocalCodexCommand(transport, clientId, input)).toMatchObject({
    dispatched: false,
  });
  expect(providerCalls).toBe(1);
  expect(launch).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(
      native
        .getCodexConversationStore()
        .nativeTurnTarget(f.reservation.conversationId, f.reservation.binding, currentCommandId, 1),
    ).toBeDefined(),
  );
  lifecycle!.onNotification('turn/completed', {
    threadId: 'real-host-thread',
    turn: { id: 'real-host-turn-1', status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(
      native
        .getCodexConversationStore()
        .commandStatus(f.reservation.conversationId, f.reservation.binding, currentCommandId),
    ).toBe('completed'),
  );
  chat.registry.abort(clientId);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
  );

  // Exercise the real production consumer after an existing chat loses its
  // bootstrap before enqueue. The receipt survives without a replacement chat.
  const nextRequest = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Resume the retained unfinished work' },
  };
  currentCommandId = nextRequest.clientMsgId;
  const nextInput = { ...input, command: nextRequest, commandId: currentCommandId, resume: true };
  launch.mockImplementationOnce(() => {
    throw Error('Synthetic bootstrap failure before enqueue');
  });
  await expect(chat.startOwnedLocalCodexCommand(transport, clientId, nextInput)).rejects.toThrow();
  expect(chat.eventStore.getOrdinaryLocalCommandExecutionAdmission(currentCommandId)?.state).toBe(
    'uncertain',
  );
  expect(providerCalls).toBe(1);
  await expect(
    chat.startOwnedLocalCodexCommand(transport, clientId, { ...nextInput, recovery: true }),
  ).resolves.toMatchObject({ dispatched: true });
  await vi.waitFor(() => expect(providerCalls).toBe(2));
  await vi.waitFor(() =>
    expect(
      native
        .getCodexConversationStore()
        .nativeTurnTarget(f.reservation.conversationId, f.reservation.binding, currentCommandId, 1),
    ).toBeDefined(),
  );
  lifecycle!.onNotification('turn/completed', {
    threadId: 'real-host-thread',
    turn: { id: 'real-host-turn-2', status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(
      native
        .getCodexConversationStore()
        .commandStatus(f.reservation.conversationId, f.reservation.binding, currentCommandId),
    ).toBe('completed'),
  );
  expect(
    native
      .getCodexConversationStore()
      .commandStatus(f.reservation.conversationId, f.reservation.binding, currentCommandId),
  ).toBe('completed');
  expect(chat.eventStore.getSession(f.reservation.conversationId)?.cwd).toBe(
    f.workspace.getForConversation(f.reservation.conversationId)!.directory,
  );
  // Admission can be observed and its outbox retired while native work is
  // still queued. Recover through the existing signed queue action, with two
  // simultaneous clicks, using only saved server input.
  const savedRequest = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Saved queue input after acceptance' },
  };
  currentCommandId = savedRequest.clientMsgId;
  const live = chat.registry.findBySessionId(f.reservation.conversationId)!.session;
  await live.ordinaryRuntimeOwner!.admit(savedRequest, new AbortController().signal);
  const accepted = chat.eventStore.getOrdinaryLocalCommandExecutionAdmission(currentCommandId);
  expect(accepted?.state).toBe('consumed');
  expect(
    native
      .getCodexConversationStore()
      .commandStatus(f.reservation.conversationId, f.reservation.binding, currentCommandId),
  ).toBe('queued');
  chat.registry.abort(clientId);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
  );
  const actions = await Promise.allSettled([
    chat.continueOwnedLocalCodexQueue(
      f.reservation.conversationId,
      auth,
      f.dependencies.operatorConnectionId,
    ),
    chat.continueOwnedLocalCodexQueue(
      f.reservation.conversationId,
      auth,
      f.dependencies.operatorConnectionId,
    ),
  ]);
  expect(actions.filter((action) => action.status === 'fulfilled')).toHaveLength(1);
  expect(actions.filter((action) => action.status === 'rejected')).toHaveLength(1);
  await vi.waitFor(() => expect(providerCalls).toBe(3));
  expect(chat.eventStore.getOrdinaryLocalCommandExecutionAdmission(currentCommandId)).toEqual(
    accepted,
  );
  await vi.waitFor(() =>
    expect(
      native
        .getCodexConversationStore()
        .nativeTurnTarget(f.reservation.conversationId, f.reservation.binding, currentCommandId, 1),
    ).toBeDefined(),
  );
  // Reuse this real owned consumer for the maintenance boundary. Save one
  // consumed queued input before installing the source's durable hold.
  const maintenanceNative = native.getCodexConversationStore();
  const maintenanceCommand = maintenanceNative
    .commands(f.reservation.conversationId, f.reservation.binding)
    .find((command) => command.id === currentCommandId)!;
  maintenanceNative.acceptNativeExecution(
    f.reservation.conversationId,
    f.reservation.binding,
    maintenanceCommand,
    'real-host-thread',
    'real-host-turn-3',
  );
  const savedDuringMaintenance = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Retain this original queued input across deployment' },
  };
  await chat.registry
    .findBySessionId(f.reservation.conversationId)!
    .session.ordinaryRuntimeOwner!.admit(savedDuringMaintenance, new AbortController().signal);
  const ledger = new Database(join(process.env.REPO_PATH!, '.mitzo/events.db'));
  const observation = new CodexConversationStore(
    join(process.env.MITZO_CODEX_PRIVATE_DIR!, 'conversations.db'),
    { observation: true },
  );
  cleanups.push(() => {
    observation.close();
    ledger.close();
  });
  chat.eventStore.upsertSession({
    sessionId: 'quarantined-history',
    initialPrompt: 'Retained original historical task',
  });
  chat.eventStore.setSessionState('quarantined-history', 'ENDED', { force: true });
  ledger
    .prepare(
      'INSERT INTO send_commands(client_msg_id,session_id,payload,ordinary_admission) VALUES(?,?,?,?)',
    )
    .run(
      'quarantined-command',
      'quarantined-history',
      '{"text":"Original uncertain input"}',
      '{"state":"uncertain"}',
    );
  const originalHold = chat.eventStore.deployment.begin({
    id: randomUUID(),
    sourceCommit: '279e6703dedebaeb130993fd6e2657b2aed73c0a',
    targetCommit: getLocalCommit()!,
    auth,
  });
  const capturedOwner = captureMaintenanceOwner(
    ledger,
    observation,
    f.reservation.conversationId,
    true,
  );
  lifecycle!.onNotification('turn/completed', {
    threadId: 'real-host-thread',
    turn: { id: 'real-host-turn-3', status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(
      native
        .getCodexConversationStore()
        .commandStatus(f.reservation.conversationId, f.reservation.binding, currentCommandId),
    ).toBe('completed'),
  );
  expect(
    assertMaintenanceOwnerDrained(ledger, observation, capturedOwner).completionSha256,
  ).toHaveLength(64);
  chat.registry.abort(clientId);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
  );
  const historical = ledger
    .prepare('SELECT * FROM send_commands WHERE client_msg_id=?')
    .get('quarantined-command');
  const authorityId = randomUUID();
  const selectedFile = (path: string) => {
    const stat = lstatSync(path);
    return { path, identity: { dev: stat.dev, ino: stat.ino } };
  };
  const plan = MaintenancePlan.parse({
    version: 1,
    id: randomUUID(),
    authorityId,
    sourceOperationId: originalHold.id,
    sourceOperationSha256: maintenanceFingerprint(JSON.stringify(originalHold)),
    sourceCommit: originalHold.sourceCommit,
    targetCommit: originalHold.targetCommit,
    sourcePid: process.pid,
    sourceGroup: process.pid,
    sourceBirth: 'offline-source',
    events: selectedFile(join(process.env.REPO_PATH!, '.mitzo/events.db')),
    native: selectedFile(join(process.env.MITZO_CODEX_PRIVATE_DIR!, 'conversations.db')),
    helpers: [],
    owners: [capturedOwner],
    expectedCommands: [
      { commandId: 'quarantined-command', sha256: maintenanceFingerprint(historical) },
    ],
  });
  const seal = MaintenanceSeal.parse({
    planSha256: maintenanceFingerprint(plan),
    helpers: [],
    completionSha256: maintenanceFingerprint([
      assertMaintenanceOwnerDrained(ledger, observation, capturedOwner),
    ]),
  });
  const protectedRoot = join(process.env.MITZO_CODEX_PRIVATE_DIR!, 'deployment');
  mkdirSync(protectedRoot, { mode: 0o700 });
  const planFile = join(protectedRoot, 'candidate.json');
  publishPrivateOperationFile(planFile, JSON.stringify(plan) + '\n');
  publishPrivateOperationFile(planFile + '.sealed.json', JSON.stringify(seal) + '\n');
  vi.stubEnv('MITZO_MAINTENANCE_PLAN_FILE', planFile);
  expect(() => validateMaintenanceBootstrap()).toThrow();
  persistMaintenanceRequirement(planFile, plan, seal);
  chmodSync(protectedRoot, 0o755);
  expect(() => persistMaintenanceRequirement(planFile, plan, seal)).toThrow(/Private owned/);
  expect(() => validateMaintenanceBootstrap()).toThrow(/Private owned/);
  chmodSync(protectedRoot, 0o700);
  vi.stubEnv('MITZO_MAINTENANCE_PLAN_FILE', undefined);
  expect(() => validateMaintenanceBootstrap()).toThrow(/adoption/);
  const proofSha256 = maintenanceFingerprint({
    planSha256: maintenanceFingerprint(plan),
    completionSha256: seal.completionSha256,
    helpers: seal.helpers,
  });
  expect(() => assertMaintenanceBootstrap(ledger, plan, seal, originalHold.targetCommit)).toThrow(
    /adoption/,
  );
  const operation = chat.eventStore.deployment.maintenance.adopt(
    {
      ...plan,
      expectedRunningSessions: [
        {
          sessionId: capturedOwner.sessionId,
          targetSha256: maintenanceFingerprint(capturedOwner.target),
        },
      ],
    },
    {
      authorize: () => auth,
      // This fixture replaces only native transport creation; actual launchd
      // process exclusion is a separately required host qualification.
      assertSourceExcluded: () => {
        expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy();
      },
      assertDrained: () => {
        assertMaintenanceOwnerDrained(ledger, observation, capturedOwner);
        return {
          retainedSessionIds: [capturedOwner.sessionId],
          proofSha256,
          sessions: [drainedMaintenanceSession(chat.eventStore, observation, capturedOwner)],
        };
      },
    },
  );
  expect(() =>
    assertMaintenanceBootstrap(ledger, plan, seal, originalHold.targetCommit),
  ).not.toThrow();
  expect(() =>
    assertMaintenanceBootstrap(
      ledger,
      plan,
      { ...seal, completionSha256: 'f'.repeat(64) },
      originalHold.targetCommit,
    ),
  ).toThrow(/adoption/);
  expect(() => validateMaintenanceBootstrap()).not.toThrow();
  const originalRepo = process.env.REPO_PATH!;
  const otherRepo = join(setup.root, 'wrong-runtime-repo');
  mkdirSync(otherRepo);
  vi.stubEnv('REPO_PATH', otherRepo);
  expect(() => validateMaintenanceBootstrap()).toThrow();
  expect(existsSync(join(otherRepo, '.mitzo/events.db'))).toBe(false);
  vi.stubEnv('REPO_PATH', originalRepo);
  writeFileSync(
    planFile + '.sealed.json',
    JSON.stringify({ ...seal, completionSha256: 'f'.repeat(64) }),
  );
  expect(() => validateMaintenanceBootstrap()).toThrow(/requirement/);
  writeFileSync(planFile + '.sealed.json', JSON.stringify(seal) + '\n');
  expect(operation.sessions[0].pauseSettled).toBeUndefined();
  const deployment = createDeploymentRuntime(
    { eventStore: chat.eventStore, sessionRegistry: chat.registry, connRegistry: connections },
    {
      commit: () => originalHold.targetCommit,
      healthy: () => true,
      backgroundIdle: () => true,
      authorizeSession: (id, actor) => {
        chat.eventStore.deployment.maintenance.assertControl(id);
        assertOwnedCodexQueueControl(
          {
            runtimeBinding: (session) => chat.eventStore.getSessionRuntimeBinding(session),
            accountBinding: (session) => chat.eventStore.getSession(session)?.accountBinding,
            custody: (session, account) => maintenanceNative.readHostCustody(session, account),
          },
          id,
          actor,
        );
      },
    },
  );
  cleanups.push(deployment.close);
  currentCommandId = savedDuringMaintenance.clientMsgId;
  expect(
    (await deployment.coordinator.resume(operation.id, auth, { activationId: authorityId })).phase,
  ).toBe('completed');
  const continuationId = operation.sessions[0].resumeId;
  expect(chat.eventStore.getOrdinaryLocalCommandExecutionAdmission(continuationId)?.state).toBe(
    'consumed',
  );
  await vi.waitFor(() => expect(providerCalls).toBe(4));
  expect(
    maintenanceNative.commandStatus(
      f.reservation.conversationId,
      f.reservation.binding,
      savedDuringMaintenance.clientMsgId,
    ),
  ).toBe('running');
  expect(
    maintenanceNative.commandStatus(
      f.reservation.conversationId,
      f.reservation.binding,
      continuationId,
    ),
  ).toBe('queued');
  expect(chat.eventStore.deployment.canDispatch('quarantined-history')).toBe(false);
  expect(() => chat.eventStore.reserveOrdinaryStartup(['quarantined-history'])).toThrow(
    /Deployment/,
  );
  currentCommandId = continuationId;
  lifecycle!.onNotification('turn/completed', {
    threadId: 'real-host-thread',
    turn: { id: 'real-host-turn-4', status: 'completed' },
  });
  await vi.waitFor(() => expect(providerCalls).toBe(5));
  lifecycle!.onNotification('turn/completed', {
    threadId: 'real-host-thread',
    turn: { id: 'real-host-turn-5', status: 'completed' },
  });
  await vi.waitFor(() =>
    expect(
      maintenanceNative.commandStatus(
        f.reservation.conversationId,
        f.reservation.binding,
        continuationId,
      ),
    ).toBe('completed'),
  );
  expect(
    maintenanceNative.commandStatus(
      f.reservation.conversationId,
      f.reservation.binding,
      maintenanceCommand.id,
    ),
  ).toBe('completed');
  expect(
    ledger.prepare('SELECT * FROM send_commands WHERE client_msg_id=?').get('quarantined-command'),
  ).toEqual(historical);
  await expect(
    deployment.coordinator.resume(operation.id, auth, { activationId: authorityId }),
  ).rejects.toThrow(/Original deployment hold/);
  expect(providerCalls).toBe(5);
  expect(() =>
    assertMaintenanceBootstrap(ledger, plan, seal, originalHold.targetCommit),
  ).not.toThrow();
  expect(() => assertMaintenanceBootstrap(ledger, plan, seal, 'c'.repeat(40))).not.toThrow();
  clientId = chat.registry.findBySessionId(f.reservation.conversationId)!.clientId;
  const legacyRequest = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Historical uncertain failure retained for inspection' },
  };
  await chat.registry
    .findBySessionId(f.reservation.conversationId)!
    .session.ordinaryRuntimeOwner!.admit(legacyRequest, new AbortController().signal);
  const nativeStore = native.getCodexConversationStore();
  expect(nativeStore.claimNext(f.reservation.conversationId, f.reservation.binding)?.id).toBe(
    legacyRequest.clientMsgId,
  );
  nativeStore.finish(
    f.reservation.conversationId,
    f.reservation.binding,
    legacyRequest.clientMsgId,
    'failed',
  );
  chat.registry.abort(clientId);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
  );
  await expect(
    chat.continueOwnedLocalCodexQueue(
      f.reservation.conversationId,
      auth,
      f.dependencies.operatorConnectionId,
    ),
  ).rejects.toThrow();
  const fresh = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Continue with this new request; retain the earlier failed outcome' },
  };
  currentCommandId = fresh.clientMsgId;
  await expect(
    chat.startOwnedLocalCodexCommand(transport, clientId, {
      ...input,
      command: fresh,
      commandId: currentCommandId,
      resume: true,
    }),
  ).resolves.toMatchObject({ dispatched: true });
  await vi.waitFor(() => expect(providerCalls).toBe(6));
  expect(
    nativeStore.commandStatus(
      f.reservation.conversationId,
      f.reservation.binding,
      legacyRequest.clientMsgId,
    ),
  ).toBe('failed');

  // A new message is the recovery action. Reuse this actual cold consumer:
  // positively observed completion is inspected under its original command
  // before the new message gets a different execution owner.
  const completedCommand = nativeStore
    .commands(f.reservation.conversationId, f.reservation.binding)
    .find((command) => command.id === currentCommandId)!;
  await vi.waitFor(() =>
    expect(
      nativeStore.nativeTurnTarget(
        f.reservation.conversationId,
        f.reservation.binding,
        completedCommand.id,
        completedCommand.attempt,
      ),
    ).toBeDefined(),
  );
  nativeStore.acceptNativeExecution(
    f.reservation.conversationId,
    f.reservation.binding,
    completedCommand,
    'real-host-thread',
    'real-host-turn-6',
  );
  const execution = nativeStore.readNativeExecution(
    f.reservation.conversationId,
    f.reservation.binding,
    completedCommand,
  )!;
  nativeStore.observeEmptyCompletionPhase(
    f.reservation.conversationId,
    f.reservation.binding,
    completedCommand,
    'real-host-thread',
    'real-host-turn-6',
    createHash('sha256').update(execution.policy.cwd).digest('hex'),
    execution.policy.policyRevision,
  );
  nativeStore.pauseForRecovery(
    f.reservation.conversationId,
    f.reservation.binding,
    currentCommandId,
    'interrupted',
    'resume',
    undefined,
    true,
    true,
  );
  chat.registry.abort(clientId);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
  );
  const ping = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Continue this chat' },
  };
  currentCommandId = ping.clientMsgId;
  await expect(
    chat.startOwnedLocalCodexCommand(transport, clientId, {
      ...input,
      command: ping,
      commandId: currentCommandId,
      resume: true,
    }),
  ).resolves.toMatchObject({ dispatched: true });
  await vi.waitFor(() => expect(providerCalls).toBe(7));
  expect(
    nativeStore.commandStatus(
      f.reservation.conversationId,
      f.reservation.binding,
      completedCommand.id,
    ),
  ).toBe('completed');

  // Reuse the live consumer and its real admission/custody records. A saved
  // follow-up cannot make an earlier ambiguous turn eligible for input recovery.
  const blockedFollowUp = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Keep this follow-up queued until the original outcome is known' },
  };
  await chat.registry
    .findBySessionId(f.reservation.conversationId)!
    .session.ordinaryRuntimeOwner!.admit(blockedFollowUp, new AbortController().signal);
  nativeStore.pauseForRecovery(
    f.reservation.conversationId,
    f.reservation.binding,
    currentCommandId,
    'interrupted',
    'resume',
    undefined,
    true,
    true,
  );
  chat.registry.abort(clientId);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeFalsy(),
  );
  const queuedBefore = nativeStore.commands(f.reservation.conversationId, f.reservation.binding);
  const launchesBefore = launch.mock.calls.length;
  await expect(
    chat.continueOwnedLocalCodexQueue(
      f.reservation.conversationId,
      auth,
      f.dependencies.operatorConnectionId,
    ),
  ).rejects.toMatchObject({ code: 'unsettled_effects' });
  expect(launch).toHaveBeenCalledTimes(launchesBefore);
  expect(providerCalls).toBe(7);
  expect(nativeStore.commands(f.reservation.conversationId, f.reservation.binding)).toEqual(
    queuedBefore,
  );
}, 50000);
