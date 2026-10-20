import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { CollaborationApplicationReview } from '../../collaboration-application-review.js';
import { EventStore } from '../../event-store.js';
import { RepositoryWorkspaces } from '../../repository-workspaces.js';
import { getAgentLibrary, closeAgentLibrary } from '../../agent-library-runtime.js';
import { loadAccountProfiles } from '../../account-profiles.js';
import { authenticateToken, login } from '../../auth.js';
import { bindAgentLibraryTransport } from '../../agent-library-transport.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../../transport-auth-ownership.js';
import { ordinaryLocalCodexHostContractRevision } from '../../ordinary-local-codex-host-runtime.js';
import {
  captureOrdinaryRepositoryPreparation,
  assertOrdinaryRepositoryPreparation,
  assertOrdinarySilentPreparationAuthority,
} from '../../ordinary-repository-preparation-authority.js';

export const cleanups: Array<() => void | Promise<void>> = [];
let importedIdleChatClosed = false;
export async function cleanupApplicationReviewFixtures() {
  vi.restoreAllMocks();
  closeAgentLibrary();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}
export const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

export async function fixture() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('External network is unavailable in this offline review');
    }),
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-application-review-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const loginRoot = join(root, 'login');
  await mkdir(loginRoot, { mode: 0o700 });
  await writeFile(
    join(loginRoot, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'offline' } }),
    { mode: 0o600 },
  );
  const profilesPath = join(root, 'profiles.json');
  const profiles = [
    {
      id: 'personal',
      label: 'Offline personal',
      provider: 'openai-codex',
      credentialRef: loginRoot,
      email: 'offline@example.invalid',
      planType: 'plus',
      models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'] }],
    },
  ];
  await writeFile(profilesPath, JSON.stringify(profiles), { mode: 0o600 });
  const executable = join(root, 'codex');
  const binary = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  await writeFile(executable, binary, { mode: 0o755 });
  const nativePath = join(root, 'native.json'),
    targetPath = join(root, 'target.json');
  await writeFile(
    nativePath,
    JSON.stringify({ version: 1, executablePath: executable, executableSha256: digest(binary) }),
    { mode: 0o600 },
  );
  await writeFile(
    targetPath,
    JSON.stringify({
      version: 1,
      targetId: 'offline-mac',
      label: 'Offline Mac',
      hostId: hostname(),
      runtimeContractRevision: ordinaryLocalCodexHostContractRevision(digest(binary)),
    }),
    { mode: 0o600 },
  );
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    MITZO_ACCOUNT_PROFILES_FILE: profilesPath,
    MITZO_CODEX_ENABLED: '1',
    MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB: '',
    MITZO_ORDINARY_LOCAL_CODEX_ENABLED: '1',
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativePath,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetPath,
    MITZO_INTERNAL_TOKEN_PATH: join(root, 'internal-token'),
    MITZO_CODEX_PRIVATE_DIR: join(root, 'private'),
  }))
    vi.stubEnv(key, value);
  await mkdir(join(root, '.mitzo'), { mode: 0o700 });
  const store = new EventStore(join(root, '.mitzo', 'events.db'));
  cleanups.push(() => store.close());
  const library = getAgentLibrary();
  library.saveDraft('user', {
    profileId: 'reviewer',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Reviewer',
      descriptor: 'Assistant',
      role: 'agent',
      instructions: 'Review the exact source.',
      expectedOutput: 'Findings',
      acceptanceCriteria: ['Cite evidence'],
      modelPolicyRole: 'agent',
    },
  });
  const published = library.publish('user', {
    profileId: 'reviewer',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  const token = await login('test-passphrase-for-vitest');
  const auth = (await authenticateToken(token!))!;
  const connectionId = randomUUID();
  claimTransportConnection(connectionId, auth.id);
  const unbind = bindAgentLibraryTransport(connectionId, auth);
  cleanups.push(() => {
    unbind();
    releaseTransportConnection(connectionId, auth.id);
  });
  const binding = loadAccountProfiles().resolve('personal', 'fixture-model');
  const source = join(root, 'external-github-source');
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
  await writeFile(join(source, 'source.txt'), 'Offline repository source');
  git(source, 'add', 'source.txt');
  git(
    source,
    '-c',
    'user.name=Offline',
    '-c',
    'user.email=offline@example.invalid',
    'commit',
    '-qm',
    'source',
  );
  const baseOid = git(source, 'rev-parse', 'HEAD');
  // External GitHub source and account access responses; repository preparation,
  // source hashing and all ordinary preparation authority stay real.
  const access = vi.fn(async (selected: typeof binding) => {
    loadAccountProfiles().resumeRouting(selected);
    return { revision: 1, allowedBaseBranches: ['main'] };
  });
  const workspaces = new RepositoryWorkspaces(join(root, 'repositories'), {
    authorize: access,
    inspect: async () => ({ repository: 'example/repo', baseBranch: 'main', baseOid }),
    prepare: async (_preview, directory, branch) => {
      await cp(source, directory, { recursive: true });
      git(directory, 'checkout', '-qb', branch);
      return {
        repository: 'example/repo',
        baseBranch: 'main',
        baseOid,
        directory,
        featureBranch: branch,
      };
    },
    ordinaryPreparation: {
      capture: captureOrdinaryRepositoryPreparation,
      assert: assertOrdinaryRepositoryPreparation,
      assertSilent: assertOrdinarySilentPreparationAuthority,
    },
  });
  cleanups.push(() => workspaces.close());
  const controller = new AbortController();
  const { ordinaryRepositoryRuntimeInventory } =
    await import('../../ordinary-local-codex-entry.js');
  if (!importedIdleChatClosed) {
    const chat = await import('../../chat.js');
    cleanups.push(() => {
      // Only the already-imported idle owners are released. No application or
      // native runtime is started merely to discover a teardown target.
      chat.registry.dispose();
      chat.eventStore.close();
      importedIdleChatClosed = true;
    });
  }
  const inventory = ordinaryRepositoryRuntimeInventory('local', 'codex');
  const preview = await workspaces.preview(
    binding,
    'external-github-account',
    'example/repo',
    controller.signal,
    {
      runOn: 'local',
      runtime: {
        account: inventory.result.accounts[0].account,
        harness: 'codex',
        targetId: 'offline-mac',
      },
    },
  );
  await workspaces.prepare(preview.id, binding, controller.signal);
  const group = randomUUID();
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'source' });
  const boundary = store.append('source', 'user_message', {
    messageId: 'question',
    text: 'Visible source',
    privateProviderIdentity: 'PRIVATE',
  });
  const input = {
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      sourceConversationId: 'source',
      boundary: { sequence: boundary, messageId: 'question' },
      mode: 'conversation_so_far' as const,
      messageIds: [],
      artifacts: [] as Array<{ artifactId: string; revision: number; sha256: string }>,
      purpose: 'Review',
      joiningBrief: 'Original brief',
    },
    target: {
      runOn: 'local' as const,
      accountId: 'personal',
      model: 'fixture-model',
      reasoningEffort: 'low' as string | null,
      agent: { profileId: published.profileId, revision: published.revision },
      repositoryWorkspaceId: preview.id,
      permissionMode: 'ask' as const,
    },
  };
  const owner = new CollaborationApplicationReview({ store, workspaces });
  const review = (raw: unknown = input) =>
    owner.review(auth, connectionId, group, raw, controller.signal);
  return {
    root,
    token,
    group,
    store,
    workspaces,
    auth,
    connectionId,
    controller,
    input,
    owner,
    review,
    access,
    profilesPath,
    profiles,
    binding,
    loginRoot,
  };
}
