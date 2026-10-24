import { expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventStore } from '../../event-store.js';
import { AgentLibraryStore } from '../../agent-library-store.js';
import { RepositoryWorkspaces } from '../../repository-workspaces.js';
import { loadAccountProfiles } from '../../account-profiles.js';
import { OrdinaryLocalCodexCapabilityCatalog } from '../../ordinary-local-codex-capabilities.js';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../../ordinary-local-codex-host-runtime.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../../ordinary-local-codex-owned-runtime.js';
import { OwnedLocalCodexChatAdmission } from '../../owned-local-codex-chat-admission.js';
import {
  bindAgentLibraryTransport,
  readBuiltinAgentLibraryProfile,
} from '../../agent-library-transport.js';
import {
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  type AgentLibraryVersion,
  type AgentToolReference,
} from '@mitzo/protocol';
import { OrdinaryRepositoryPreparationSchema } from '../../ordinary-repository-preparation.js';

import { nativeStartupSessionId } from '../../ordinary-repository-startup.js';
export async function ownedRuntimeFixture(
  cleanups: Array<() => void | Promise<void>>,
  options: {
    tools?: AgentToolReference[];
    /** Synthetic operator lifetime for multi-operation offline journeys only. */
    operatorLifetimeMs?: number;
    workspaceId?: string;
    contextRecipe?: boolean | 'workspace';
    chatRoute?: boolean;
    silentPreparation?: boolean;
    builtinPreparation?: boolean;
    api?: boolean;
    localRepository?: boolean;
    /** Explicit offline native diagnostic; real model turns must still be intercepted. */
    nativeExecutablePath?: string;
    modelId?: string;
    continuityV2?: boolean;
    realPreparationAuthority?: boolean;
    historicalPreparation?: (
      proof: import('../../ordinary-repository-preparation.js').OrdinaryRepositoryPreparation,
    ) => Promise<import('../../ordinary-repository-preparation.js').OrdinaryRepositoryPreparation>;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-owned-driver-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const login = join(root, 'login'),
    privateRoot = join(root, 'custody'),
    taskRoot = options.chatRoute ? join(root, '.claude', 'repository-tasks') : join(root, 'tasks');
  if (options.chatRoute) {
    await mkdir(join(root, '.mitzo'), { mode: 0o700 });
    await mkdir(join(root, '.claude'), { mode: 0o700 });
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
  }
  for (const directory of [login, privateRoot, taskRoot]) await mkdir(directory, { mode: 0o700 });
  await writeFile(
    join(login, 'auth.json'),
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
  const modelId = options.modelId ?? 'fixture-model';
  const executablePath = options.nativeExecutablePath ?? join(root, 'codex'),
    nativePath = join(root, 'native.json'),
    targetPath = join(root, 'target.json');
  const bytes = options.nativeExecutablePath
    ? await readFile(options.nativeExecutablePath)
    : Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const codeModeHostSha256 = options.nativeExecutablePath
    ? createHash('sha256')
        .update(await readFile(join(dirname(executablePath), 'codex-code-mode-host')))
        .digest('hex')
    : sha256;
  if (!options.nativeExecutablePath) {
    await writeFile(executablePath, bytes, { mode: 0o755 });
    await writeFile(join(root, 'codex-code-mode-host'), bytes, { mode: 0o755 });
  }
  const target = {
    version: options.continuityV2 ? 2 : 1,
    ...(options.continuityV2 ? { continuityContract: 'codex-native-thread-v1' } : {}),
    targetId: 'local-mac',
    label: 'Local Mac',
    hostId: hostname(),
    runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256, codeModeHostSha256),
  };
  await writeFile(
    nativePath,
    JSON.stringify({ version: 2, executablePath, executableSha256: sha256, codeModeHostSha256 }),
    { mode: 0o600 },
  );
  await writeFile(targetPath, JSON.stringify(target), { mode: 0o600 });
  const configPath = join(root, 'profiles.json');
  const configuration = [
    {
      id: 'personal',
      label: 'Personal',
      provider: 'openai-codex',
      credentialRef: login,
      email: 'fixture@example.test',
      planType: 'plus',
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      models: [{ id: modelId, label: 'Fixture model', reasoningEfforts: ['low'] }],
    },
  ];
  if (options.api)
    configuration[0] = {
      id: 'work',
      label: 'Work API',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'offline-test', account: 'work' },
      models: [{ id: modelId, label: 'Fixture model', reasoningEfforts: ['low'] }],
    } as never;
  const writeProfiles = () =>
    writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
  writeProfiles();
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', configPath);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  vi.stubEnv('MITZO_CODEX_ENABLED', '1');
  const binding = loadAccountProfiles().resolve(options.api ? 'work' : 'personal', modelId);
  const eventPath = options.chatRoute ? join(root, '.mitzo', 'events.db') : join(root, 'events.db');
  const events = new EventStore(eventPath);
  const library = new AgentLibraryStore(eventPath);
  cleanups.push(
    () => events.close(),
    () => library.close(),
  );
  library.saveDraft('user', {
    profileId: 'developer',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Developer',
      descriptor: 'Assistant',
      role: 'agent',
      instructions: 'Preserve task ownership.',
      expectedOutput: 'Reviewed changes',
      acceptanceCriteria: ['Use evidence'],
      modelPolicyRole: 'agent',
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.contextRecipe
        ? {
            contextRecipe:
              options.contextRecipe === 'workspace'
                ? {
                    version: 1,
                    source: 'workspace',
                    files: ['context.md'],
                    tokenBudget: 1000,
                    required: [],
                    excluded: [],
                  }
                : { version: 1, source: 'contexgin', agentName: 'fixture-agent' },
          }
        : {}),
    },
  });
  let agentProfile: AgentLibraryVersion = library.publish('user', {
    profileId: 'developer',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  if (options.builtinPreparation)
    agentProfile = readBuiltinAgentLibraryProfile({
      kind: 'builtin',
      profileId: PROFILE_BUILDER_ID,
      revision: PROFILE_BUILDER_REVISION,
    })!;
  const env = {
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativePath,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetPath,
  };
  if (options.chatRoute) {
    vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE', nativePath);
    vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE', targetPath);
    vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  }
  const catalog = new OrdinaryLocalCodexCapabilityCatalog(
    loadAccountProfiles(),
    new OrdinaryLocalCodexHostRuntime(env).target(),
    'ordinary',
  );
  const source = join(root, 'source');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  const git = (directory: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  git(source, 'config', 'user.name', 'Offline');
  git(source, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(source, 'task.txt'), 'accepted source');
  await writeFile(join(source, 'AGENTS.md'), '# Instructions\nPreserve task ownership');
  await writeFile(join(source, 'context.md'), '# Context\nPinned original checkout');
  git(source, 'add', 'task.txt', 'context.md', 'AGENTS.md');
  git(source, 'commit', '-qm', 'offline base');
  const baseOid = git(source, 'rev-parse', 'HEAD');
  const inspect = async () => ({ repository: 'example/repo', baseBranch: 'main', baseOid });
  const readiness = options.realPreparationAuthority
    ? await import('../../ordinary-repository-preparation-authority.js')
    : undefined;
  const workspace = new RepositoryWorkspaces(join(root, 'repositories'), {
    localRepositories: () => ({ primary: source }),
    authorize: async (selected) => {
      loadAccountProfiles().resumeRouting(selected);
      return { revision: 1, allowedBaseBranches: ['main'] };
    },
    inspect,
    prepare: async (_preview, directory, branch) => {
      await cp(source, directory, { recursive: true });
      git(directory, 'checkout', '-qb', branch);
      return { ...(await inspect()), directory, featureBranch: branch };
    },
    verify: async () => {},
    ordinaryPreparation: {
      capture: async (account, selection, signal) => {
        if (readiness) {
          const proof = await readiness.captureOrdinaryRepositoryPreparation(
            account,
            selection,
            signal,
          );
          return options.historicalPreparation ? options.historicalPreparation(proof) : proof;
        }
        const resolved = catalog.resolve({ ...selection.runtime, mode: 'agent' });
        if (resolved.status !== 'compatible') throw Error('Offline runtime unavailable');
        return OrdinaryRepositoryPreparationSchema.parse({
          version: 1,
          originalBinding: account,
          runtimeBinding: resolved.binding,
          credentialDigest: 'a'.repeat(64),
        });
      },
      assert:
        readiness?.assertOrdinaryRepositoryPreparation ??
        (async (_proof, account) => {
          loadAccountProfiles().resumeRouting(account);
        }),
    },
  });
  cleanups.push(() => workspace.close());
  const signal = new AbortController();
  const localReady = options.localRepository
    ? await workspace.selectLocalRepository(
        binding,
        'primary',
        {
          runOn: 'local',
          runtime: {
            account: catalog.inventory().accounts[0].account,
            harness: 'codex',
            targetId: 'local-mac',
          },
        },
        signal.signal,
      )
    : undefined;
  const preview =
    localReady ??
    (await workspace.preview(
      binding,
      'fixture-github',
      'example/repo',
      signal.signal,
      options.silentPreparation
        ? {
            runOn: 'local',
            runtime: {
              account: catalog.inventory().accounts[0].account,
              harness: 'codex',
              targetId: 'local-mac',
            },
          }
        : undefined,
    ));
  const prepared = localReady ?? (await workspace.prepare(preview.id, binding, signal.signal));
  let reservation: Omit<
    import('../../repository-workspaces.js').HostRepositoryReservationInput,
    'signal'
  > = {
    id: prepared.id,
    binding,
    conversationId:
      options.chatRoute || options.silentPreparation
        ? nativeStartupSessionId(`repository:${prepared.id}`)
        : randomUUID(),
    taskRoot,
  };
  let reserved: import('../../repository-workspaces.js').HostRepositoryReservation;
  if (localReady)
    reservation = {
      ...reservation,
      runtimeBinding: localReady.ordinaryRuntime,
      commandFingerprint: 'a'.repeat(64),
    };
  if (!options.silentPreparation)
    reserved = await workspace.reserveHostTask({ ...reservation, signal: signal.signal });
  const auth: import('../../auth.js').AuthSession = {
    id: randomUUID(),
    expiresAt: Date.now() + (options.operatorLifetimeMs ?? 60000),
  };
  const operatorConnectionId = randomUUID();
  const detach = bindAgentLibraryTransport(operatorConnectionId, auth);
  cleanups.push(detach);
  const commandId = randomUUID();
  const request = {
    clientMsgId: commandId,
    capabilityRevision: catalog.inventory().capabilityRevision,
    runtime: {
      account: catalog.inventory().accounts[0].account,
      harness: 'codex' as const,
      targetId: 'local-mac',
      mode: 'agent' as const,
    },
    selection: {
      version: 1 as const,
      agent: {
        profileId: agentProfile.profileId,
        revision: agentProfile.revision,
        ...(agentProfile.kind ? { kind: agentProfile.kind } : {}),
      },
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: modelId,
      thinking: 'low',
    },
    payload: { text: 'Implement the task', intent: 'Original user intent' },
  };
  let preparation: Awaited<ReturnType<RepositoryWorkspaces['prepareOrdinarySession']>> | undefined;
  if (options.silentPreparation) {
    const resolved = catalog.resolve(request.runtime);
    if (resolved.status !== 'compatible') throw Error('Offline runtime unavailable');
    preparation = await workspace.prepareOrdinarySession(
      {
        allocationOperationId: 'allocation',
        id: prepared.id,
        binding,
        taskRoot,
        settings: {
          binding: resolved.binding,
          selection: request.selection,
          repositoryWorkspaceId: prepared.id,
        },
        agentProfile,
        signal: signal.signal,
      },
      events,
    );
    reservation = preparation.reservation;
    reserved = workspace.getHostReservation(reservation);
  }
  type CommandRequest = typeof request;
  // Each command fixture retains its own mocked native transport while sharing
  // the same real account/profile, repository and admission authorities.
  function commandFixture(
    reservation: Omit<
      import('../../repository-workspaces.js').HostRepositoryReservationInput,
      'signal'
    >,
    request: CommandRequest,
  ) {
    const commandId = request.clientMsgId;
    const rpc = {
      initialize: vi.fn(async () => {}),
      request: vi.fn(async (method: string): Promise<unknown> => {
        if (method === 'account/read')
          return options.api
            ? { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
            : { account: { type: 'chatgpt', email: configuration[0].email, planType: 'plus' } };
        if (method === 'config/read') return { config: {} };
        if (method === 'model/list')
          return {
            data: [
              {
                model: modelId,
                displayName: 'Fixture',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              },
            ],
            nextCursor: null,
          };
        throw Error('Unexpected native execution');
      }),
      close: vi.fn(),
    };
    const launch = vi.fn(() => {
      expect(events.getOrdinaryLocalCommandAdmission(commandId)?.state).toBe('uncertain');
      expect(workspace.getHostReservation(reservation).state).toBe('reserved');
      return rpc;
    });
    const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
      expect(value.admission).toBeInstanceOf(OwnedLocalCodexChatAdmission);
      expect(events.getOrdinaryLocalCommandAdmission(commandId)?.state).toBe('uncertain');
      expect(await readFile(join(value.workspace.directory!, 'task.txt'), 'utf8')).toBe(
        'accepted source',
      );
      value.admission.assertOptions({
        conversationId: reservation.conversationId,
        messageId: commandId,
        binding,
        profile: value.profile,
        session: { cwd: value.workspace.directory, mode: 'agent' },
        prompt: value.payload.text,
        systemPrompt: value.payload.systemPrompt,
        intent: value.payload.intent,
        model: request.selection.model,
        reasoningEffort: request.selection.thinking,
        agentProfile: value.expected.agentProfile,
        agentContext: value.expected.agentContext,
        repositoryWorkspace: value.workspace,
      });
      expect(
        value.admission.attach({
          onNotification: () => {},
          onRequest: async () => ({}),
          onClose: () => {},
        }),
      ).toBe(rpc);
    });
    const dependencies = {
      enabled: true,
      eventStore: events,
      library,
      workspace,
      reservation,
      commandId,
      operatorConnectionId,
      signal: signal.signal,
      env,
      privateRoot,
      launch,
      ...(options.api
        ? {
            launchApi: async (home: string) => {
              expect(events.getOrdinaryLocalCommandAdmission(commandId)?.state).toBe('uncertain');
              await writeFile(
                join(home, 'auth.json'),
                JSON.stringify({ OPENAI_API_KEY: 'synthetic-api-key' }),
                { mode: 0o600, flag: 'wx' },
              );
              return rpc;
            },
          }
        : {}),
      dispatch,
    };
    const create = () => {
      const driver = new OrdinaryLocalCodexOwnedRuntime(dependencies);
      cleanups.push(() => driver.close());
      return driver;
    };
    return { rpc, launch, dispatch, dependencies, create };
  }
  const owner = commandFixture(reservation, request);
  const prepareRepository = async () => {
    const preview = await workspace.preview(
      binding,
      'fixture-github',
      'example/repo',
      signal.signal,
      {
        runOn: 'local',
        runtime: {
          account: request.runtime.account,
          harness: 'codex',
          targetId: request.runtime.targetId,
        },
      },
    );
    return workspace.prepare(preview.id, binding, signal.signal);
  };
  const prepareSibling = async () => {
    const ready = await prepareRepository();
    const resolved = catalog.resolve(request.runtime);
    if (resolved.status !== 'compatible') throw Error('Offline runtime unavailable');
    const prepared = await workspace.prepareOrdinarySession(
      {
        allocationOperationId: randomUUID(),
        id: ready.id,
        binding,
        taskRoot,
        settings: {
          binding: resolved.binding,
          selection: request.selection,
          repositoryWorkspaceId: ready.id,
        },
        agentProfile,
        signal: signal.signal,
      },
      events,
    );
    const nextRequest = {
      ...structuredClone(request),
      clientMsgId: randomUUID(),
      payload: { text: 'Independently implement the second task', intent: 'Second user intent' },
    };
    return {
      ...commandFixture(prepared.reservation, nextRequest),
      request: nextRequest,
      reservation: prepared.reservation,
      reserved: workspace.getHostReservation(prepared.reservation),
      preparation: prepared,
    };
  };
  return {
    ...owner,
    commandFor: commandFixture,
    prepareRepository,
    prepareSibling,
    request,
    events,
    library,
    workspace,
    reservation,
    reserved: reserved!,
    preparation,
    agentProfile,
    root,
    targetPath,
    target,
    executablePath,
    configuration,
    writeProfiles,
    signal,
    auth,
    detach,
  };
}
