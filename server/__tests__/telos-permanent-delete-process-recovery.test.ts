import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createFreshTelosDatabaseFiles } from '../../packages/protocol/src/telos-sqlite-owners.js';
const children: ChildProcess[] = [];
const roots: string[] = [];
async function close(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Private App did not close'));
    }, 5000);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else reject(new Error(`Private App exit ${code}`));
    });
    child.send('close-private-app');
  });
}
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>((r) => child.once('close', () => r()));
      child.kill('SIGKILL');
      await ended;
    }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('recovers the identical committed deletion receipt after an actual App process exits and a new process opens the same files', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-process-receipt-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  };
  createFreshTelosDatabaseFiles(files);
  const db = new Database(files.canonical);
  db.pragma('journal_mode=WAL');
  db.exec(
    readFileSync(new URL('./fixtures/telos-canonical-3077b7b4/fresh.sql', import.meta.url), 'utf8'),
  );
  db.prepare(
    "INSERT INTO items(id,summary,profile,context_hints,first_seen,last_seen,created_at,updated_at) VALUES('leaf','Private process leaf','manual','{}',?,?,?,?)",
  ).run('now', 'now', 'now', 'now');
  db.close();
  const config = join(root, 'source-paths.json');
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        baseUrl: process.cwd(),
        paths: {
          '@mitzo/protocol': ['packages/protocol/src/index.ts'],
          '@mitzo/protocol/*': ['packages/protocol/src/*.ts'],
          '@mitzo/harness': ['packages/harness/src/index.ts'],
          '@mitzo/client': ['packages/client/src/index.ts'],
        },
      },
    }),
  );
  async function start() {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('server/__tests__/fixtures/telos-private-app-process.ts')],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          REPO_PATH: root,
          TELOS_DB_PATH: files.canonical,
          MITZO_INTERNAL_TOKEN_PATH: join(root, 'internal-token'),
          TSX_TSCONFIG_PATH: config,
          NODE_OPTIONS: '--max-old-space-size=1024',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.push(child);
    let diagnostic = '';
    child.stdout!.on('data', (data) => {
      diagnostic += String(data);
    });
    child.stderr!.on('data', (data) => {
      diagnostic += String(data);
    });
    return await new Promise<{ child: ChildProcess; port: number }>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Private App readiness timeout: ${diagnostic.slice(-1500)}`)),
        15000,
      );
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Private App exit before ready ${code}: ${diagnostic.slice(-1500)}`));
      });
      child.once('message', (message) => {
        clearTimeout(timer);
        if (
          typeof message !== 'object' ||
          message === null ||
          !('port' in message) ||
          typeof message.port !== 'number' ||
          !('pid' in message) ||
          message.pid !== child.pid
        )
          reject(new Error('Private App readiness identity mismatch'));
        else done({ child, port: message.port });
      });
    });
  }
  const first = await start();
  const url = `http://127.0.0.1:${first.port}`;
  const login = await request(url)
    .post('/api/auth/login')
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  expect(login.status).toBe(200);
  const token = login.body.token as string;
  const read = await request(url)
    .get('/api/telos/work/items/leaf/lifecycle')
    .auth(token, { type: 'bearer' });
  expect(read.status).toBe(200);
  const trash = await request(url)
    .post('/api/telos/work/lifecycle')
    .auth(token, { type: 'bearer' })
    .send({
      requestId: randomUUID(),
      itemId: 'leaf',
      operation: 'trash',
      expectedRevision: read.body.revision,
    });
  expect(trash.status).toBe(200);
  const reviewed = await request(url)
    .get('/api/telos/work/items/leaf/lifecycle')
    .auth(token, { type: 'bearer' });
  expect(reviewed.status).toBe(200);
  expect(reviewed.body.disposition).toBe('trashed');
  const input = {
    requestId: randomUUID(),
    itemId: 'leaf',
    operation: 'delete_permanently',
    expectedRevision: reviewed.body.revision,
    confirmation: { itemId: 'leaf', phrase: 'DELETE PERMANENTLY' },
  };
  const status = await new Promise<number | undefined>((done, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port: first.port,
        path: '/api/telos/work/lifecycle',
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (incoming) => {
        const value = incoming.statusCode;
        incoming.destroy();
        done(value);
      },
    );
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify(input));
  });
  expect(status).toBe(200);
  expect(
    (await request(url).get('/api/telos/work/items/leaf').auth(token, { type: 'bearer' })).status,
  ).toBe(404);
  await close(first.child);
  expect(first.child.exitCode).toBe(0);
  const receiptDb = new Database(files.canonical, { readonly: true });
  const saved = (
    receiptDb
      .prepare('SELECT receipt FROM telos_work_lifecycle_commands WHERE request_id=?')
      .get(input.requestId) as { receipt: string }
  ).receipt;
  receiptDb.close();
  const second = await start();
  expect(second.child.pid).not.toBe(first.child.pid);
  const cold = `http://127.0.0.1:${second.port}`;
  expect(
    (await request(cold).get('/api/telos/work/items/leaf').auth(token, { type: 'bearer' })).status,
  ).toBe(404);
  const retry = await request(cold)
    .post('/api/telos/work/lifecycle')
    .auth(token, { type: 'bearer' })
    .send({ ...input, confirmation: { itemId: 'leaf', phrase: 'DELETE PERMANENTLY' } });
  expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  expect(retry.body).toEqual(JSON.parse(saved));
  await close(second.child);
  expect(second.child.exitCode).toBe(0);
  console.info(
    JSON.stringify({
      kind: 'private-App-process-receipt',
      firstPid: first.child.pid,
      secondPid: second.child.pid,
      firstExit: first.child.exitCode,
      secondExit: second.child.exitCode,
      committedResponseBody: 'intentionally-unread',
      coldRecordStatus: 404,
      exactReceiptStatus: retry.status,
      modelCalls: 0,
    }),
  );
}, 45000);
