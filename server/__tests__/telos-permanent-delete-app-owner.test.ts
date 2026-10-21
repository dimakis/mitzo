import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createFreshTelosDatabaseFiles } from '../../packages/protocol/src/telos-sqlite-owners.js';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
let server: Server | undefined;
let appModule: typeof import('../app.js') | undefined;
let chatModule: typeof import('../chat.js') | undefined;
let root: string | undefined;
afterEach(async () => {
  if (server) await closeTestServer(server);
  appModule?.taskStore.close();
  chatModule?.eventStore.close();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it('permanently deletes an actually created owned leaf through real App initialization and interactive auth', async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-actual-app-delete-'));
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  };
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('TELOS_DB_PATH', files.canonical);
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', join(root, 'internal-token'));
  createFreshTelosDatabaseFiles(files);
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
  appModule = await import('../app.js');
  chatModule = await import('../chat.js');
  server = await listenOnLoopback(appModule.app);
  const login = await request(server)
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
  const purge = await post({
    requestId: randomUUID(),
    itemId: 'owned-leaf',
    operation: 'delete_permanently',
    expectedRevision: current.body.revision,
    confirmation: { itemId: 'owned-leaf', phrase: 'DELETE PERMANENTLY' },
  });
  expect(purge.status, JSON.stringify(purge.body)).toBe(200);
  const absent = await request(server)
    .get('/api/telos/work/items/owned-leaf')
    .auth(token, { type: 'bearer' });
  expect(absent.status).toBe(404);
}, 30000);
