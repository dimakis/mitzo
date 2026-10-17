import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApplicationReview } from '../collaboration-application-review.js';
import { EventStore } from '../event-store.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { getAgentLibrary, closeAgentLibrary } from '../agent-library-runtime.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { authenticateToken, login, revokeAuthSession } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';
import { ordinaryLocalCodexHostContractRevision } from '../ordinary-local-codex-host-runtime.js';
import {
  captureOrdinaryRepositoryPreparation,
  assertOrdinaryRepositoryPreparation,
  assertOrdinarySilentPreparationAuthority,
} from '../ordinary-repository-preparation-authority.js';
import { createCollaborationContextSource } from '../collaboration-context-source.js';

// External tool configuration only. Actual account, source, settings, workspace,
// review/compiler and durable receipt owners are used below.
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
const cleanups: Array<() => void | Promise<void>> = [];
let importedIdleChatClosed = false;
afterEach(async () => {
  vi.restoreAllMocks();
  closeAgentLibrary();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function fixture() {
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
  const { ordinaryRepositoryRuntimeInventory } = await import('../ordinary-local-codex-entry.js');
  if (!importedIdleChatClosed) {
    const chat = await import('../chat.js');
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

it('derives actual settings and compiles visible source without allocating or dispatching', async () => {
  const f = await fixture();
  const result = await f.review();
  expect(result.settings).toMatchObject({
    binding: {
      account: { accountId: 'personal', profileRevision: f.binding.profileRevision },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'offline-mac' },
    },
    selection: {
      permission: { mode: 'ask', revision: 0 },
      model: 'fixture-model',
      thinking: 'low',
      context: { source: 'none', revision: null },
      agent: f.input.target.agent,
    },
    repositoryWorkspaceId: f.input.target.repositoryWorkspaceId,
  });
  expect(result.snapshot.capacity.status).toBe('unverified');
  expect(result.snapshot.messages[0].blocks[0].content).toBe('Visible source');
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|credentialDigest|nativeWitness|privateHome|external-github-source/,
  );
  expect(f.store.listSessions()).toHaveLength(1);
  expect(f.workspaces.get(f.input.target.repositoryWorkspaceId).state).toBe('ready');
  expect(f.store.collaborationConversation.view(f.group).joins).toEqual([]);
  expect(() =>
    f.store.collaborationConversation.prepareJoin(f.group, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      name: 'Reviewer',
      settings: result.settings,
      snapshot: { snapshotId: result.snapshot.snapshotId, sha256: result.snapshot.sha256 },
    }),
  ).toThrow('capacity_refused');
});

it('recovers an exact completed review before resolving changed mutable account settings', async () => {
  const f = await fixture();
  const first = await f.review();
  await writeFile(f.profilesPath, '[]', { mode: 0o600 });
  expect(await f.review()).toEqual(first);
});

it('returns exact registered artifact labels and refuses unavailable retained artifact metadata', async () => {
  const f = await fixture();
  f.store.append('source', 'message_start', { messageId: 'answer' });
  f.store.append('source', 'block_start', {
    messageId: 'answer',
    blockId: 'text',
    blockType: 'text',
  });
  f.store.append('source', 'block_delta', {
    messageId: 'answer',
    blockId: 'text',
    delta: 'Exact artifact text',
  });
  f.store.append('source', 'block_end', {
    messageId: 'answer',
    blockId: 'text',
    blockType: 'text',
  });
  const end = f.store.append('source', 'message_end', { messageId: 'answer' });
  const output = f.store.registerSessionOutput('source', {
    requestId: randomUUID(),
    title: 'Actual registered title',
    source: {
      messageId: 'answer',
      blockId: 'text',
      messageEndSeq: end,
      sha256: digest('Exact artifact text'),
    },
  });
  f.input.selection.boundary = { sequence: end, messageId: 'answer' };
  f.input.selection.artifacts = [
    { artifactId: output.outputId, revision: output.revision, sha256: output.source.sha256 },
  ];
  const result = await f.review();
  expect(result.artifactLabels).toEqual([
    { ...f.input.selection.artifacts[0], title: 'Actual registered title' },
  ]);
  expect(await f.review()).toEqual(result);
  const db = new Database(join(f.root, '.mitzo', 'events.db'));
  try {
    db.prepare(
      "UPDATE events SET payload=json_set(payload,'$.delta','Changed artifact') WHERE session_id='source' AND type='block_delta'",
    ).run();
  } finally {
    db.close();
  }
  await expect(f.review()).rejects.toMatchObject({ code: 'snapshot_changed' });
});

it('concurrent identical requests retain one immutable review and no allocation', async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.review(), f.review()]);
  expect(second).toEqual(first);
  expect(f.store.collaborationConversation.view(f.group).cursor).toBe(1);
  expect(f.store.listSessions()).toHaveLength(1);
});

it('renews real credential custody instead of accepting the preparation row alone', async () => {
  const f = await fixture();
  await writeFile(
    join(f.loginRoot, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'changed-offline' } }),
    { mode: 0o600 },
  );
  await expect(f.review()).rejects.toMatchObject({ code: 'execution_unavailable' });
  expect(
    f.store.collaborationConversation.getReviewCompilation(f.group, f.input.selection.requestId),
  ).toBeNull();
});

it('refuses an actual reserved target rather than reusing the source workspace', async () => {
  const f = await fixture();
  const taskRoot = join(f.root, 'tasks');
  await mkdir(taskRoot, { mode: 0o700 });
  await f.workspaces.reserveHostTask({
    id: f.input.target.repositoryWorkspaceId,
    binding: f.binding,
    conversationId: 'source',
    taskRoot,
    runtimeBinding: f.workspaces.get(f.input.target.repositoryWorkspaceId).ordinaryPreparation!
      .runtimeBinding,
    commandFingerprint: digest('existing explicit reservation'),
    signal: f.controller.signal,
  });
  await expect(f.review()).rejects.toMatchObject({ code: 'execution_unavailable' });
});

it('refuses target reservation that commits during asynchronous ordinary requalification', async () => {
  const f = await fixture();
  const qualify = f.workspaces.qualifiedStatus.bind(f.workspaces);
  vi.spyOn(f.workspaces, 'qualifiedStatus').mockImplementation(async (...args) => {
    const result = await qualify(...args);
    const taskRoot = join(f.root, 'racing-tasks');
    await mkdir(taskRoot, { mode: 0o700 });
    await f.workspaces.reserveHostTask({
      id: f.input.target.repositoryWorkspaceId,
      binding: f.binding,
      conversationId: 'another-explicit-owner',
      taskRoot,
      runtimeBinding: f.workspaces.get(f.input.target.repositoryWorkspaceId).ordinaryPreparation!
        .runtimeBinding,
      commandFingerprint: digest('concurrent explicit reservation'),
      signal: f.controller.signal,
    });
    return result;
  });
  await expect(f.review()).rejects.toMatchObject({ code: 'execution_unavailable' });
  expect(
    f.store.collaborationConversation.getReviewCompilation(f.group, f.input.selection.requestId),
  ).toBeNull();
});

it('freezes permission intent and the exact published revision across awaited setup', async () => {
  const f = await fixture();
  const qualify = f.workspaces.qualifiedStatus.bind(f.workspaces);
  vi.spyOn(f.workspaces, 'qualifiedStatus').mockImplementation(async (...args) => {
    const result = await qualify(...args);
    Object.assign(f.input.target, { permissionMode: 'auto' });
    const library = getAgentLibrary();
    const previous = library.version('user', f.input.target.agent.profileId, 1)!;
    library.saveDraft('user', {
      profileId: previous.profileId,
      expectedVersion: 0,
      expectedRevision: 1,
      idempotencyKey: 'new-draft',
      definition: { ...previous.definition, instructions: 'New revision for future reviews.' },
    });
    library.publish('user', {
      profileId: previous.profileId,
      expectedVersion: 2,
      idempotencyKey: 'new-publish',
    });
    return result;
  });
  const result = await f.review();
  expect(result.settings.selection.permission).toEqual({ mode: 'ask', revision: 0 });
  expect(result.settings.selection.agent.revision).toBe(1);
});

it.each(['privacy', 'source-bytes'] as const)(
  'refuses late %s changes before the actual snapshot transaction commits',
  async (phase) => {
    const f = await fixture();
    const complete = f.store.collaborationConversation.completeReviewCompilation.bind(
      f.store.collaborationConversation,
    );
    vi.spyOn(f.store.collaborationConversation, 'completeReviewCompilation').mockImplementation(
      (...args) => {
        if (phase === 'privacy') f.store.hideSession('source');
        else {
          const db = new Database(join(f.root, '.mitzo', 'events.db'));
          try {
            db.prepare(
              "UPDATE events SET payload=json_set(payload,'$.text','Late changed bytes') WHERE session_id='source' AND type='user_message'",
            ).run();
          } finally {
            db.close();
          }
        }
        return complete(...args);
      },
    );
    await expect(f.review()).rejects.toThrow();
    expect(
      f.store.collaborationConversation.getReviewCompilation(f.group, f.input.selection.requestId)
        ?.snapshotId,
    ).toBeNull();
    expect(f.store.collaborationConversation.view(f.group).cursor).toBe(0);
  },
);

it.each(['brief', 'mode', 'previous', 'agent', 'account'] as const)(
  'rejects changed %s under an existing request before re-resolution',
  async (field) => {
    const f = await fixture();
    await f.review();
    const changed = structuredClone(f.input) as typeof f.input & {
      previousSnapshot?: { snapshotId: string; sha256: string };
    };
    if (field === 'brief') changed.selection.joiningBrief = 'Changed';
    if (field === 'mode') Object.assign(changed.target, { permissionMode: 'auto' });
    if (field === 'previous')
      changed.previousSnapshot = { snapshotId: randomUUID(), sha256: 'a'.repeat(64) };
    if (field === 'agent') changed.target.agent.revision++;
    if (field === 'account') changed.target.accountId = 'missing';
    await expect(f.review(changed)).rejects.toMatchObject({ code: 'request_conflict' });
  },
);

it.each([
  'null-agent',
  'unknown-account',
  'wrong-workspace',
  'missing-mode',
  'caller-revision',
] as const)('refuses %s rather than manufacturing setup', async (field) => {
  const f = await fixture();
  const changed = structuredClone(f.input);
  if (field === 'null-agent') Object.assign(changed.target, { agent: null });
  if (field === 'unknown-account') changed.target.accountId = 'missing';
  if (field === 'wrong-workspace') changed.target.repositoryWorkspaceId = randomUUID();
  if (field === 'missing-mode') Reflect.deleteProperty(changed.target, 'permissionMode');
  if (field === 'caller-revision') Object.assign(changed.target, { permissionRevision: 7 });
  await expect(f.review(changed)).rejects.toThrow();
  expect(f.store.listSessions()).toHaveLength(1);
});

it.each(['revoked', 'different-transport', 'hidden', 'aborted'] as const)(
  'refuses current %s observation authority even for an exact completed retry',
  async (field) => {
    const f = await fixture();
    await f.review();
    if (field === 'revoked') revokeAuthSession(f.auth);
    if (field === 'different-transport') claimTransportConnection(f.connectionId, 'different-auth');
    if (field === 'hidden') f.store.hideSession('source');
    if (field === 'aborted') f.controller.abort();
    await expect(f.review()).rejects.toThrow();
  },
);

it('retains original source custody for the synchronous save fence', async () => {
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  const sequence = store.append('source', 'user_message', {
    messageId: 'question',
    text: 'Original',
  });
  const source = createCollaborationContextSource({
    store,
    authorizeConversation: async () => {},
    assertConversationCurrent: () => {
      if (store.getSession('source')?.isHidden) throw Error('private');
    },
  });
  const opened = await source.openConversation({
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sourceConversationId: 'source',
    boundary: { sequence, messageId: 'question' },
    mode: 'conversation_so_far',
    messageIds: [],
    artifacts: [],
    purpose: 'Review',
    joiningBrief: '',
  });
  await opened.readPrefixWitness();
  await opened.readPage(0, 50);
  expect(() => source.assertCurrentAtSave()).not.toThrow();
  store.hideSession('source');
  expect(() => source.assertCurrentAtSave()).toThrow('private');
});

it('refuses a save assertion without both an opened source and its synchronous authority owner', async () => {
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  const source = createCollaborationContextSource({
    store,
    authorizeConversation: async () => {},
    assertConversationCurrent: () => {},
  });
  expect(() => source.assertCurrentAtSave()).toThrow();
  const legacy = createCollaborationContextSource({ store, authorizeConversation: async () => {} });
  await legacy.openConversation({
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sourceConversationId: 'source',
    boundary: { sequence: 0, messageId: null },
    mode: 'selected',
    messageIds: [],
    artifacts: [],
    purpose: 'Review',
    joiningBrief: '',
  });
  expect(() => legacy.assertCurrentAtSave()).toThrow();
});

it('checks the originally observed visible bytes instead of reopening a changed witness', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-review-source-save-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'events.db');
  const store = new EventStore(path);
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  const sequence = store.append('source', 'user_message', {
    messageId: 'question',
    text: 'Original',
  });
  const source = createCollaborationContextSource({
    store,
    authorizeConversation: async () => {},
    assertConversationCurrent: () => {},
  });
  const opened = await source.openConversation({
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sourceConversationId: 'source',
    boundary: { sequence, messageId: 'question' },
    mode: 'selected',
    messageIds: ['question'],
    artifacts: [],
    purpose: 'Review',
    joiningBrief: '',
  });
  await opened.readSelected(['question']);
  const db = new Database(path);
  try {
    db.prepare("UPDATE events SET payload=json_set(payload,'$.text','Changed') WHERE seq=?").run(
      sequence,
    );
  } finally {
    db.close();
  }
  expect(() => source.assertCurrentAtSave()).toThrow('snapshot_changed');
});
