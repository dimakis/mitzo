import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLibraryStore } from '../agent-library-store.js';
import { EventStore } from '../event-store.js';
import { recordPermissionChange } from '../session-permission-revision.js';
import { OrdinaryLocalCodexSelectionOwner } from '../ordinary-local-codex-selection-owner.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from '../ordinary-local-codex-admission.js';
import { ordinaryLocalCodexBootstrapId } from '../ordinary-local-codex-admission.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';

const fixtures: Array<() => void> = [];
afterEach(() => fixtures.splice(0).forEach((close) => close()));
function fixture(tools?: Array<{ id: string; version: number }>, responses = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-selection-owner-')));
  const taskRoot = join(root, 'tasks');
  mkdirSync(taskRoot, { mode: 0o700 });
  const events = new EventStore(join(root, 'events.db'));
  const library = new AgentLibraryStore(join(root, 'events.db'));
  fixtures.push(() => {
    library.close();
    events.close();
    rmSync(root, { recursive: true, force: true });
  });
  library.saveDraft('user', {
    profileId: 'agent',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Agent',
      descriptor: 'Assistant',
      role: 'agent',
      instructions: 'Use offline fixtures.',
      expectedOutput: 'An answer',
      acceptanceCriteria: ['Preserve ownership'],
      modelPolicyRole: 'agent',
      ...(tools === undefined ? {} : { tools }),
    },
  });
  const profile = library.publish('user', {
    profileId: 'agent',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  const binding = {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: responses ? ('openai' as const) : ('openai-codex' as const),
    profileRevision: 'p1',
    model: 'fixture',
  };
  const reservation = { id: randomUUID(), binding, conversationId: 'session', taskRoot };
  const rootInfo = statSync(taskRoot);
  const descriptor = {
    ...reservation,
    directory: join(taskRoot, 'checkout'),
    sandbox: false,
    state: 'reserved',
    featureBranch: 'fixture',
    hostReservation: {
      version: 1,
      taskRoot,
      rootIdentity: { dev: rootInfo.dev, ino: rootInfo.ino },
    },
  };
  const workspace = {
    getHostReservation: vi.fn((_input: unknown) => structuredClone(descriptor)),
    reserveHostTask: vi.fn(async (_input: unknown) => structuredClone(descriptor)),
    getForConversation: vi.fn((_id: string) => {
      const directory = descriptor.directory;
      const root = statSync(directory),
        git = statSync(join(directory, '.git'));
      return {
        ...structuredClone(descriptor),
        featureBranch: 'fixture',
        taskIdentity: {
          directory,
          featureBranch: 'fixture',
          root: { dev: root.dev, ino: root.ino },
          git: { dev: git.dev, ino: git.ino },
        },
      };
    }),
    validateHostTask: vi.fn(async (_id: string, _directory: string) => {}),
  };
  let authorized = true;
  const operator = {
    assertCurrent: vi.fn(() => {
      if (!authorized) throw Error('logout');
    }),
  };
  const abort = new AbortController();
  const owner = new OrdinaryLocalCodexSelectionOwner({
    events,
    library,
    workspace: workspace as unknown as RepositoryWorkspaces,
    reservation,
    operator,
    signal: abort.signal,
    commandId: 'command',
    responses,
  });
  const expected: OrdinaryLocalCodexAdmissionExpectation = {
    binding: {
      version: 2,
      account: { accountId: 'personal', provider: binding.provider, profileRevision: 'p1' },
      harness: { implementation: responses ? 'responses' : 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 't1' },
    },
    hostId: 'host',
    runtimeContractRevision: 'runtime',
    capabilityRevision: 'caps',
    workspace: { workspaceId: reservation.id, cwd: descriptor.directory },
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: 'fixture',
      thinking: null,
    },
    agentProfile: profile,
  };
  return {
    owner,
    expected,
    workspace,
    descriptor,
    events,
    library,
    profile,
    abort,
    revoke: () => {
      authorized = false;
    },
    operator,
    taskRoot,
    binding,
    root,
    reservation,
  };
}
it('qualifies exact published agent, operator, permission and retained reservation before bootstrap effects', async () => {
  const f = fixture();
  await expect(f.owner.assertCurrent(f.expected)).resolves.toBeUndefined();
  expect(f.workspace.reserveHostTask).toHaveBeenCalledOnce();
  expect(f.workspace.reserveHostTask.mock.calls[0][0]).toMatchObject({
    conversationId: 'session',
    id: f.expected.workspace.workspaceId,
  });
  expect(() => f.owner.assertCurrentSync(f.expected)).not.toThrow();
});
it('rejects another profile snapshot even with a self-consistent client hash', () => {
  const f = fixture();
  const changed = structuredClone(f.expected);
  changed.agentProfile!.definition.instructions = 'Forged instructions';
  changed.agentProfile!.contentHash = createHash('sha256')
    .update(JSON.stringify(changed.agentProfile!.definition))
    .digest('hex');
  expect(() => f.owner.assertCurrentSync(changed)).toThrow('selection unavailable');
});
it('refuses a builtin selection colliding with a published user profile before Library lookup', () => {
  const f = fixture();
  f.expected.selection.agent = { ...f.expected.selection.agent, kind: 'builtin' };
  const version = vi.spyOn(f.library, 'version');
  expect(() => f.owner.assertCurrentSync(f.expected)).toThrow('selection unavailable');
  expect(version).not.toHaveBeenCalled();
  expect(f.workspace.reserveHostTask).not.toHaveBeenCalled();
});
it.each(['operator', 'permission', 'workspace', 'root', 'context'] as const)(
  'refuses %s drift before a following effect',
  async (kind) => {
    const f = fixture();
    await f.owner.assertCurrent(f.expected);
    if (kind === 'operator') f.revoke();
    if (kind === 'permission') recordPermissionChange(f.events, 'session');
    if (kind === 'workspace') f.descriptor.binding.profileRevision = 'changed';
    if (kind === 'root') f.descriptor.hostReservation.rootIdentity.ino++;
    if (kind === 'context') f.expected.selection.context = { source: 'packs', revision: 'recipe' };
    expect(() => f.owner.assertCurrentSync(f.expected)).toThrow('selection unavailable');
  },
);
it('rechecks operator and exact reservation after an awaited workspace authorization', async () => {
  const f = fixture();
  f.workspace.reserveHostTask.mockImplementationOnce(async () => {
    f.revoke();
    return structuredClone(f.descriptor);
  });
  await expect(f.owner.assertCurrent(f.expected)).rejects.toThrow('selection unavailable');
});
it('rejects an existing conversation instead of inventing new-session authority', () => {
  const f = fixture();
  f.events.upsertSession({ sessionId: 'session', accountBinding: f.binding, mode: 'agent' });
  expect(() => f.owner.assertCurrentSync(f.expected)).toThrow('selection unavailable');
});
it('keeps the qualified selection across durable uncertainty and workspace materialization', async () => {
  const f = fixture();
  const fingerprint = 'ordinary-local-codex-v1:offline';
  f.expected.bootstrapId = ordinaryLocalCodexBootstrapId('session', fingerprint);
  await f.owner.assertCurrent(f.expected);
  f.events.admitOrdinaryLocalCommand(
    {
      sessionId: 'session',
      repositoryWorkspaceId: f.expected.workspace.workspaceId,
      cwd: f.expected.workspace.cwd,
      mode: 'agent',
      accountBinding: f.binding,
      agentProfile: f.profile,
    },
    f.expected.binding,
    {
      clientMsgId: 'command',
      requestFingerprint: fingerprint,
      selection: f.expected.selection,
      payload: { text: 'offline' },
    },
  );
  f.events.claimOrdinaryLocalCommandDispatch('command');
  await expect(f.owner.assertCurrent(f.expected)).resolves.toBeUndefined();
  f.descriptor.state = 'claimed';
  mkdirSync(join(f.descriptor.directory, '.git'), { recursive: true });
  await expect(f.owner.assertCurrent(f.expected)).resolves.toBeUndefined();
  f.events.completeOrdinaryLocalCommand('command');
  expect(() => f.owner.assertCurrentSync(f.expected)).not.toThrow();
});

async function claimedFixture() {
  const f = fixture();
  const source = join(f.root, 'source');
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
  writeFileSync(join(source, 'task.txt'), 'accepted source');
  git(source, 'add', 'task.txt');
  git(source, 'commit', '-qm', 'base');
  const baseOid = git(source, 'rev-parse', 'HEAD');
  const inspect = async () => ({ repository: 'example/repo', baseBranch: 'main', baseOid });
  const workspace = new RepositoryWorkspaces(join(f.root, 'repositories'), {
    authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
    inspect,
    prepare: async (_preview, directory, branch) => {
      cpSync(source, directory, { recursive: true });
      git(directory, 'checkout', '-qb', branch);
      return { ...(await inspect()), directory, featureBranch: branch };
    },
    verify: async () => {},
  });
  fixtures.push(() => workspace.close());
  const preview = await workspace.preview(
    f.binding,
    'fixture-github',
    'example/repo',
    f.abort.signal,
  );
  const prepared = await workspace.prepare(preview.id, f.binding, f.abort.signal);
  const reservation = { ...f.reservation, id: prepared.id };
  const reserved = await workspace.reserveHostTask({ ...reservation, signal: f.abort.signal });
  f.expected.workspace = { workspaceId: reserved.id, cwd: reserved.directory };
  const owner = new OrdinaryLocalCodexSelectionOwner({
    events: f.events,
    library: f.library,
    workspace,
    reservation,
    operator: f.operator,
    signal: f.abort.signal,
    commandId: 'command',
  });
  await owner.assertCurrent(f.expected);
  await workspace.claimReservedHostTask({ ...reservation, signal: f.abort.signal });
  await owner.assertCurrent(f.expected);
  return { ...f, owner, workspace, git, cwd: reserved.directory };
}
it.each(['checkout', 'git'] as const)(
  'rejects replaced claimed %s at the final synchronous effect fence',
  async (kind) => {
    const f = await claimedFixture();
    const path = kind === 'checkout' ? f.cwd : join(f.cwd, '.git');
    renameSync(path, path + '-retained');
    cpSync(path + '-retained', path, { recursive: true });
    expect(() => f.owner.assertCurrentSync(f.expected)).toThrow('selection unavailable');
  },
);
it.each(['checkout', 'git'] as const)(
  'rejects replaced claimed %s at awaited admission',
  async (kind) => {
    const f = await claimedFixture();
    const path = kind === 'checkout' ? f.cwd : join(f.cwd, '.git');
    renameSync(path, path + '-retained');
    cpSync(path + '-retained', path, { recursive: true });
    await expect(f.owner.assertCurrent(f.expected)).rejects.toThrow('selection unavailable');
  },
);
it('validates the retained Git claim after asynchronous workspace authorization', async () => {
  const f = await claimedFixture();
  const reserve = f.workspace.reserveHostTask.bind(f.workspace);
  vi.spyOn(f.workspace, 'reserveHostTask').mockImplementationOnce(async (input) => {
    const descriptor = await reserve(input);
    f.git(f.cwd, 'checkout', '-qb', 'substituted-branch');
    return descriptor;
  });
  await expect(f.owner.assertCurrent(f.expected)).rejects.toThrow('selection unavailable');
});
it('preserves legitimate edits and commits in the same retained checkout and Git directory', async () => {
  const f = await claimedFixture();
  writeFileSync(join(f.cwd, 'task.txt'), 'legitimate edit');
  expect(() => f.owner.assertCurrentSync(f.expected)).not.toThrow();
  await expect(f.owner.assertCurrent(f.expected)).resolves.toBeUndefined();
  f.git(f.cwd, 'add', 'task.txt');
  f.git(f.cwd, 'commit', '-qm', 'legitimate task change');
  expect(() => f.owner.assertCurrentSync(f.expected)).not.toThrow();
  await expect(f.owner.assertCurrent(f.expected)).resolves.toBeUndefined();
});

it.each([{ tools: [] }, { tools: [{ id: 'mitzo:Read', version: 1 }] }])(
  'refuses a published selected-tool snapshot before owned runtime bootstrap effects: %j',
  async ({ tools }) => {
    const f = fixture(tools);
    await expect(f.owner.assertCurrent(f.expected)).rejects.toThrow('selection unavailable');
    expect(f.workspace.reserveHostTask).not.toHaveBeenCalled();
  },
);

it.each([{ tools: [] }, { tools: [{ id: 'mitzo:Read', version: 1 }] }])(
  'admits a published selected-tool snapshot on the enrolled API owner: %j',
  async ({ tools }) => {
    const f = fixture(tools, true);
    await expect(f.owner.assertCurrent(f.expected)).resolves.toBeUndefined();
    expect(f.workspace.reserveHostTask).toHaveBeenCalledOnce();
    f.revoke();
    expect(() => f.owner.assertCurrentSync(f.expected)).toThrow('selection unavailable');
  },
);
