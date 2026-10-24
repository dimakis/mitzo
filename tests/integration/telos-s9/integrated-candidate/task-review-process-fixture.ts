import { vi, expect, afterEach } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { request as proxyRequest } from 'node:http';
import { mkdir, writeFile, readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { EventStore } from '../../../../server/event-store';
import type { RepositoryWorkspaces } from '../../../../server/repository-workspaces';
import type { CodexConversationStore } from '../../../../server/codex-conversation-store';
import type { TaskStore } from '../../../../server/task-store';
export type RestartSnapshot = {
  allSessionIdentities: Array<{
    sessionId: string;
    ordinaryWorkspaceId?: string | null;
    cwd?: string | null;
  }>;
  executionBindings: Array<{
    taskId: string;
    binding: ReturnType<TaskStore['getTelosExecutionBinding']>;
  }>;
  roleContext: ReturnType<
    (typeof import('../../../../server/telos-work-role-context'))['resolveTelosWorkRoleContext']
  >;
  native: {
    conversation: ReturnType<CodexConversationStore['read']>;
    commands: ReturnType<CodexConversationStore['commands']>;
  };
  pid: number;
  generation: number;
  session: NonNullable<ReturnType<EventStore['getSession']>>;
  workspace: ReturnType<RepositoryWorkspaces['getOrdinaryWorkspace']>;
  preparation: ReturnType<EventStore['getOrdinaryWorkspaceSessionPreparation']>;
  admission: NonNullable<ReturnType<EventStore['getOrdinaryCommandAdmission']>>;
  events: ReturnType<EventStore['getSessionEvents']>;
  tasks: ReturnType<TaskStore['getTree']>;
  activeSessionIds: string[];
};
type RestartReady = {
  type: 'ready';
  pid: number;
  generation: number;
  port: number;
  authId: string;
  statePaths: Record<string, string>;
  startupRecovery: Record<string, unknown>;
  owners: string[];
  exclusions: string[];
};
export type NativeToolResult = {
  callId: string;
  name: string;
  wireName: string;
  threadId: string;
  turnId: string;
  result: { success: boolean; contentItems: Array<{ type: string; text?: string }> };
};
type RestartMessage =
  | RestartReady
  | { type: 'snapshot'; id: string; value: RestartSnapshot; error?: string }
  | { type: 'provider-tool-result'; id: string; value: NativeToolResult; error?: string };
import express from 'express';
import { createJoinedFrontend, createJoinedBrowser } from './joined-browser-target';
import { installPrivateCanonicalReadCli } from './joined-canonical-cli';

vi.mock('../../../../server/mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));

// Isolate modules imported by the seed fixture before its auth/native owners load.
const initial = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    path = await import('node:path'),
    os = await import('node:os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's9-task-review-seed-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'private'));
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', path.join(root, 'internal-token'));
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', undefined);
  return root;
});

let emergencyClose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await emergencyClose?.();
  emergencyClose = undefined;
});

export async function createTaskReviewProcessFixture() {
  const cleanups: Array<() => void | Promise<void>> = [];
  const evidence =
    process.env.S9_JOINED_SCREENSHOT_DIR ??
    (await realpath(await mkdtemp(join(tmpdir(), 's9-task-review-evidence-'))));
  await mkdir(evidence, { recursive: true });
  const { ownedOrdinaryRuntimeFixture } =
    await import('../../../../server/__tests__/fixtures/owned-ordinary-workspace-runtime');
  const f = await ownedOrdinaryRuntimeFixture(cleanups, {
    chatRoute: true,
    separateConfiguredWorkspace: true,
  });
  const { createTelosCanonicalData } =
    await import('../../../../server/__tests__/fixtures/telos-canonical-advisor');
  const seed = createTelosCanonicalData();
  // Synthetic initial canonical data only. No owner state is written after seed.
  seed.db
    .prepare(
      `INSERT INTO items(id,summary,intent,rationale,acceptance_criteria,profile,priority,context_hints,first_seen,last_seen,created_at,updated_at) VALUES('quiet-job','Quiet unrelated job','Keep unrelated draft','Isolation control','["Retain draft"]','manual',5,'{}',?,?,?,?)`,
    )
    .run(seed.stamp, seed.stamp, seed.stamp, seed.stamp);
  seed.db
    .prepare(
      `INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES('quiet-job',NULL,'active',?)`,
    )
    .run(seed.stamp);
  seed.db
    .prepare(
      `INSERT INTO items(id,summary,intent,rationale,acceptance_criteria,profile,priority,parent_id,context_hints,first_seen,last_seen,created_at,updated_at) VALUES('recording-slice','Record one acoustic sample','Retain one reviewed sample','Exact smallest child only','["Retain sample evidence"]','manual',7,'studio','{}',?,?,?,?)`,
    )
    .run(seed.stamp, seed.stamp, seed.stamp, seed.stamp);
  seed.db
    .prepare(
      `INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES('recording-slice',NULL,'active',?)`,
    )
    .run(seed.stamp);
  const canonicalRoot = await realpath(await mkdtemp(join(tmpdir(), 's9-task-review-canonical-')));
  cleanups.push(() => rm(canonicalRoot, { recursive: true, force: true }));
  const dbPath = join(canonicalRoot, 'canonical-retained.db');
  await seed.db.backup(dbPath);
  seed.close();
  vi.stubEnv('TELOS_DB_PATH', dbPath);
  const cli = await installPrivateCanonicalReadCli(f.configuredWorkspace, dbPath);
  await writeFile(join(evidence, 'mgmt-cli-pins.json'), JSON.stringify(cli, null, 2));
  // Release every parent seeding handle. Subsequent state belongs to child App.
  f.library.close();
  f.events.close();
  f.workspaces.close();
  const effectsPath = join(evidence, 'external-native-effects.jsonl');
  await writeFile(effectsPath, '');
  const lifecycle: Array<Record<string, unknown>> = [];
  let child: ChildProcess | undefined,
    generation = 0,
    target: number | undefined;
  let connectionId = '',
    operatorReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const pending = new Map<
    string,
    { resolve(value: RestartSnapshot): void; reject(error: Error): void }
  >();
  const toolPending = new Map<
    string,
    { resolve(value: NativeToolResult): void; reject(error: Error): void }
  >();
  const saveLifecycle = () =>
    writeFile(join(evidence, 'child-lifecycle.json'), JSON.stringify(lifecycle, null, 2));
  const safeEnv = {
    PATH: process.env.PATH!,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: 'en_US.UTF-8',
    TZ: 'UTC',
    NODE_OPTIONS: '--max-old-space-size=1024',
    NODE_ENV: 'test',
    AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
    AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
    COOKIE_MAX_AGE_HOURS: '1',
    REPO_PATH: f.configuredWorkspace,
    MITZO_CODEX_PRIVATE_DIR: f.privateRoot,
    MITZO_INTERNAL_TOKEN_PATH: join(f.root, 'internal-token'),
    MITZO_ORDINARY_TASK_ROOT: f.taskRoot,
    MITZO_ACCOUNT_PROFILES_FILE: join(f.root, 'profiles.json'),
    MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB: '',
    MITZO_CODEX_ENABLED: '1',
    MITZO_ORDINARY_LOCAL_CODEX_ENABLED: '1',
    MITZO_REPOSITORY_WORKSPACES_ENABLED: '0',
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: join(f.root, 'native.json'),
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: join(f.root, 'target.json'),
    MITZO_MODEL_LIMITS_CATALOG_FILE: resolve('server/__tests__/fixtures/empty-model-limits.json'),
    TELOS_DB_PATH: dbPath,
    MGMT_MANUAL_ITEMS_PATH: process.env.MGMT_MANUAL_ITEMS_PATH!,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const start = async () => {
    const configPath = join(f.root, `restart-generation-${++generation}.json`);
    await writeFile(configPath, JSON.stringify({ generation, token: f.token, effectsPath }), {
      mode: 0o600,
    });
    const spawned = fork(
      resolve('tests/integration/telos-s9/integrated-candidate/task-review-child-app.mjs'),
      [],
      {
        execArgv: ['--import', 'tsx'],
        cwd: resolve('.'),
        env: { ...safeEnv, S9_RESTART_CONFIG: configPath },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    child = spawned;
    for (const stream of [spawned.stdout, spawned.stderr])
      stream!.on('data', (bytes) => {
        appendFileSync(join(evidence, `child-${generation}.log`), bytes);
      });
    const ready = await new Promise<RestartReady>((done, reject) => {
      const timer = setTimeout(() => reject(Error('Child App readiness timeout')), 35_000);
      spawned.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(Error(`Child exited before readiness: ${code}/${signal}`));
      });
      spawned.on('message', (incoming) => {
        const message = incoming as RestartMessage;
        if (message?.type === 'ready') {
          clearTimeout(timer);
          done(message);
        }
        if (message?.type === 'provider-tool-result') {
          const request = toolPending.get(message.id);
          toolPending.delete(message.id);
          if (message.error) request?.reject(Error(message.error));
          else request?.resolve(message.value);
        }
        if (message?.type === 'snapshot') {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request?.reject(Error(message.error));
          else request?.resolve(message.value);
        }
      });
    });
    expect(ready.authId).toBe(f.auth.id);
    target = ready.port;
    lifecycle.push({ event: 'ready', ...ready });
    await saveLifecycle();
    return ready;
  };
  const crash = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const old = child;
    target = undefined;
    await new Promise<void>((done) => {
      old.once('exit', (code, signal) => {
        lifecycle.push({ event: 'exit', pid: old.pid, generation, code, signal });
        done();
      });
      old.kill('SIGKILL');
    });
    expect(() => process.kill(old.pid!, 0)).toThrow();
    await saveLifecycle();
  };
  let closed = false;
  const resources: { closeBrowser?: () => Promise<void>; closeFront?: () => Promise<void> } = {};
  emergencyClose = async () => {
    if (closed) return;
    closed = true;
    await resources.closeBrowser?.();
    await operatorReader?.cancel().catch(() => {});
    await crash();
    await resources.closeFront?.();
    for (const c of cleanups.reverse()) await c();
    await rm(initial, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  };
  const initialReady = await start();
  const proxy = express();
  proxy.use((req, res) => {
    if (!target) {
      req.socket.destroy();
      return;
    }
    const upstream = proxyRequest(
      {
        hostname: '127.0.0.1',
        port: target,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
        res.on('close', () => upstream.destroy());
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  const front = await createJoinedFrontend(proxy, f.root);
  resources.closeFront = () => front.close();
  const connectOperator = async () => {
    await operatorReader?.cancel().catch(() => {});
    const response = await fetch(front.origin + '/api/chat/events', {
      headers: { Authorization: 'Bearer ' + f.token },
    });
    expect(response.status).toBe(200);
    operatorReader = response.body!.getReader();
    let received = '';
    for (;;) {
      const chunk = await operatorReader.read();
      received += new TextDecoder().decode(chunk.value);
      const data = received.split('\n').find((line) => line.startsWith('data: '));
      if (data) {
        const welcome = JSON.parse(data.slice(6));
        expect(welcome.type).toBe('welcome');
        connectionId = welcome.connectionId;
        break;
      }
      if (chunk.done) throw Error('Actual SSE welcome missing');
    }
  };
  await connectOperator();
  const browser = await createJoinedBrowser(front.origin, f.token, {
    viewport: { width: 390, height: 844 },
  });
  resources.closeBrowser = () => browser.browser.close();
  await browser.page.addInitScript(() => localStorage.setItem('mitzo:transport', 'sse'));
  const pageErrors: string[] = [];
  browser.page.on('pageerror', (error) => pageErrors.push(error.message));
  const httpObservations: Array<Record<string, unknown>> = [];
  const http = async (path: string, init?: RequestInit) => {
    if (!path.startsWith('/api/')) throw Error('Private API path required');
    const headers = new Headers(init?.headers);
    headers.set('Authorization', 'Bearer ' + f.token);
    headers.set('X-Connection-Id', connectionId);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(front.origin + path, { ...init, headers });
    httpObservations.push({
      path,
      method: init?.method ?? 'GET',
      contentType: headers.get('Content-Type'),
      requestBody: init?.body ?? null,
      status: response.status,
      responseBody: await response.clone().text(),
    });
    await writeFile(
      join(evidence, 'actual-http-observations.json'),
      JSON.stringify(httpObservations, null, 2),
    );
    return response;
  };
  const { OrdinaryWorkspaceApiClient, TelosWorkApiClient } = await import('@mitzo/client');
  const snapshot = async (sessionId: string, commandId: string) => {
    const id = randomUUID();
    return new Promise<RestartSnapshot>((done, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Snapshot timeout'));
      }, 10_000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          done(v);
        },
        reject,
      });
      child!.send({ type: 'snapshot', id, sessionId, commandId });
    });
  };
  const nativeTool = (name: string, args: Record<string, unknown>) => {
    const id = randomUUID(),
      callId = randomUUID();
    return new Promise<NativeToolResult>((done, reject) => {
      const timer = setTimeout(() => {
        toolPending.delete(id);
        reject(Error('Native tool response timeout'));
      }, 45_000);
      toolPending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          done(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child!.send({ type: 'provider-tool-call', id, callId, name, args });
    });
  };
  return {
    f,
    front,
    browser,
    page: browser.page,
    pageErrors,
    api: new TelosWorkApiClient(http),
    ordinary: new OrdinaryWorkspaceApiClient(http),
    http,
    snapshot,
    nativeTool,
    initialReady,
    lifecycle,
    effects: async () =>
      (await readFile(effectsPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    crash,
    restart: async () => {
      const ready = await start();
      await connectOperator();
      return ready;
    },
    close: emergencyClose,
  };
}
