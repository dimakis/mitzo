import { expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION } from '@mitzo/protocol';

import { nativeStartupSessionId } from '../../ordinary-repository-startup.js';
export async function ownedRuntimeFixture(
  cleanups: Array<() => void | Promise<void>>,
  options: {
    workspaceId?: string;
    contextRecipe?: boolean | 'workspace';
    chatRoute?: boolean;
    silentPreparation?: boolean;
    builtinPreparation?: boolean;
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
  const executablePath = join(root, 'codex'),
    nativePath = join(root, 'native.json'),
    targetPath = join(root, 'target.json');
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(executablePath, bytes, { mode: 0o755 });
  const target = {
    version: 1,
    targetId: 'local-mac',
    label: 'Local Mac',
    hostId: hostname(),
    runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256),
  };
  await writeFile(
    nativePath,
    JSON.stringify({ version: 1, executablePath, executableSha256: sha256 }),
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
      models: [{ id: 'fixture-model', label: 'Fixture model', reasoningEfforts: ['low'] }],
    },
  ];
  const writeProfiles = () =>
    writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
  writeProfiles();
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', configPath);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  vi.stubEnv('MITZO_CODEX_ENABLED', '1');
  const binding = loadAccountProfiles().resolve('personal', 'fixture-model');
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
  let agentProfile = library.publish('user', {
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
  const workspace = new RepositoryWorkspaces(join(root, 'repositories'), {
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
      capture: async (account, selection) => {
        const resolved = catalog.resolve({ ...selection.runtime, mode: 'agent' });
        if (resolved.status !== 'compatible') throw Error('Offline runtime unavailable');
        return {
          version: 1,
          originalBinding: account,
          runtimeBinding: resolved.binding,
          credentialDigest: 'a'.repeat(64),
        };
      },
      assert: async (_proof, account) => {
        loadAccountProfiles().resumeRouting(account);
      },
    },
  });
  cleanups.push(() => workspace.close());
  const signal = new AbortController();
  const preview = await workspace.preview(
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
  );
  const prepared = await workspace.prepare(preview.id, binding, signal.signal);
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
  if (!options.silentPreparation)
    reserved = await workspace.reserveHostTask({ ...reservation, signal: signal.signal });
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 },
    operatorConnectionId = randomUUID();
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
      model: 'fixture-model',
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
      request: vi.fn(async (method: string) => {
        if (method === 'account/read')
          return { account: { type: 'chatgpt', email: configuration[0].email, planType: 'plus' } };
        if (method === 'config/read') return { config: {} };
        if (method === 'model/list')
          return {
            data: [
              {
                model: 'fixture-model',
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
  const prepareSibling = async () => {
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
    const ready = await workspace.prepare(preview.id, binding, signal.signal);
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
