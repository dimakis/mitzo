import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../event-store.js';
import { AgentLibraryStore } from '../../agent-library-store.js';
import { RepositoryWorkspaces } from '../../repository-workspaces.js';
import { loadAccountProfiles } from '../../account-profiles.js';
import { bindAgentLibraryTransport } from '../../agent-library-transport.js';

import {
  OrdinaryLocalVertexTarget,
  localVertexCapabilities,
  ordinaryLocalVertexContractRevision,
} from '../../ordinary-local-vertex-capabilities.js';
import { nativeStartupSessionId } from '../../ordinary-repository-startup.js';
export async function ownedVertexRuntimeFixture(
  cleanups: Array<() => void | Promise<void>>,
  options: {
    contextRecipe?: boolean;
    chatRoute?: boolean;
    dual?: boolean;
    ordinaryPreparation?: boolean;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-owned-driver-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const privateRoot = join(root, 'custody'),
    taskRoot = options.chatRoute ? join(root, '.claude', 'repository-tasks') : join(root, 'tasks');
  if (options.chatRoute) {
    await mkdir(join(root, '.mitzo'), { mode: 0o700 });
    await mkdir(join(root, '.claude'), { mode: 0o700 });
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
  }
  for (const directory of [privateRoot, taskRoot]) await mkdir(directory, { mode: 0o700 });
  const targetPath = join(privateRoot, 'target.json');
  const target = {
    version: 1,
    targetId: 'local-mac',
    label: 'Local Mac',
    hostId: hostname(),
    runtimeContractRevision: ordinaryLocalVertexContractRevision(),
  };
  await writeFile(targetPath, JSON.stringify(target), { mode: 0o600 });
  const configPath = join(privateRoot, 'profiles.json');
  await writeFile(
    join(privateRoot, 'adc.json'),
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'offline',
      client_secret: 'offline',
      refresh_token: 'offline',
    }),
    { mode: 0o600 },
  );
  const configuration = [
    {
      id: 'personal',
      label: 'Personal',
      provider: 'anthropic-vertex',
      projectId: 'offline-project',
      region: 'offline-region',
      ...(options.dual
        ? { sandboxProvider: 'same-api-provider', sandboxProviderId: 'offline-api-provider-id' }
        : {}),
      credentialRef: join(privateRoot, 'adc.json'),
      models: [
        { id: 'fixture-model', label: 'Fixture model', reasoningEfforts: ['low'] },
        { id: 'next-model', label: 'Next model', reasoningEfforts: ['high'] },
      ],
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
        ? { contextRecipe: { version: 1, source: 'contexgin', agentName: 'fixture-agent' } }
        : {}),
    },
  });
  const agentProfile = library.publish('user', {
    profileId: 'developer',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
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
  git(source, 'add', 'task.txt');
  git(source, 'commit', '-qm', 'offline base');
  const baseOid = git(source, 'rev-parse', 'HEAD');
  const inspect = async () => ({ repository: 'example/repo', baseBranch: 'main', baseOid });
  const ordinaryAuthority = options.ordinaryPreparation
    ? await import('../../ordinary-repository-preparation-authority.js')
    : undefined;
  const workspace = new RepositoryWorkspaces(join(root, 'repositories'), {
    ...(ordinaryAuthority
      ? {
          ordinaryPreparation: {
            capture: ordinaryAuthority.captureOrdinaryRepositoryPreparation,
            assert: ordinaryAuthority.assertOrdinaryRepositoryPreparation,
          },
        }
      : {}),
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
  });
  cleanups.push(() => workspace.close());
  const signal = new AbortController();
  const preview = await workspace.preview(binding, 'fixture-github', 'example/repo', signal.signal);
  const prepared = await workspace.prepare(preview.id, binding, signal.signal);
  const reservation = {
    id: prepared.id,
    binding,
    conversationId: options.chatRoute
      ? nativeStartupSessionId(`repository:${prepared.id}`)
      : randomUUID(),
    taskRoot,
  };
  const reserved = await workspace.reserveHostTask({ ...reservation, signal: signal.signal });
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 },
    operatorConnectionId = randomUUID();
  const detach = bindAgentLibraryTransport(operatorConnectionId, auth);
  cleanups.push(detach);
  const env = {
    MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE: targetPath,
  };
  if (options.chatRoute) {
    vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_ENABLED', '1');
    vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE', targetPath);
  }
  const catalog = localVertexCapabilities(
    loadAccountProfiles(),
    new OrdinaryLocalVertexTarget(env),
    [agentProfile],
  );
  const commandId = randomUUID();
  const request = {
    clientMsgId: commandId,
    capabilityRevision: catalog.inventory().capabilityRevision,
    runtime: {
      account: catalog.inventory().accounts[0].account,
      harness: 'claude-sdk' as const,
      targetId: 'local-mac',
      mode: 'agent' as const,
    },
    selection: {
      version: 1 as const,
      agent: { profileId: 'developer', revision: 1 },
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: 'fixture-model',
      thinking: 'low',
    },
    payload: { text: 'Implement the task', intent: 'Original user intent' },
  };
  return {
    request,
    events,
    library,
    workspace,
    reservation,
    reserved,
    agentProfile,
    root,
    targetPath,
    target,
    configuration,
    writeProfiles,
    signal,
    auth,
    detach,
    dependencies: { operatorConnectionId, env, privateRoot },
  };
}
