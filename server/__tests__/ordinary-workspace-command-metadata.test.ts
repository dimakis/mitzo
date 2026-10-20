import { afterAll, beforeAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { access, writeFile, readFile, rename, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import type { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';

const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getOrdinaryWorkspaces: () => services.workspace,
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'offline-resource-internal',
  isValidInternalToken: (value: unknown) => value === 'offline-resource-internal',
  isValidSignalCallbackToken: () => false,
  createSignalCallbackToken: vi.fn(() => 'offline-callback'),
  revokeSignalCallbackToken: vi.fn(),
}));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No model execution');
  },
}));

const cleanup: Array<() => void | Promise<void>> = [];
let f: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>;
let app: typeof import('../app.js');
let chat: typeof import('../chat.js');
let auth: typeof import('../auth.js');
let first: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>['first'];
let canonical: ReturnType<
  (typeof import('./fixtures/telos-canonical-advisor.js'))['createTelosCanonicalData']
>;
beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', undefined);
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external network or model calls');
    }),
  );
  const { ownedOrdinaryRuntimeFixture } =
    await import('./fixtures/owned-ordinary-workspace-runtime.js');
  f = await ownedOrdinaryRuntimeFixture(cleanup, {
    chatRoute: true,
    separateConfiguredWorkspace: true,
  });
  services.workspace = f.workspaces;
  const { createTelosCanonicalData } = await import('./fixtures/telos-canonical-advisor.js');
  canonical = createTelosCanonicalData();
  cleanup.push(() => canonical.close());
  vi.stubEnv('TELOS_DB_PATH', canonical.dbPath);
  await writeFile(join(f.configuredWorkspace, 'global.txt'), 'Configured workspace material');
  app = await import('../app.js');
  chat = await import('../chat.js');
  auth = await import('../auth.js');
  expect(relative(f.configuredWorkspace, f.taskRoot).startsWith('..')).toBe(true);
});
beforeEach(async () => {
  first = await f.prepareSibling();
  expect(chat.eventStore.getSession(first.receipt.sessionId)?.ordinaryWorkspaceId).toBe(
    first.reserved.id,
  );
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (f) auth.revokeAuthSession(f.auth);
  chat?.eventStore.close();
  app?.taskStore.close();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const get = (path: string) =>
  request(app.app)
    .get(path)
    .set('Authorization', 'Bearer ' + f.token)
    .query({ sessionId: first.receipt.sessionId });

it.each(['reserved', 'claimed'] as const)(
  'projects the %s silent workspace as prepared-first, without creating a command or launching a provider',
  async (state) => {
    if (state === 'claimed')
      await f.workspaces.claimOrdinaryWorkspace({ ...first.reservation, signal: f.signal.signal });
    const reserve = vi.spyOn(f.workspaces, 'reserveOrdinaryWorkspace'),
      claim = vi.spyOn(f.workspaces, 'claimOrdinaryWorkspace');
    const response = await get('/api/sessions/' + first.receipt.sessionId + '/meta');
    expect(response.status).toBe(200);
    expect(response.body.runtimeCommandScope).toBe('prepared-first-command');
    expect(response.body.ordinaryWorkspaceId).toBe(first.reserved.id);
    expect(response.body.runtimeBinding).toEqual(first.receipt.settings.binding);
    expect(f.events.getOrdinaryInitialCommandId(first.receipt.sessionId)).toBeUndefined();
    expect(reserve).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(first.launch).not.toHaveBeenCalled();
    if (state === 'reserved') await expect(access(first.reserved.directory)).rejects.toThrow();
  },
);
it.each(['claiming', 'hidden', 'missing-kind', 'replaced-root'] as const)(
  'refuses prepared-first for %s original custody without repair',
  async (damage) => {
    if (damage === 'claiming') {
      const db = new Database(join(f.root, 'workspace-owner', 'workspaces.db'));
      try {
        const record = f.workspaces.getOrdinaryWorkspace(first.reserved.id);
        db.prepare('UPDATE ordinary_workspaces SET record=? WHERE id=?').run(
          JSON.stringify({ ...record, state: 'claiming' }),
          record.id,
        );
      } finally {
        db.close();
      }
    } else if (damage === 'replaced-root') {
      await rename(f.taskRoot, f.taskRoot + '-' + first.reserved.id);
      await mkdir(f.taskRoot, { mode: 0o700 });
    } else if (damage === 'hidden') chat.eventStore.hideSession(first.receipt.sessionId);
    else {
      const db = new Database(join(f.configuredWorkspace, '.mitzo', 'events.db'));
      try {
        db.prepare('UPDATE sessions SET ordinary_workspace_id=NULL WHERE session_id=?').run(
          first.receipt.sessionId,
        );
      } finally {
        db.close();
      }
    }
    const response = await get('/api/sessions/' + first.receipt.sessionId + '/meta');
    expect(response.status).toBe(damage === 'missing-kind' ? 409 : 200);
    expect(response.body.runtimeCommandScope).not.toBe('prepared-first-command');
    expect(response.body.runtimeCommandReason ?? response.body.error).toMatch(
      /preserv|original|unavailable/i,
    );
    await expect(access(first.reserved.directory)).rejects.toThrow();
  },
);
it('refuses prepared-first after current native readiness is withdrawn', async () => {
  const target = process.env.MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE!;
  const bytes = await readFile(target);
  await writeFile(target, '{}');
  try {
    const response = await get('/api/sessions/' + first.receipt.sessionId + '/meta');
    expect(response.status).toBe(200);
    expect(response.body.runtimeCommandScope).not.toBe('prepared-first-command');
    expect(first.launch).not.toHaveBeenCalled();
  } finally {
    await writeFile(target, bytes);
  }
});
it('does not infer prepared-first from a generic internal token', async () => {
  const response = await request(app.app)
    .get('/api/sessions/' + first.receipt.sessionId + '/meta')
    .set('X-Internal-Token', 'offline-resource-internal');
  expect(response.status).toBe(200);
  expect(response.body.runtimeCommandScope).not.toBe('prepared-first-command');
  expect(first.launch).not.toHaveBeenCalled();
});

it.each(['hidden', 'replaced-root', 'revoked-operator'] as const)(
  'rechecks %s after awaited readiness before projecting prepared-first',
  async (damage) => {
    const token = await auth.login('test-passphrase-for-vitest');
    expect(token).toBeTruthy();
    const operator = await auth.authenticateToken(token!);
    expect(operator).toBeTruthy();
    const original = f.workspaces.qualifyOrdinaryWorkspace.bind(f.workspaces);
    vi.spyOn(f.workspaces, 'qualifyOrdinaryWorkspace').mockImplementationOnce(async (input) => {
      const result = await original(input);
      if (damage === 'hidden') chat.eventStore.hideSession(first.receipt.sessionId);
      else if (damage === 'replaced-root') {
        await rename(f.taskRoot, f.taskRoot + '-' + first.reserved.id);
        await mkdir(f.taskRoot, { mode: 0o700 });
      } else auth.revokeAuthSession(operator!);
      return result;
    });
    const response = await request(app.app)
      .get('/api/sessions/' + first.receipt.sessionId + '/meta')
      .set('Authorization', 'Bearer ' + token);
    expect(response.status).toBe(200);
    expect(response.body.runtimeCommandScope).not.toBe('prepared-first-command');
    expect(response.body.runtimeCommandReason).toMatch(/preserve|original|unavailable/i);
    expect(first.launch).not.toHaveBeenCalled();
  },
);
it('stops offering prepared-first after the real first-command ledger admission, without starting a provider', async () => {
  const meta = {
    sessionId: first.receipt.sessionId,
    ordinaryWorkspaceId: first.reserved.id,
    cwd: first.reserved.directory,
    accountBinding: f.binding,
    agentProfile: first.reserved.agentProfile,
    selectedModel: first.request.selection.model,
    reasoningEffort: first.request.selection.thinking,
    mode: 'agent' as const,
  };
  const admitted = f.events.admitPreparedOrdinaryWorkspaceCommand(
    first.receipt.allocationOperationId,
    meta,
    first.receipt.settings.binding,
    {
      clientMsgId: first.request.clientMsgId,
      requestFingerprint: 'offline-metadata-ledger',
      selection: first.request.selection,
      payload: first.request.payload,
    },
  );
  expect(admitted.admission.state).toBe('reserved');
  const response = await get('/api/sessions/' + first.receipt.sessionId + '/meta');
  expect(response.status).toBe(200);
  expect(response.body.runtimeCommandScope).not.toBe('prepared-first-command');
  expect(f.events.getOrdinaryInitialCommandId(first.receipt.sessionId)).toBe(
    first.request.clientMsgId,
  );
  expect(first.launch).not.toHaveBeenCalled();
});

it('uses pure canonical scope checks to withhold incomplete delegation, allow exact recovered linkage and recheck linkage after awaited readiness', async () => {
  const { TelosWorkStore } = await import('../telos-work-store.js');
  const { TelosWorkDelegation } = await import('../telos-work-delegation.js');
  const { reviewTelosWorkRoleContext } = await import('../telos-work-role-review.js');
  const { randomUUID } = await import('node:crypto');
  const work = new TelosWorkStore(canonical.dbPath, {
    ordinaryConversation: (id) => !!f.events.getSession(id),
  });
  const actor = { kind: 'operator' as const, id: f.auth.id },
    child = 'child-' + randomUUID();
  const command = (input: object) =>
    work.execute(
      {
        itemId: 'studio',
        requestId: randomUUID(),
        expectedRevision: work.read('studio', actor).revision,
        ...input,
      },
      actor,
    );
  try {
    command({ operation: 'classify', kind: 'outcome' });
    command({
      operation: 'link',
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId: first.receipt.sessionId },
    });
    command({
      operation: 'assign',
      role: 'lead',
      conversationId: first.receipt.sessionId,
      expectedAssignmentRevision: 0,
    });
    canonical.db
      .prepare(
        "INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,first_seen,last_seen,created_at,updated_at) VALUES(?,'studio','Arrange the session','Retain a plan','Independent work','[\"Plan retained\"]','manual',8,?,?,?,?)",
      )
      .run(child, canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
    work.execute(
      {
        operation: 'classify',
        itemId: child,
        requestId: randomUUID(),
        expectedRevision: work.read(child, actor).revision,
        kind: 'work_item',
      },
      actor,
    );
    const context = reviewTelosWorkRoleContext({
      work,
      artifacts: canonical.artifacts,
      actor,
      itemId: child,
      role: 'worker',
      selectedSourceSnapshotIds: [],
      selectedArtifactRefs: [],
    });
    const input = {
      version: 2 as const,
      requestId: randomUUID(),
      leadItemId: 'studio',
      childItemId: child,
      leadConversationId: first.receipt.sessionId,
      expectedRevision: context.brief.revision,
      mode: 'start' as const,
      predecessorAttemptId: null,
      settings: first.receipt.settings,
      contextSelection: context,
    };
    const resolve = async () => ({
      binding: f.binding,
      agentProfile: first.reserved.agentProfile,
      taskRoot: f.taskRoot,
      requiredCapabilities: ['ordinary_conversation', 'task_execution'],
    });
    const owner = new TelosWorkDelegation<'ordinary'>({
      workspaceKind: 'ordinary',
      work,
      events: f.events,
      tasks: app.taskStore,
      workspaces: f.workspaces,
      qualifyOrdinarySettings: resolve,
      resolvePreparation: resolve,
      authorize: async () => {
        if (!auth.isAuthSessionCurrent(f.auth)) throw Error('Private operator revoked');
      },
      assertBeforeApply: () => {
        if (!auth.isAuthSessionCurrent(f.auth)) throw Error('Private operator revoked');
      },
    });
    const prepare = f.events.prepareOrdinaryWorkspaceSession.bind(f.events);
    vi.spyOn(f.events, 'prepareOrdinaryWorkspaceSession').mockImplementationOnce((...args) => {
      prepare(...args);
      throw Error('Interrupted before role retention');
    });
    await expect(owner.delegate(actor, input, f.signal.signal)).rejects.toThrow(
      'Interrupted before role retention',
    );
    const intent = work.latestOrdinaryDelegationForHost(child)!;
    const original = f.events.getOrdinaryWorkspaceSessionPreparation(intent.allocationOperationId)!;
    const meta = () =>
      request(app.app)
        .get('/api/sessions/' + original.sessionId + '/meta')
        .set('Authorization', 'Bearer ' + f.token);
    const before = work.read(child, actor);
    const incomplete = await meta();
    expect(incomplete.status).toBe(200);
    expect(incomplete.body.runtimeCommandScope).not.toBe('prepared-first-command');
    expect(work.read(child, actor)).toEqual(before);
    expect(f.events.getOrdinaryInitialCommandId(original.sessionId)).toBeUndefined();
    const receipt = await owner.delegate(actor, input, f.signal.signal);
    expect(receipt.workerConversationId).toBe(original.sessionId);
    const wrapper = vi.spyOn(chat, 'resolveOwnedTelosWorkCommandScope');
    const ready = await meta();
    expect(ready.status).toBe(200);
    expect(ready.body.runtimeCommandScope).toBe('prepared-first-command');
    expect(wrapper).not.toHaveBeenCalled();
    const qualify = f.workspaces.qualifyOrdinaryWorkspace.bind(f.workspaces);
    vi.spyOn(f.workspaces, 'qualifyOrdinaryWorkspace').mockImplementationOnce(async (selected) => {
      const value = await qualify(selected),
        db = new Database(join(f.configuredWorkspace, '.mitzo', 'tasks.db'));
      try {
        db.prepare('DELETE FROM task_telos_execution_bindings WHERE task_id=?').run(
          receipt.attempt.executionTaskId,
        );
      } finally {
        db.close();
      }
      return value;
    });
    const damaged = await meta();
    expect(damaged.status).toBe(200);
    expect(damaged.body.runtimeCommandScope).not.toBe('prepared-first-command');
    expect(app.taskStore.get(receipt.attempt.executionTaskId!)?.status).toBe('pending');
    expect(app.taskStore.getTelosExecutionBinding(receipt.attempt.executionTaskId!)).toBeNull();
    expect(f.events.getOrdinaryInitialCommandId(original.sessionId)).toBeUndefined();
    expect(first.launch).not.toHaveBeenCalled();
    expect(wrapper).not.toHaveBeenCalled();
    expect(f.workspaces.getOrdinaryWorkspaceForConversation(original.sessionId)?.state).toBe(
      'reserved',
    );
  } finally {
    work.close();
  }
});
