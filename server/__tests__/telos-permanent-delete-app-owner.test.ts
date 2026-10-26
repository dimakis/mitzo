import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, realpathSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { createFreshTelosDatabaseFiles } from '../../packages/protocol/src/telos-sqlite-owners.js';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
let server: Server | undefined;
let appModule: typeof import('../app.js') | undefined;
let chatModule: typeof import('../chat.js') | undefined;
let root: string | undefined;
afterEach(async () => {
  if (server) await closeTestServer(server!);
  appModule?.taskStore.close();
  chatModule?.eventStore.close();
  if (root) rmSync(root, { recursive: true, force: true });
  server = undefined;
  appModule = undefined;
  chatModule = undefined;
  root = undefined;
  vi.unstubAllEnvs();
});
async function fixture(owned = true) {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-actual-app-delete-'));
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  };
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('TELOS_DB_PATH', files.canonical);
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', join(root, 'internal-token'));
  if (owned) createFreshTelosDatabaseFiles(files);
  const seed = new Database(files.canonical);
  seed.pragma('journal_mode=WAL');
  seed.exec(
    readFileSync(new URL('./fixtures/telos-canonical-3077b7b4/fresh.sql', import.meta.url), 'utf8'),
  );
  seed
    .prepare(
      "INSERT INTO items(id,summary,profile,context_hints,first_seen,last_seen,created_at,updated_at) VALUES('owned-leaf','Private eligible leaf','manual','{}',?,?,?,?)",
    )
    .run('2026-10-21', '2026-10-21', '2026-10-21', '2026-10-21');
  seed.close();
  vi.resetModules();
  appModule = await import('../app.js');
  chatModule = await import('../chat.js');
  server = await listenOnLoopback(appModule.app);
  const login = await request(server!)
    .post('/api/auth/login')
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  expect(login.status).toBe(200);
  const token = login.body.token as string;
  const read = () =>
    request(server!)
      .get('/api/telos/work/items/owned-leaf/lifecycle')
      .auth(token, { type: 'bearer' });
  const post = (body: object) =>
    request(server!).post('/api/telos/work/lifecycle').auth(token, { type: 'bearer' }).send(body);
  const before = await read();
  expect(before.status).toBe(200);
  const trash = await post({
    requestId: randomUUID(),
    itemId: 'owned-leaf',
    operation: 'trash',
    expectedRevision: before.body.revision,
  });
  expect(trash.status).toBe(200);
  const current = await read();
  expect(current.body.disposition).toBe('trashed');
  return { files, token, read, post, current };
}
it('permanently deletes an actually created owned leaf through real App initialization and interactive auth', async () => {
  const { files, token, post, current } = await fixture();
  const purgeInput = {
    requestId: randomUUID(),
    itemId: 'owned-leaf',
    operation: 'delete_permanently',
    expectedRevision: current.body.revision,
    confirmation: { itemId: 'owned-leaf', phrase: 'DELETE PERMANENTLY' },
  };
  // The real response is intentionally abandoned after commit, without reading
  // its JSON receipt. No callback/receipt stub supplies the subsequent result.
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('Private server address missing');
  const lostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/api/telos/work/lifecycle',
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (incoming) => {
        const status = incoming.statusCode;
        incoming.destroy();
        resolve(status);
      },
    );
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify(purgeInput));
  });
  expect(lostStatus).toBe(200);
  const absent = await request(server!)
    .get('/api/telos/work/items/owned-leaf')
    .auth(token, { type: 'bearer' });
  expect(absent.status).toBe(404);
  const committed = new Database(files.canonical, { readonly: true });
  const receipt = (
    committed
      .prepare('SELECT receipt FROM telos_work_lifecycle_commands WHERE request_id=?')
      .get(purgeInput.requestId) as { receipt: string }
  ).receipt;
  committed.close();
  await closeTestServer(server!);
  server = undefined;
  appModule!.taskStore.close();
  chatModule!.eventStore.close();
  vi.resetModules();
  appModule = await import('../app.js');
  chatModule = await import('../chat.js');
  server = await listenOnLoopback(appModule.app);
  const coldAbsent = await request(server!)
    .get('/api/telos/work/items/owned-leaf')
    .auth(token, { type: 'bearer' });
  expect(coldAbsent.status).toBe(404);
  // This is a separate explicit exact retry with freshly entered typed phrase.
  const recovered = await post({
    ...purgeInput,
    confirmation: { itemId: 'owned-leaf', phrase: 'DELETE PERMANENTLY' },
  });
  expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
  expect(recovered.body).toEqual(JSON.parse(receipt));
  const changed = await post({ ...purgeInput, expectedRevision: '0'.repeat(64) });
  expect(changed.status).toBe(409);
}, 30000);

function purge(current: { body: { revision: string } }) {
  return {
    requestId: randomUUID(),
    itemId: 'owned-leaf',
    operation: 'delete_permanently',
    expectedRevision: current.body.revision,
    confirmation: { itemId: 'owned-leaf', phrase: 'DELETE PERMANENTLY' },
  };
}
it('denies borrowed actual TaskStore writers and complete retained bindings while preserving the leaf', async () => {
  const f = await fixture();
  const db = appModule!.taskStore.getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    expect((await f.post(purge(f.current))).status).toBe(409);
    expect(db.inTransaction).toBe(true);
  } finally {
    db.exec('ROLLBACK');
  }
  db.pragma('foreign_keys=OFF');
  db.prepare('INSERT INTO task_telos_execution_bindings VALUES(?,?,?,?,?,?,?,?)').run(
    'retained-task',
    'attempt',
    'owned-leaf',
    'lead',
    'worker',
    'snapshot',
    'a'.repeat(64),
    1,
  );
  expect((await f.post(purge(f.current))).status).toBe(409);
  expect((await f.read()).body.disposition).toBe('trashed');
}, 30000);
it('denies an observed canonical selection change even after change-back', async () => {
  const f = await fixture();
  vi.stubEnv('TELOS_DB_PATH', f.files.canonical + '.unavailable');
  expect((await f.post(purge(f.current))).status).toBe(503);
  vi.stubEnv('TELOS_DB_PATH', f.files.canonical);
  expect((await f.post(purge(f.current))).status).toBe(409);
  expect((await f.read()).body.disposition).toBe('trashed');
}, 30000);
it('denies actual chat TaskStore change-back even within the selected file family', async () => {
  const f = await fixture();
  const { TaskStore } = await import('../task-store.js');
  // An unrelated ordinary connection is excluded before it could replace the
  // installed owner. Keep that guard, then exercise actual installation ABA
  // with a distinct connection admitted by the same retained file family.
  expect(() => new TaskStore(join(root!, 'other-tasks.db'))).toThrow(
    expect.objectContaining({ code: 'MITZO_OWNER_BUSY' }),
  );
  const other = new TaskStore(f.files.tasks);
  try {
    expect(other.getDatabase()).not.toBe(appModule!.taskStore.getDatabase());
    chatModule!.setTaskStore(other);
    chatModule!.setTaskStore(appModule!.taskStore);
  } finally {
    other.close();
  }
  expect((await f.post(purge(f.current))).status).toBe(409);
  expect((await f.read()).body.disposition).toBe('trashed');
}, 30000);
it('denies an actual closed selected TaskStore', async () => {
  const f = await fixture();
  appModule!.taskStore.close();
  expect((await f.post(purge(f.current))).status).toBe(409);
  expect((await f.read()).body.disposition).toBe('trashed');
}, 30000);
it('denies revoked interactive authority before permanent deletion', async () => {
  const f = await fixture();
  const auth = await import('../auth.js');
  const session = await auth.authenticateToken(f.token);
  if (!session) throw new Error('Actual login session unavailable');
  auth.revokeAuthSession(session);
  expect((await f.post(purge(f.current))).status).toBe(401);
  const db = new Database(f.files.canonical, { readonly: true });
  try {
    expect(db.prepare("SELECT id FROM items WHERE id='owned-leaf'").get()).toBeDefined();
  } finally {
    db.close();
  }
}, 30000);
it('denies a replaced selected TaskStore after its original file is restored', async () => {
  const f = await fixture();
  renameSync(f.files.tasks, f.files.tasks + '.saved');
  copyFileSync(f.files.tasks + '.saved', f.files.tasks);
  expect([409, 503]).toContain((await f.post(purge(f.current))).status);
  rmSync(f.files.tasks);
  renameSync(f.files.tasks + '.saved', f.files.tasks);
  expect([409, 503]).toContain((await f.post(purge(f.current))).status);
  const db = new Database(f.files.canonical, { readonly: true });
  try {
    expect(db.prepare("SELECT id FROM items WHERE id='owned-leaf'").get()).toBeDefined();
  } finally {
    db.close();
  }
}, 30000);
it('keeps ordinary unknown-root reads but denies deletion without creation history', async () => {
  const f = await fixture(false);
  expect((await f.read()).body.disposition).toBe('trashed');
  expect((await f.post(purge(f.current))).status).toBe(409);
  expect((await f.read()).body.disposition).toBe('trashed');
}, 30000);
