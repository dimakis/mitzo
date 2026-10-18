import { mkdirSync, renameSync, symlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createTelosOrdinaryWorkFixture } from './fixtures/telos-ordinary-work.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { eventStore as startupStore } from '../chat.js';
import { setAuthRevocationStore, revokeAuthSession } from '../auth.js';
// Isolate chat's legacy startup metadata before imports. This is not a Git source
// or an admitted workspace; every actual task must use its separate private ID/cwd.
const startup = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-native-startup-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'controller-private'));
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', undefined);
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-only-ordinary-native-token',
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
});
afterAll(() => {
  startupStore.close();
  startup.remove();
  vi.unstubAllEnvs();
});

const fixture = (role?: 'advisor' | 'lead' | 'worker') =>
  createTelosOrdinaryWorkFixture(cleanup, role);
it.each(['advisor', 'lead', 'worker'] as const)(
  'silently creates a %s for canonical home-studio work through non-Git ordinary owners',
  async (role) => {
    const f = await fixture(role),
      before = f.native.events.listSessions().length;
    const receipt = await f.owner.setup(f.actor, f.input, f.native.signal.signal);
    const linked = receipt.work.links.find((link) => link.role === role)!;
    expect(linked.conversation.namespace).toBe('mitzo');
    const id = linked.conversation.conversationId;
    expect(f.native.events.listSessions()).toHaveLength(before + 1);
    const session = f.native.events.getSession(id);
    expect(session?.ordinaryWorkspaceId).toBeTruthy();
    expect(session?.repositoryWorkspaceId).toBeUndefined();
    expect(f.native.workspaces.getOrdinaryWorkspaceForConversation(id)?.state).toBe('reserved');
    expect(f.native.events.getOrdinaryInitialCommandId(id)).toBeUndefined();
    expect(f.native.first.launch).not.toHaveBeenCalled();
    expect(f.native.forbidden).not.toHaveBeenCalled();
    expect(await f.owner.setup(f.actor, f.input, f.native.signal.signal)).toEqual(receipt);
    expect(f.native.events.listSessions()).toHaveLength(before + 1);
  },
);
it('rejects an unsupported Git operation before role/allocation intent, session, task or command effects', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  f.unsupported();
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  await expect(f.owner.setup(f.actor, f.input, f.native.signal.signal)).rejects.toThrow(
    'Required capability is unsupported by an ordinary non-Git workspace',
  );
  expect(reserve).not.toHaveBeenCalled();
  expect(f.native.events.listSessions()).toHaveLength(before);
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({ n: 0 });
  expect(
    f.native.events.getOrdinaryInitialCommandId(f.native.first.receipt.sessionId),
  ).toBeUndefined();
  expect(f.native.first.launch).not.toHaveBeenCalled();
  expect(f.native.forbidden).not.toHaveBeenCalled();
});

it('refuses a committed V2 receipt when its original ordinary session has become hidden', async () => {
  const f = await fixture();
  const receipt = await f.owner.setup(f.actor, f.input, f.native.signal.signal);
  const conversationId = receipt.work.links.find((link) => link.role === 'lead')!.conversation
    .conversationId;
  f.native.events.hideSession(conversationId);
  expect(f.native.events.getSession(conversationId)?.isHidden).toBe(true);
  await expect(f.owner.setup(f.actor, f.input, f.native.signal.signal)).rejects.toThrow();
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({ n: 1 });
});

it('recovers a V2 allocation interrupted after reservation across canonical owner restart without another workspace or session', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
  vi.spyOn(f.native.events, 'prepareOrdinaryWorkspaceSession').mockImplementationOnce(() => {
    throw Error('Injected before session receipt');
  });
  await expect(f.owner.setup(f.actor, f.input, f.native.signal.signal)).rejects.toThrow(
    'Injected before session receipt',
  );
  expect(reserve).toHaveBeenCalledOnce();
  const original = await reserve.mock.results[0].value;
  expect(f.native.events.getSession(original.conversationId)).toBeNull();
  const intent = f.work.prepareOrdinaryRoleSetup(f.input, f.actor).setup;
  f.restart();
  const receipt = await f.owner.setup(f.actor, f.input, f.native.signal.signal);
  expect(receipt.work.links.find((link) => link.role === 'lead')?.conversation.conversationId).toBe(
    original.conversationId,
  );
  expect(f.work.prepareOrdinaryRoleSetup(f.input, f.actor).setup).toEqual(intent);
  expect(await reserve.mock.results[1].value).toEqual(original);
  expect(f.native.events.listSessions()).toHaveLength(before + 1);
  expect(f.native.events.getSession(original.conversationId)?.ordinaryWorkspaceId).toBe(
    original.id,
  );
  expect(f.native.first.launch).not.toHaveBeenCalled();
});
it('concurrent V2 role requests resolve to the same original ordinary workspace and chat', async () => {
  const f = await fixture(),
    before = f.native.events.listSessions().length;
  const receipts = await Promise.all([
    f.owner.setup(f.actor, f.input, f.native.signal.signal),
    f.owner.setup(f.actor, f.input, f.native.signal.signal),
  ]);
  expect(receipts[1]).toEqual(receipts[0]);
  expect(f.native.events.listSessions()).toHaveLength(before + 1);
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({ n: 1 });
  expect(f.native.first.launch).not.toHaveBeenCalled();
  expect(f.native.forbidden).not.toHaveBeenCalled();
});

it.each(['unavailable', null])(
  'rejects unsupported thinking %s through real account authority before V2 role intent or ordinary allocation',
  async (thinking) => {
    const f = await fixture(),
      before = f.native.events.listSessions().length;
    f.input.settings.selection.thinking = thinking;
    const reserve = vi.spyOn(f.native.workspaces, 'reserveOrdinaryWorkspace');
    const outcome = await f.owner.setup(f.actor, f.input, f.native.signal.signal).then(
      () => 'accepted',
      () => 'rejected',
    );
    expect({
      outcome,
      roleIntents: f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get(),
      reservations: reserve.mock.calls.length,
      newSessions: f.native.events.listSessions().length - before,
      nativeLaunches: f.native.first.launch.mock.calls.length,
      originalCommand: f.native.events.getOrdinaryInitialCommandId(
        f.native.first.receipt.sessionId,
      ),
    }).toEqual({
      outcome: 'rejected',
      roleIntents: { n: 0 },
      reservations: 0,
      newSessions: 0,
      nativeLaunches: 0,
      originalCommand: undefined,
    });
  },
);

it.each(['unavailable', null])(
  'rejects unsupported thinking %s at direct ordinary reservation before allocation journal effects',
  async (thinking) => {
    const f = await fixture(),
      before = f.native.events.listSessions().length;
    const db = new Database(join(f.native.root, 'workspace-owner', 'workspaces.db'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const initial = db
        .prepare('SELECT count(*) AS n FROM ordinary_preparation_allocations')
        .get();
      const settings = {
        ...structuredClone(f.input.settings),
        selection: { ...f.input.settings.selection, thinking },
      };
      await expect(
        f.native.workspaces.reserveOrdinaryWorkspace({
          preparationId: settings.workspace.preparationId,
          allocationOperationId: randomUUID(),
          binding: f.native.binding,
          settings,
          agentProfile: f.native.first.reserved.agentProfile,
          taskRoot: f.native.taskRoot,
          signal: f.native.signal.signal,
        }),
      ).rejects.toThrow();
      expect(
        db.prepare('SELECT count(*) AS n FROM ordinary_preparation_allocations').get(),
      ).toEqual(initial);
      expect(f.native.events.listSessions()).toHaveLength(before);
      expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({
        n: 0,
      });
      expect(f.native.first.launch).not.toHaveBeenCalled();
      expect(f.native.forbidden).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it.each([
  'claiming',
  'replaced-directory',
  'symlink-directory',
  'replaced-root',
  'symlink-root',
] as const)(
  'refuses committed role replay with %s while retaining original allocation',
  async (damage) => {
    const f = await fixture();
    const original = await f.owner.setup(f.actor, f.input, f.native.signal.signal);
    const conversationId = original.work.links.find((link) => link.role === 'lead')!.conversation
      .conversationId;
    const record = f.native.workspaces.getOrdinaryWorkspaceForConversation(conversationId)!;
    const sessions = f.native.events.listSessions().length;
    if (damage === 'claiming') {
      const db = new Database(join(f.native.root, 'workspace-owner', 'workspaces.db'));
      try {
        db.prepare('UPDATE ordinary_workspaces SET record=? WHERE id=?').run(
          JSON.stringify({ ...record, state: 'claiming' }),
          record.id,
        );
      } finally {
        db.close();
      }
    } else if (damage.endsWith('directory')) {
      await f.native.workspaces.claimOrdinaryWorkspace({
        id: record.id,
        conversationId,
        binding: f.native.binding,
        taskRoot: f.native.taskRoot,
        signal: f.native.signal.signal,
      });
      renameSync(record.directory, record.directory + '-retained');
      if (damage === 'replaced-directory') mkdirSync(record.directory, { mode: 0o700 });
      else symlinkSync(record.directory + '-retained', record.directory);
    } else {
      renameSync(f.native.taskRoot, f.native.taskRoot + '-retained');
      if (damage === 'replaced-root') mkdirSync(f.native.taskRoot, { mode: 0o700 });
      else symlinkSync(f.native.taskRoot + '-retained', f.native.taskRoot);
    }
    await expect(f.owner.setup(f.actor, f.input, f.native.signal.signal)).rejects.toThrow();
    expect(f.native.events.listSessions()).toHaveLength(sessions);
    expect(f.native.workspaces.getOrdinaryWorkspaceForConversation(conversationId)?.id).toBe(
      record.id,
    );
    expect(f.native.first.launch).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({
      n: 1,
    });
  },
);

it('replays the same claimed role workspace while preserving legitimate files', async () => {
  const f = await fixture();
  const original = await f.owner.setup(f.actor, f.input, f.native.signal.signal);
  const conversationId = original.work.links.find((link) => link.role === 'lead')!.conversation
    .conversationId;
  const record = f.native.workspaces.getOrdinaryWorkspaceForConversation(conversationId)!;
  await f.native.workspaces.claimOrdinaryWorkspace({
    id: record.id,
    conversationId,
    binding: f.native.binding,
    taskRoot: f.native.taskRoot,
    signal: f.native.signal.signal,
  });
  const file = join(record.directory, 'retained-plan.txt');
  writeFileSync(file, 'Studio plan');
  const identity = statSync(record.directory).ino;
  expect(await f.owner.setup(f.actor, f.input, f.native.signal.signal)).toEqual(original);
  expect(statSync(record.directory).ino).toBe(identity);
  expect(readFileSync(file, 'utf8')).toBe('Studio plan');
});
it.each(['abort', 'revoke'] as const)(
  'rechecks role authority after custody readiness: %s',
  async (change) => {
    const f = await fixture();
    const original = await f.owner.setup(f.actor, f.input, f.native.signal.signal);
    const conversationId = original.work.links.find((link) => link.role === 'lead')!.conversation
      .conversationId;
    const before = f.native.events.listSessions().length;
    const revalidate = f.native.workspaces.revalidateOrdinaryWorkspace.bind(f.native.workspaces);
    vi.spyOn(f.native.workspaces, 'revalidateOrdinaryWorkspace').mockImplementationOnce(
      async (input) => {
        const result = await revalidate(input);
        if (change === 'abort') f.native.signal.abort();
        else revokeAuthSession(f.native.auth);
        return result;
      },
    );
    await expect(f.owner.setup(f.actor, f.input, f.native.signal.signal)).rejects.toThrow();
    expect(f.native.events.listSessions()).toHaveLength(before);
    expect(f.native.workspaces.getOrdinaryWorkspaceForConversation(conversationId)).toBeDefined();
  },
);
