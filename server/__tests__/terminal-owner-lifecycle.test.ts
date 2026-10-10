import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInteractiveAuth } from '../interactive-auth-core.js';
import {
  TerminalService,
  TerminalStore,
  type TerminalBackend,
  type TerminalTarget,
} from '../terminal-service.js';
let db: Database.Database, store: TerminalStore, service: TerminalService;
let target: TerminalTarget;
let backend: TerminalBackend;
let auth: ReturnType<typeof createInteractiveAuth>;
beforeEach(() => {
  vi.useFakeTimers();
  db = new Database(':memory:');
  store = new TerminalStore(db);
  target = { kind: 'host', label: 'Your Mac', cwd: '/tmp/operator', identity: 'host' };
  backend = {
    start: vi.fn(async () => ({ write: vi.fn(), resize: vi.fn(), detach: vi.fn() })),
    end: vi.fn(async () => {}),
  };
  auth = createInteractiveAuth({
    passphrase: 'synthetic-passphrase',
    secret: 'synthetic-secret-at-least-thirty-two-characters',
    maxAgeHours: 1,
    cookieName: 'test_auth',
  });
  service = new TerminalService(store, { resolve: async () => target, backend });
});
afterEach(() => {
  service.detachAll();
  db.close();
  vi.useRealTimers();
});
function bind(id: string, expiresAt = Date.now() + 1000) {
  const login = { id, expiresAt };
  service.bindOwner(login, auth.registerAuthSession);
  return login;
}
it('ends only the logged-out owner’s shell even after navigation releases its output subscription', async () => {
  const login = bind('login-a');
  bind('login-b');
  const terminal = await service.open(login.id, {});
  const other = await service.open('login-b', {});
  const unsubscribe = await service.subscribe(login.id, terminal.id, vi.fn());
  unsubscribe();
  expect(backend.end).not.toHaveBeenCalled();
  auth.revokeAuthSession(login);
  await service.reconcileOwners();
  expect(backend.end).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: terminal.id }));
  expect(store.read(login.id, terminal.id).state).toBe('ended');
  expect(store.read('login-b', other.id).state).toBe('running');
  expect(() => bind(login.id, login.expiresAt)).toThrow();
});
it('reclaims fifty expired shells after reconstruction before admitting a fresh login', async () => {
  for (let index = 0; index < 50; index++) {
    bind(`expired-${index}`);
    await service.open(`expired-${index}`, {});
  }
  service.detachAll();
  vi.setSystemTime(Date.now() + 2000);
  store = new TerminalStore(db);
  service = new TerminalService(store, { resolve: async () => target, backend });
  bind('fresh');
  expect((await service.open('fresh', {})).state).toBe('running');
  expect(backend.end).toHaveBeenCalledTimes(50);
  expect(store.list().filter((record) => record.state === 'running')).toHaveLength(1);
});
it('uses the persisted original sandbox cleanup receipt after its chat route changes', async () => {
  const login = bind('login-a');
  target = {
    kind: 'sandbox',
    label: 'Original',
    cwd: '/sandbox/task',
    identity: 'original-id',
    sessionId: 'chat-a',
    runtime: {
      sandboxName: 'original',
      sandboxId: 'physical-original',
      workdir: '/sandbox/task',
      appServerCommand: '/sandbox/run-mitzo-app-server',
      cli: '/registered/openshell',
      gateway: 'original-gateway',
      workspace: 'default',
      gatewayInsecure: false,
    },
  };
  const terminal = await service.open(login.id, { sessionId: 'chat-a' });
  service.detachAll();
  service = new TerminalService(new TerminalStore(db), {
    resolve: async () => {
      throw Error('Chat route now points elsewhere');
    },
    backend,
  });
  vi.setSystemTime(login.expiresAt + 1);
  await service.reconcileOwners();
  expect(backend.end).toHaveBeenCalledWith(
    expect.objectContaining({
      id: terminal.id,
      target: expect.objectContaining({
        runtime: expect.objectContaining({ sandboxId: 'physical-original' }),
      }),
    }),
  );
  expect(store.read(login.id, terminal.id).state).toBe('ended');
});
it('retries uncertain cleanup without freeing capacity or changing the original target', async () => {
  const login = bind('login-a');
  const terminal = await service.open(login.id, {});
  vi.mocked(backend.end).mockRejectedValueOnce(Error('Transport uncertain'));
  auth.revokeAuthSession(login);
  // The invalidation enqueues one attempt; another reconciliation retries it.
  await vi.waitFor(() => expect(backend.end).toHaveBeenCalledTimes(1));
  expect(store.read(login.id, terminal.id).state).toBe('running');
  await service.reconcileOwners();
  expect(backend.end).toHaveBeenCalledTimes(2);
  expect(store.read(login.id, terminal.id).state).toBe('ended');
});
it('waits for an in-flight start before ending a shell whose login was revoked', async () => {
  const login = bind('login-a');
  let complete!: (value: { write: () => void; resize: () => void; detach: () => void }) => void;
  vi.mocked(backend.start).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const opened = service.open(login.id, {});
  const rejected = expect(opened).rejects.toThrow();
  await vi.waitFor(() => expect(backend.start).toHaveBeenCalledTimes(1));
  auth.revokeAuthSession(login);
  expect(backend.end).not.toHaveBeenCalled();
  complete({ write: vi.fn(), resize: vi.fn(), detach: vi.fn() });
  await rejected;
  await service.reconcileOwners();
  expect(backend.end).toHaveBeenCalledTimes(1);
  expect(store.list().every((record) => record.state === 'ended')).toBe(true);
});
it('does not block a fresh host shell behind an unreachable expired sandbox cleanup', async () => {
  const oldLogin = bind('old');
  await service.open(oldLogin.id, {});
  bind('fresh');
  let finishCleanup!: () => void;
  vi.mocked(backend.end).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
  );
  auth.revokeAuthSession(oldLogin);
  await vi.waitFor(() => expect(backend.end).toHaveBeenCalledTimes(1));
  const opened = vi.fn();
  const pending = service.open('fresh', {}).then(opened);
  try {
    await vi.waitFor(
      () => expect(opened).toHaveBeenCalledWith(expect.objectContaining({ state: 'running' })),
      { timeout: 100 },
    );
  } finally {
    finishCleanup();
    await pending;
    await service.reconcileOwners();
  }
});
