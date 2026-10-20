import { expect, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../event-store.js';
import { AgentLibraryStore } from '../../agent-library-store.js';
import { RepositoryWorkspaces } from '../../repository-workspaces.js';
import { loadAccountProfiles } from '../../account-profiles.js';
import {
  captureOrdinaryRepositoryPreparation,
  assertOrdinaryRepositoryPreparation,
} from '../../ordinary-repository-preparation-authority.js';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../../ordinary-local-codex-host-runtime.js';
import { OrdinaryLocalCodexCapabilityCatalog } from '../../ordinary-local-codex-capabilities.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../../ordinary-local-codex-owned-runtime.js';
import { OwnedLocalCodexChatAdmission } from '../../owned-local-codex-chat-admission.js';
import { bindAgentLibraryTransport } from '../../agent-library-transport.js';
import {
  login,
  authenticateToken,
  isAuthSessionCurrent,
  hasPersistentRevocationAuthority,
} from '../../auth.js';

/** Non-Git storage, real account/native readiness and ordinary owners; only RPC/provider effects are fake. */
export async function ownedOrdinaryRuntimeFixture(cleanups: Array<() => void | Promise<void>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-ordinary-native-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const loginRoot = join(root, 'login'),
    privateRoot = join(root, 'native-custody'),
    taskRoot = join(root, 'tasks');
  for (const path of [loginRoot, privateRoot, taskRoot]) await mkdir(path, { mode: 0o700 });
  await writeFile(
    join(loginRoot, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'offline',
        refresh_token: 'offline',
        id_token: 'offline',
        account_id: 'offline',
      },
    }),
    { mode: 0o600 },
  );
  const executablePath = join(root, 'codex'),
    nativePath = join(root, 'native.json'),
    targetPath = join(root, 'target.json');
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(executablePath, bytes, { mode: 0o755 });
  await writeFile(
    nativePath,
    JSON.stringify({ version: 1, executablePath, executableSha256: sha256 }),
    { mode: 0o600 },
  );
  await writeFile(
    targetPath,
    JSON.stringify({
      version: 1,
      targetId: 'ordinary-fixture-local',
      label: 'Offline local',
      hostId: hostname(),
      runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256),
    }),
    { mode: 0o600 },
  );
  const profilesPath = join(root, 'profiles.json');
  await writeFile(
    profilesPath,
    JSON.stringify([
      {
        id: 'ordinary-personal',
        label: 'Offline personal',
        provider: 'openai-codex',
        credentialRef: loginRoot,
        email: 'fixture@example.test',
        planType: 'plus',
        models: [{ id: 'fixture-model', label: 'Offline model', reasoningEfforts: ['low'] }],
      },
    ]),
    { mode: 0o600 },
  );
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', profilesPath);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  vi.stubEnv('MITZO_CODEX_ENABLED', '1');
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE', nativePath);
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE', targetPath);
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '0');
  const env = {
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativePath,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetPath,
  };
  const binding = loadAccountProfiles().resolve('ordinary-personal', 'fixture-model');
  const catalog = new OrdinaryLocalCodexCapabilityCatalog(
    loadAccountProfiles(),
    new OrdinaryLocalCodexHostRuntime(env).target(),
    'ordinary',
  );
  const eventPath = join(root, 'events.db');
  let events = new EventStore(eventPath),
    library = new AgentLibraryStore(eventPath);
  cleanups.push(
    () => events.close(),
    () => library.close(),
  );
  library.saveDraft('user', {
    profileId: 'ordinary-worker',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Ordinary work',
      descriptor: 'Offline fixture',
      role: 'agent',
      instructions: 'Use the retained material and preserve ownership.',
      expectedOutput: 'A retained report',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent',
    },
  });
  const agentProfile = library.publish('user', {
    profileId: 'ordinary-worker',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  const forbidden = vi.fn(async () => {
    throw Error('No repository authority or Git source is available');
  });
  const openWorkspaces = () =>
    new RepositoryWorkspaces(join(root, 'workspace-owner'), {
      authorize: forbidden,
      inspect: forbidden,
      prepare: forbidden,
      verify: forbidden,
      ordinaryPreparation: {
        capture: captureOrdinaryRepositoryPreparation,
        assert: assertOrdinaryRepositoryPreparation,
      },
    });
  let workspaces = openWorkspaces();
  cleanups.push(() => workspaces.close());
  let legacyLookup = vi.spyOn(workspaces, 'getHostReservation');
  const signal = new AbortController();
  const token = await login('test-passphrase-for-vitest');
  if (!token) throw Error('Synthetic operator login unavailable');
  const auth = await authenticateToken(token);
  if (!auth || !isAuthSessionCurrent(auth) || !hasPersistentRevocationAuthority())
    throw Error('Private persistent operator authority unavailable');
  const operatorConnectionId = randomUUID();
  cleanups.push(bindAgentLibraryTransport(operatorConnectionId, auth));
  const intent = {
    runOn: 'local' as const,
    runtime: {
      account: catalog.inventory().accounts[0].account,
      harness: 'codex' as const,
      targetId: 'ordinary-fixture-local',
    },
  };
  const prepared = await workspaces.prepareOrdinaryWorkspace({
    binding,
    selection: intent,
    signal: signal.signal,
  });

  async function prepareSession() {
    const allocationOperationId = randomUUID();
    const request = {
      clientMsgId: randomUUID(),
      capabilityRevision: catalog.inventory().capabilityRevision,
      runtime: { ...intent.runtime, mode: 'agent' as const },
      selection: {
        version: 1 as const,
        agent: { profileId: agentProfile.profileId, revision: agentProfile.revision },
        context: { source: 'none' as const, revision: null },
        permission: { mode: 'agent' as const, revision: 0 },
        model: 'fixture-model',
        thinking: 'low',
      },
      payload: { text: 'Write a retained non-code report', intent: 'Original ordinary work' },
    };
    const settings = {
      version: 2 as const,
      binding: prepared.runtimeBinding,
      selection: request.selection,
      workspace: { kind: 'ordinary' as const, preparationId: prepared.preparationId },
    };
    const reserved = await workspaces.reserveOrdinaryWorkspace({
      preparationId: prepared.preparationId,
      allocationOperationId,
      binding,
      settings,
      agentProfile,
      taskRoot,
      signal: signal.signal,
    });
    const receipt = events.prepareOrdinaryWorkspaceSession(
      {
        sessionId: reserved.conversationId,
        ordinaryWorkspaceId: reserved.id,
        cwd: reserved.directory,
        accountBinding: binding,
        agentProfile,
        selectedModel: request.selection.model,
        reasoningEffort: request.selection.thinking,
        mode: 'agent',
      },
      { allocationOperationId, preparationFingerprint: reserved.preparationFingerprint, settings },
    );
    const reservation = {
      id: reserved.id,
      binding,
      conversationId: reserved.conversationId,
      taskRoot,
      runtimeBinding: settings.binding,
      commandFingerprint: reserved.preparationFingerprint,
    };
    const rpc = {
      initialize: vi.fn(async () => {}),
      request: vi.fn(async (method: string) => {
        if (method === 'account/read')
          return { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } };
        if (method === 'config/read') return { config: {} };
        if (method === 'model/list')
          return {
            data: [
              {
                model: 'fixture-model',
                displayName: 'Offline fixture',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              },
            ],
            nextCursor: null,
          };
        throw Error('Unexpected native provider effect');
      }),
      close: vi.fn(),
    };
    const launch = vi.fn(() => {
      expect(events.getOrdinaryLocalCommandAdmission(request.clientMsgId)?.state).toBe('uncertain');
      expect(workspaces.getOrdinaryWorkspace(reserved.id).state).toBe('reserved');
      return rpc;
    });
    const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch<'ordinary'>) => {
      expect(value.admission).toBeInstanceOf(OwnedLocalCodexChatAdmission);
      expect(value.workspace).toMatchObject({
        kind: 'ordinary',
        id: reserved.id,
        directory: reserved.directory,
      });
      expect(value.workspace).not.toHaveProperty('repository');
      expect(events.getOrdinaryLocalCommandAdmission(request.clientMsgId)?.state).toBe('uncertain');
      const options = {
        conversationId: reserved.conversationId,
        messageId: request.clientMsgId,
        binding,
        profile: value.profile,
        session: { cwd: reserved.directory, mode: 'agent' },
        prompt: value.payload.text,
        systemPrompt: value.payload.systemPrompt,
        intent: value.payload.intent,
        model: request.selection.model,
        reasoningEffort: request.selection.thinking,
        agentProfile: value.expected.agentProfile,
        agentContext: value.expected.agentContext,
        ordinaryWorkspace: value.workspace,
      };
      expect(() =>
        value.admission.assertPreparedOptions({
          ...options,
          ordinaryWorkspace: undefined,
          repositoryWorkspace: value.workspace,
        }),
      ).toThrow();
      expect(() =>
        value.admission.assertPreparedOptions({ ...options, repositoryWorkspace: value.workspace }),
      ).toThrow();
      value.admission.assertOptions(options);
      expect(
        value.admission.attach({
          onNotification: () => {},
          onRequest: async () => ({}),
          onClose: () => {},
        }),
      ).toBe(rpc);
    });
    const dispatchContinuation = vi.fn(
      async (value: OrdinaryLocalCodexOwnedDispatch<'ordinary'>) => {
        expect(value.workspace.kind).toBe('ordinary');
        value.admission.assertBeforeEnqueue({
          id: value.commandId,
          prompt: value.payload.text,
          intent: value.payload.intent,
          model: value.expected.selection.model,
          reasoningEffort: value.expected.selection.thinking,
        });
      },
    );
    const dependencies = {
      enabled: true,
      eventStore: events,
      library,
      workspace: workspaces,
      workspaceKind: 'ordinary' as const,
      reservation,
      commandId: request.clientMsgId,
      operatorConnectionId,
      signal: signal.signal,
      env,
      privateRoot,
      launch,
      dispatch,
      dispatchContinuation,
    };
    const create = () => {
      const driver = new OrdinaryLocalCodexOwnedRuntime<'ordinary'>({
        ...dependencies,
        eventStore: events,
        library,
        workspace: workspaces,
      });
      cleanups.push(() => driver.close());
      return driver;
    };
    return {
      receipt,
      reserved,
      reservation,
      request,
      rpc,
      launch,
      dispatch,
      dispatchContinuation,
      create,
    };
  }
  return {
    root,
    taskRoot,
    privateRoot,
    get events() {
      return events;
    },
    get library() {
      return library;
    },
    get workspaces() {
      return workspaces;
    },
    binding,
    prepared,
    forbidden,
    get legacyLookup() {
      return legacyLookup;
    },
    /** Reopen actual durable owners only after the test has stopped any driver. */
    reopenStorage() {
      library.close();
      events.close();
      workspaces.close();
      events = new EventStore(eventPath);
      library = new AgentLibraryStore(eventPath);
      workspaces = openWorkspaces();
      legacyLookup = vi.spyOn(workspaces, 'getHostReservation');
    },
    auth,
    signal,
    first: await prepareSession(),
    prepareSibling: prepareSession,
  };
}
