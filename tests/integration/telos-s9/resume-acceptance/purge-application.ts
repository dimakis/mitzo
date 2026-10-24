import { expect } from 'vitest';
import request from 'supertest';
import { createServer, request as proxyRequest } from 'node:http';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { initializeFreshPrivateAppFiles } from '../coherent-final-preparation/fresh-private-files.js';
import { installPrivateCanonicalReadCli } from '../coherent-final-preparation/joined-canonical-cli.js';
import { createJoinedBrowser } from '../coherent-final-preparation/joined-browser-target.js';
import { vi } from 'vitest';

/** Test bootstrap only. Real exclusive birth, canonical DDL, App/stores/auth and
 * lifecycle host own qualification. No callback, permit or availability is injected. */
export async function createPurgeApplication(
  record: (stage: string, facts: Record<string, unknown>) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 's9-coherent-positive-purge-'))),
    canonical = join(root, 'telos.db');
  let target: number | undefined,
    token = '',
    operatorId = '',
    child: ChildProcess | undefined,
    terminal: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined,
    browser: Awaited<ReturnType<typeof createJoinedBrowser>> | undefined;
  const diagnostics: string[] = [];
  const front = createServer((req, res) => {
    if (!target) {
      res.writeHead(503);
      res.end('Private generation unavailable');
      return;
    }
    const upstream = proxyRequest(
      {
        hostname: '127.0.0.1',
        port: target,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (incoming) => {
        res.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(error));
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  const stop = async (final: boolean) => {
    if (!child || !terminal) return;
    const current = child,
      outcome = terminal;
    let finalAuthRelease: { operatorId: string; confirmed: true } | undefined;
    const observeRelease = (message: unknown) => {
      const value = message as { type?: string; operatorId: string; confirmed?: boolean };
      if (value.type === 'auth-revoked' && value.confirmed === true)
        finalAuthRelease = { operatorId: value.operatorId, confirmed: true };
    };
    current.on('message', observeRelease);
    target = undefined;
    const timer = setTimeout(() => current.kill('SIGKILL'), 5000);
    let sendFailure: unknown;
    try {
      if (current.exitCode === null && current.signalCode === null) {
        try {
          await new Promise<void>((done, reject) =>
            current.send({ type: 'close-private-purge-app', final, token }, (error) =>
              error ? reject(error) : done(),
            ),
          );
        } catch (error) {
          sendFailure = error;
        }
      }
      const ended = await outcome;
      await record('private-purge-child-reaped', {
        pid: current.pid,
        ...ended,
        final,
        finalAuthRelease: finalAuthRelease ?? null,
        diagnostics: [...diagnostics],
      });
      expect(ended).toEqual({ code: 0, signal: null });
      if (final) expect(finalAuthRelease).toEqual({ operatorId, confirmed: true });
      if (sendFailure) throw sendFailure;
    } finally {
      clearTimeout(timer);
      current.off('message', observeRelease);
      child = undefined;
      terminal = undefined;
    }
  };
  const close = async () => {
    const errors: unknown[] = [];
    for (const step of [
      async () => browser?.browser.close(),
      async () => stop(!!token),
      async () => {
        if (front.listening)
          await new Promise<void>((done, reject) =>
            front.close((error) => (error ? reject(error) : done())),
          );
      },
      async () => rm(root, { recursive: true, force: true }),
    ]) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    vi.unstubAllEnvs();
    if (errors.length) throw new AggregateError(errors, 'Purge fixture cleanup failed');
  };
  try {
    initializeFreshPrivateAppFiles(root, canonical, (db) => {
      const stamp = '2026-10-24T10:00:00';
      const insert = db.prepare(
        `INSERT INTO items(id,summary,intent,rationale,acceptance_criteria,profile,priority,context_hints,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,?,?,'manual',5,'{}',?,?,?,?)`,
      );
      for (const [id, title] of [
        ['purge-leaf', 'Disposable purge leaf'],
        ['retained-witness', 'Unrelated retained witness'],
      ]) {
        insert.run(
          id,
          title,
          'Synthetic offline qualification',
          'Preserve exact ownership',
          '["Explicit lifecycle verification"]',
          stamp,
          stamp,
          stamp,
          stamp,
        );
        db.prepare(
          "INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,NULL,'active',?)",
        ).run(id, stamp);
      }
    });
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('TELOS_DB_PATH', canonical);
    const cli = await installPrivateCanonicalReadCli(root, canonical);
    await record('private-purge-fresh-files-and-cli', { root, canonical, cli });
    await writeFile(join(root, 'profiles.json'), '[]', { mode: 0o600 });
    const start = async () => {
      const env: Record<string, string> = {
        NODE_ENV: 'test',
        NODE_OPTIONS: '--max-old-space-size=1024',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        REPO_PATH: root,
        TELOS_DB_PATH: canonical,
        AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
        AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
        COOKIE_MAX_AGE_HOURS: '1',
        MITZO_INTERNAL_TOKEN_PATH: join(root, 'internal-token'),
        MITZO_CODEX_PRIVATE_DIR: join(root, 'native-custody'),
        MITZO_ACCOUNT_PROFILES_FILE: join(root, 'profiles.json'),
        MITZO_CODEX_ENABLED: '0',
        MITZO_ORDINARY_LOCAL_CODEX_ENABLED: '0',
        MITZO_REPOSITORY_WORKSPACES_ENABLED: '0',
        MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB: '',
        MITZO_MODEL_LIMITS_CATALOG_FILE: resolve(
          'server/__tests__/fixtures/empty-model-limits.json',
        ),
      };
      for (const key of [
        'TMPDIR',
        'MGMT_MANUAL_ITEMS_PATH',
        'PYTHONPATH',
        'PYTHONNOUSERSITE',
        'PYTHONDONTWRITEBYTECODE',
      ])
        if (process.env[key] !== undefined) env[key] = process.env[key]!;
      const spawned = fork(
        resolve('tests/integration/telos-s9/resume-acceptance/purge-child.mjs'),
        [],
        {
          cwd: resolve('.'),
          execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
          env,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      child = spawned;
      terminal = new Promise((done) =>
        spawned.once('close', (code, signal) => done({ code, signal })),
      );
      spawned.on('error', (error) => diagnostics.push(String(error)));
      for (const stream of [spawned.stdout, spawned.stderr])
        stream!.on('data', (bytes) => {
          diagnostics.push(String(bytes));
        });
      const ready = await new Promise<{ pid: number; port: number }>((done, reject) => {
        const timer = setTimeout(() => reject(Error('Private purge App readiness timeout')), 35000);
        spawned.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        spawned.once('exit', (code, signal) => {
          clearTimeout(timer);
          reject(Error(`Private purge App early exit ${code}/${signal}`));
        });
        spawned.on('message', (message) => {
          const value = message as { type?: string; pid: number; port: number };
          if (value.type === 'ready') {
            clearTimeout(timer);
            done(value);
          }
        });
      });
      target = ready.port;
      expect([3100, 3101, 3190]).not.toContain(target);
      await record('private-purge-generation-ready', ready);
      return ready;
    };
    await new Promise<void>((done, reject) => {
      front.once('error', reject);
      front.listen(0, '127.0.0.1', done);
    });
    const address = front.address();
    if (!address || typeof address === 'string' || [3100, 3101, 3190].includes(address.port))
      throw Error('Private stable proxy required');
    const origin = 'http://127.0.0.1:' + address.port;
    await start();
    const login = await request(front)
      .post('/api/auth/login')
      .send({ passphrase: 'test-passphrase-for-vitest' });
    expect(login.status).toBe(200);
    token = login.body.token as string;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    const checked = await request(front).get('/api/auth/check').auth(token, { type: 'bearer' });
    expect(checked.status).toBe(200);
    operatorId = checked.body.authSessionId as string;
    expect(typeof operatorId).toBe('string');
    expect(operatorId.length).toBeGreaterThan(0);
    await record('actual-signed-purge-operator', { operatorId });
    const http = async (path: string, body?: object) => {
      const call = body ? request(front).post(path).send(body) : request(front).get(path);
      return call.auth(token, { type: 'bearer' });
    };
    browser = await createJoinedBrowser(origin, token, { viewport: { width: 390, height: 844 } });
    return {
      root,
      canonical,
      origin,
      page: browser.page,
      browser,
      http,
      record,
      close,
      async restart() {
        await browser!.page.goto('about:blank');
        await stop(false);
        return start();
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Purge bootstrap/cleanup failed', {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
