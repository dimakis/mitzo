import { expect } from 'vitest';
import request from 'supertest';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import type { ColdHandoff } from './cold-handoff.js';

/** Called only after the initial carrier's successful exit and independently
 * observed worker PID reaping. The new child opens original files; no owner or
 * handler object crosses this process boundary. */
export async function coldReadback(
  handoff: ColdHandoff,
  record: (stage: string, facts: Record<string, unknown>) => Promise<void>,
) {
  const { selected, beforeWork, sources } = handoff;
  const app = { ...handoff.application, record };
  const configPath = join(app.root, 'cold-app-config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      token: app.token,
      operatorId: app.authenticated.id,
      connectionId: app.connectionIdTransport,
      taskId: selected.taskId,
      itemIds: [selected.itemId, 'studio'],
      sessionIds: selected.sessionIds,
      publication: selected.publication,
    }),
    { mode: 0o600 },
  );
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    NODE_OPTIONS: '--max-old-space-size=1024',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: app.root,
    AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
    AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
    COOKIE_MAX_AGE_HOURS: '1',
    S9_COHERENT_COLD_CONFIG: configPath,
  };
  Object.assign(env, handoff.environment);
  const child = fork(
    resolve('tests/integration/telos-s9/coherent-final-preparation/cold-child-app.mjs'),
    [],
    {
      cwd: resolve('.'),
      execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  // Register once at fork, before readiness or filesystem assertions can yield.
  // A child that already exited still has a mandatory terminal result to check.
  let terminalError: unknown;
  child.on('error', (error) => {
    terminalError = error;
  });
  const closeOutcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('close', (code, signal) => done({ code, signal })),
  );
  let finalAuthRelease: { operatorId: string; confirmed: true } | undefined;
  child.on('message', (message) => {
    const value = message as { type?: string; operatorId: string; confirmed?: boolean };
    if (value.type === 'auth-revoked' && value.confirmed === true)
      finalAuthRelease = { operatorId: value.operatorId, confirmed: true };
  });
  let diagnostic = '';
  for (const stream of [child.stdout, child.stderr])
    stream!.on('data', (bytes) => {
      diagnostic = (diagnostic + String(bytes)).slice(-65536);
    });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closeRequestError: unknown;
      try {
        if (child.exitCode === null && child.signalCode === null) {
          timer = setTimeout(() => child.kill('SIGKILL'), 5000);
          try {
            child.send({ type: 'close-private-app' }, (error) => {
              if (error) closeRequestError = error;
            });
          } catch (error) {
            closeRequestError = error;
          }
        }
        const outcome = await closeOutcome;
        await app.record('actual-cold-child-reaped', {
          pid: child.pid,
          ...outcome,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          diagnostic,
          finalAuthRelease: finalAuthRelease ?? null,
          terminalError: terminalError ? String(terminalError) : null,
          closeRequestError: closeRequestError ? String(closeRequestError) : null,
        });
        expect(outcome).toEqual({ code: 0, signal: null });
        expect(finalAuthRelease).toEqual({ operatorId: app.authenticated.id, confirmed: true });
        if (terminalError) throw terminalError;
        if (closeRequestError) throw closeRequestError;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })());

  let originalError: unknown;
  let cleanupError: unknown;
  try {
    const ready = await new Promise<{ pid: number; port: number; operatorId: string }>(
      (done, reject) => {
        const timer = setTimeout(
          () => reject(Error('Cold App readiness timeout: ' + diagnostic)),
          35000,
        );
        const onError = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        child.once('error', onError);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          reject(Error(`Cold App exit ${code}/${signal}: ${diagnostic}`));
        });
        child.on('message', (message) => {
          const value = message as { type?: string; pid: number; port: number; operatorId: string };
          if (value.type === 'ready') {
            clearTimeout(timer);
            child.off('error', onError);
            done(value);
          }
        });
      },
    );
    expect(ready.pid).not.toBe(process.pid);
    expect(ready.pid).not.toBe(handoff.initialAppPid);
    expect(ready.operatorId).toBe(app.authenticated.id);
    expect([3100, 3101, 3190]).not.toContain(ready.port);
    const target = `http://127.0.0.1:${ready.port}`;
    const http = async (path: string, init?: RequestInit) => {
      const call = init?.method === 'POST' ? request(target).post(path) : request(target).get(path);
      call
        .set('Authorization', 'Bearer ' + app.token)
        .set('X-Connection-Id', app.connectionIdTransport);
      if (init?.body) call.send(JSON.parse(String(init.body)));
      const response = await call;
      await app.record('actual-cold-app-http', {
        pid: ready.pid,
        path,
        status: response.status,
        body: response.headers['content-type']?.includes('json') ? response.body : undefined,
      });
      return response;
    };
    const { TelosWorkApiClient } = await import('@mitzo/client');
    const api = new TelosWorkApiClient(async (path, init) => {
      const response = await http(path, init);
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
    expect(await api.read(selected.itemId)).toEqual(beforeWork);
    for (const source of sources)
      expect(await api.readSource(selected.itemId, source.snapshot.snapshotId)).toEqual(source);
    const artifact = await http(
      `/api/telos/artifacts/${selected.artifact.id}?revision=${selected.artifact.revision}`,
    );
    expect(artifact.status).toBe(200);
    const bytes = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(artifact.text);
    expect(bytes).toEqual(Buffer.from(selected.report));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(selected.artifact.sha256);
    const retry = await http(
      app.kind === 'non-git'
        ? '/api/ordinary/workspaces/commands/first'
        : '/api/chat/local-codex/send',
      { method: 'POST', body: JSON.stringify(selected.command) },
    );
    expect(retry.status).toBe(202);
    const originalWorker = handoff.sessions.find((session) => session.cwd === selected.directory);
    expect(originalWorker).toBeDefined();
    expect(retry.body).toMatchObject({
      state: 'consumed',
      dispatched: false,
      sessionId: originalWorker!.sessionId,
    });
    const id = randomUUID();
    const snapshot = await new Promise<Record<string, unknown>>((done, reject) => {
      const timer = setTimeout(() => reject(Error('Cold owner snapshot timeout')), 10000);
      const listener = (message: unknown) => {
        const value = message as { id?: string; error?: string; value: Record<string, unknown> };
        if (value.id !== id) return;
        clearTimeout(timer);
        child.off('message', listener);
        if (value.error) reject(Error(value.error));
        else done(value.value);
      };
      child.on('message', listener);
      child.send({ type: 'snapshot', id });
    });
    expect(snapshot.pid).toBe(ready.pid);
    expect(snapshot.providerLaunches).toBe(0);
    expect(snapshot.task).toMatchObject({
      id: selected.taskId,
      status: 'done',
      artifacts: { report: `artifact:${selected.artifact.id}@${selected.artifact.revision}` },
    });
    expect(snapshot.items).toEqual(selected.canonicalItems);
    const stableSession = (session: Record<string, unknown>) =>
      Object.fromEntries(
        [
          'sessionId',
          'cwd',
          'accountBinding',
          'agentProfile',
          'agentContext',
          'repositoryWorkspaceId',
          'ordinaryWorkspaceId',
        ].map((key) => [key, session[key]]),
      );
    expect((snapshot.sessions as Record<string, unknown>[]).map(stableSession)).toEqual(
      handoff.sessions.map((session) =>
        stableSession(session as unknown as Record<string, unknown>),
      ),
    );
    if (selected.publication) expect(snapshot.publication).toEqual(selected.publication.durable);
    else expect(snapshot.publication).toBeNull();
    expect((await stat(selected.directory)).ino).toBe(selected.inode);
    expect(await readFile(join(selected.directory, 'recording-report.md'))).toEqual(
      Buffer.from(selected.report),
    );
    await app.record('actual-cold-os-process-owners-readback-and-original-command-retry', {
      ready,
      snapshot,
      sourcePacketsRetained: true,
      artifactExact: true,
      workspaceInodeRetained: true,
      postCloseParentDatabaseQueries: 0,
      realModelCalls: 0,
    });
  } catch (error) {
    originalError = error;
  } finally {
    try {
      await close();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError)
    throw new AggregateError(
      [...(originalError ? [originalError] : []), cleanupError],
      'Cold readback and awaited cleanup failed',
      { cause: originalError ?? cleanupError },
    );
  if (originalError) throw originalError;
}
