import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLibraryStore } from '../agent-library-store.js';
import { EventStore } from '../event-store.js';
import { recordPermissionChange } from '../session-permission-revision.js';
import { OrdinaryLocalCodexSelectionOwner } from '../ordinary-local-codex-selection-owner.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from '../ordinary-local-codex-admission.js';
import { ordinaryLocalCodexBootstrapId } from '../ordinary-local-codex-admission.js';
import type { RepositoryWorkspaces } from '../repository-workspaces.js';

const fixtures: Array<() => void> = [];
afterEach(() => fixtures.splice(0).forEach((close) => close()));
function fixture() {
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
    provider: 'openai-codex' as const,
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
    hostReservation: {
      version: 1,
      taskRoot,
      rootIdentity: { dev: rootInfo.dev, ino: rootInfo.ino },
    },
  };
  const workspace = {
    getHostReservation: vi.fn((_input: unknown) => structuredClone(descriptor)),
    reserveHostTask: vi.fn(async (_input: unknown) => structuredClone(descriptor)),
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
  });
  const expected: OrdinaryLocalCodexAdmissionExpectation = {
    binding: {
      version: 2,
      account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'p1' },
      harness: { implementation: 'codex' },
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
  await expect(f.owner.assertCurrent(f.expected)).resolves.toBeUndefined();
  f.events.completeOrdinaryLocalCommand('command');
  expect(() => f.owner.assertCurrentSync(f.expected)).not.toThrow();
});
