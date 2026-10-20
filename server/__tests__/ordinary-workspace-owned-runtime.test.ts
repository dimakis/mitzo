import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { lstat, rename, mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
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

it('silently prepares an ordinary session with real readiness and private operator authority without a Git source', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    first = f.first;
  expect(first.receipt).toMatchObject({
    version: 2,
    workspaceKind: 'ordinary',
    workspaceId: first.reserved.id,
    sessionId: first.reserved.conversationId,
    firstCommandId: null,
  });
  expect(first.reserved.directory.startsWith(startup.root)).toBe(false);
  expect(f.events.getSession(first.receipt.sessionId)).not.toHaveProperty('repositoryWorkspaceId');
  expect(f.events.getOrdinaryInitialCommandId(first.receipt.sessionId)).toBeUndefined();
  expect(first.launch).not.toHaveBeenCalled();
  expect(first.dispatch).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  await expect(lstat(first.reserved.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(f.root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('admits the explicit ordinary first command through the real native bootstrap and existing dispatch owner', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    first = f.first;
  const outcome = await first
    .create()
    .admitPreparedFirst(first.receipt.allocationOperationId, first.request)
    .then(
      (value) => ({ value }),
      (error) => ({ error: String(error) }),
    );
  expect({
    outcome,
    repositoryLookups: f.legacyLookup.mock.calls.length,
    nativeLaunches: first.launch.mock.calls.length,
  }).toEqual({ outcome: { value: { dispatched: true } }, repositoryLookups: 0, nativeLaunches: 1 });
  expect(first.dispatch).toHaveBeenCalledOnce();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(
    f.events.getOrdinaryWorkspaceSessionPreparation(first.receipt.allocationOperationId)
      ?.firstCommandId,
  ).toBe(first.request.clientMsgId);
  expect(f.events.getOrdinaryLocalCommandAdmission(first.request.clientMsgId)?.state).toBe(
    'consumed',
  );
  await expect(lstat(join(first.reserved.directory, '.git'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('keeps concurrent ordinary allocations independent and dispatches each exact first command once', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    a = f.first,
    b = await f.prepareSibling();
  expect(
    new Set([a.reserved.id, b.reserved.id, a.receipt.sessionId, b.receipt.sessionId]).size,
  ).toBe(4);
  const driverA = a.create(),
    driverB = b.create();
  const results = await Promise.all([
    driverA.admitPreparedFirst(a.receipt.allocationOperationId, a.request),
    driverA.admitPreparedFirst(a.receipt.allocationOperationId, a.request),
    driverB.admitPreparedFirst(b.receipt.allocationOperationId, b.request),
  ]);
  expect(results.filter((r) => r.dispatched)).toHaveLength(2);
  expect(a.dispatch).toHaveBeenCalledOnce();
  expect(b.dispatch).toHaveBeenCalledOnce();
  expect(a.launch).toHaveBeenCalledOnce();
  expect(b.launch).toHaveBeenCalledOnce();
  await writeFile(join(a.reserved.directory, 'report.txt'), 'retained original work');
  await expect(
    driverA.admitPreparedFirst(a.receipt.allocationOperationId, a.request),
  ).resolves.toEqual({ dispatched: false });
  await expect(
    driverA.admitPreparedFirst(a.receipt.allocationOperationId, {
      ...a.request,
      payload: { ...a.request.payload, text: 'changed' },
    }),
  ).rejects.toThrow();
  expect(await readFile(join(a.reserved.directory, 'report.txt'), 'utf8')).toBe(
    'retained original work',
  );
  expect(f.legacyLookup).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('rejects revoked private operator authority before command or native effects', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    first = f.first,
    driver = first.create();
  revokeAuthSession(f.auth);
  await expect(
    driver.admitPreparedFirst(first.receipt.allocationOperationId, first.request),
  ).rejects.toThrow();
  expect(first.launch).not.toHaveBeenCalled();
  expect(first.dispatch).not.toHaveBeenCalled();
  expect(f.events.getOrdinaryLocalCommandAdmission(first.request.clientMsgId)).toBeUndefined();
});

it('rejects a replaced task parent before native launch and preserves its original reservation', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    first = f.first,
    driver = first.create();
  await rename(f.taskRoot, f.taskRoot + '-retained');
  await mkdir(f.taskRoot, { mode: 0o700 });
  await expect(
    driver.admitPreparedFirst(first.receipt.allocationOperationId, first.request),
  ).rejects.toThrow();
  expect(first.launch).not.toHaveBeenCalled();
  expect(first.dispatch).not.toHaveBeenCalled();
  expect(f.workspaces.getOrdinaryWorkspace(first.reserved.id).state).toBe('reserved');
  expect(f.events.getOrdinaryLocalCommandAdmission(first.request.clientMsgId)).toBeUndefined();
});

it('rejects replaced claimed custody on an exact retry without adopting or deleting either directory', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    first = f.first,
    driver = first.create();
  await driver.admitPreparedFirst(first.receipt.allocationOperationId, first.request);
  await writeFile(join(first.reserved.directory, 'report.txt'), 'saved');
  await rename(first.reserved.directory, first.reserved.directory + '-retained');
  await mkdir(first.reserved.directory, { mode: 0o700 });
  await expect(
    driver.admitPreparedFirst(first.receipt.allocationOperationId, first.request),
  ).rejects.toThrow();
  expect(first.launch).toHaveBeenCalledOnce();
  expect(first.dispatch).toHaveBeenCalledOnce();
  expect(await readFile(join(first.reserved.directory + '-retained', 'report.txt'), 'utf8')).toBe(
    'saved',
  );
  expect(f.events.getOrdinaryLocalCommandAdmission(first.request.clientMsgId)?.state).toBe(
    'consumed',
  );
});

it('reopens a command owner after a lost response and returns the consumed original without another native launch', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    first = f.first,
    driver = first.create();
  await driver.admitPreparedFirst(first.receipt.allocationOperationId, first.request);
  await writeFile(join(first.reserved.directory, 'report.txt'), 'retained across owner restart');
  driver.close();
  await expect(
    first.create().admitPreparedFirst(first.receipt.allocationOperationId, first.request),
  ).resolves.toEqual({ dispatched: false });
  expect(first.launch).toHaveBeenCalledOnce();
  expect(first.dispatch).toHaveBeenCalledOnce();
  expect(await readFile(join(first.reserved.directory, 'report.txt'), 'utf8')).toBe(
    'retained across owner restart',
  );
});

it('keeps native bootstrap uncertainty and original identities across a failed owner restart', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    first = f.first,
    driver = first.create();
  first.rpc.request.mockImplementation(async () => ({ config: {} }));
  await expect(
    driver.admitPreparedFirst(first.receipt.allocationOperationId, first.request),
  ).rejects.toThrow();
  expect(first.launch).toHaveBeenCalledOnce();
  expect(first.dispatch).not.toHaveBeenCalled();
  expect(f.events.getOrdinaryLocalCommandAdmission(first.request.clientMsgId)?.state).toBe(
    'uncertain',
  );
  expect(f.workspaces.getOrdinaryWorkspace(first.reserved.id).state).toBe('reserved');
  driver.close();
  await expect(
    first.create().admitPreparedFirst(first.receipt.allocationOperationId, first.request),
  ).resolves.toEqual({ dispatched: false });
  expect(first.launch).toHaveBeenCalledOnce();
  expect(
    f.events.getOrdinaryWorkspaceSessionPreparation(first.receipt.allocationOperationId)?.sessionId,
  ).toBe(first.receipt.sessionId);
  await expect(lstat(first.reserved.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('admits an explicit continuation into the original native owner and refuses a profile substitution', async () => {
  const f = await ownedOrdinaryRuntimeFixture(cleanup),
    first = f.first,
    driver = first.create();
  await driver.admitPreparedFirst(first.receipt.allocationOperationId, first.request);
  const next = {
    ...structuredClone(first.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Continue the retained report', intent: 'Continue' },
  };
  const changed = {
    ...next,
    clientMsgId: randomUUID(),
    selection: { ...next.selection, agent: { ...next.selection.agent, revision: 99 } },
  };
  await expect(driver.admitContinuation(changed)).rejects.toThrow();
  expect(f.events.getSendCommand(changed.clientMsgId)).toBeUndefined();
  await expect(driver.admitContinuation(next)).resolves.toEqual({ dispatched: true });
  await expect(driver.admitContinuation(next)).resolves.toEqual({ dispatched: false });
  expect(first.dispatchContinuation).toHaveBeenCalledOnce();
  expect(first.launch).toHaveBeenCalledOnce();
  expect(f.events.getOrdinaryLocalCommandAdmission(next.clientMsgId)?.state).toBe('consumed');
  expect(f.events.getSession(first.receipt.sessionId)?.ordinaryWorkspaceId).toBe(first.reserved.id);
  expect(f.legacyLookup).not.toHaveBeenCalled();
});
