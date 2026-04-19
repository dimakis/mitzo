import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, extname } from 'path';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { login, authMiddleware, COOKIE_NAME, MAX_AGE_HOURS } from './auth.js';
import {
  getSessions,
  getSessionsCached,
  reconcileSessionsBackground,
  getMessages,
  hideSession,
  clearHiddenSessions,
  renameSessionById,
  AVAILABLE_MODELS,
  BASE_REPO,
  getMcpServerNames,
  getRepoConfig,
  eventStore,
  registry,
  generateWtId,
} from './chat.js';
import {
  createWorktree,
  createSessionWorktrees as createAllWorktrees,
  listWorktrees,
} from './worktree.js';
import { GIT_BRANCH_TIMEOUT_MS } from './constants.js';
import { INTERNAL_TOKEN } from './internal-token.js';
import { getLocalCommit, isUpdateAvailable } from './git-version.js';
import { resolvePending } from './permissions.js';
import { createLogger } from './logger.js';
import {
  handleTaskSet,
  handleTaskComplete,
  handleTaskStatus,
  handleTaskBlock,
} from './task-tools.js';
import { setTaskStore } from './chat.js';
import {
  LoginBody,
  FileWriteBody,
  PermissionDecision,
  CalendarResponse,
  TodoListResponse,
  TodoCreateBody,
  TodoActionBody,
  TodoActionResponse,
  TaskCreateBody,
  TaskUpdateBody,
  LoopStartBody,
} from './api-schemas.js';
import type { TaskOrchestrator } from './task-orchestrator.js';
import {
  listInboxItems,
  readInboxItem,
  approveInboxItem,
  discardInboxItem,
  createInboxItem,
} from './inbox.js';
import { registerToken, removeToken, setTokenStorePath } from './apns.js';
import { SkillRegistry } from './skills.js';

import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { TaskStore } from './task-store.js';

const log = createLogger('server');

const __dirname = dirname(fileURLToPath(import.meta.url));

// Skill registry directories
const BUNDLED_SKILLS_DIR = join(__dirname, '..', 'skills');
const USER_SKILLS_DIR = join(homedir(), '.mitzo', 'skills');

/** Reserved native command names — skills with these names are ignored. */
export const NATIVE_COMMAND_NAMES = new Set(['skills']);

/** Cached registries keyed by cwd — avoids re-scanning the filesystem on every request. */
const registryCache = new Map<string, SkillRegistry>();

/** Build or retrieve a cached SkillRegistry for a given cwd (repo root). */
export function buildSkillRegistry(cwd?: string): SkillRegistry {
  const key = cwd ?? '';
  const cached = registryCache.get(key);
  if (cached) return cached;

  const repoDir = cwd ? join(cwd, '.mitzo', 'skills') : undefined;
  const registry = new SkillRegistry({
    bundledDir: BUNDLED_SKILLS_DIR,
    userDir: USER_SKILLS_DIR,
    repoDir,
    nativeNames: NATIVE_COMMAND_NAMES,
  });
  registryCache.set(key, registry);
  return registry;
}

/** Invalidate all cached registries — forces rediscovery on next request. */
export function invalidateSkillRegistries(): void {
  for (const reg of registryCache.values()) reg.invalidate();
  registryCache.clear();
}

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
        upgradeInsecureRequests: null,
      },
    },
  }),
);

// --- CORS for non-same-origin clients (Capacitor iOS, etc.) ---
// Mounted before yapper proxy so cross-origin voice requests get CORS headers.
const CORS_ALLOWED_ORIGINS =
  process.env.CORS_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()) ?? [];

if (CORS_ALLOWED_ORIGINS.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
}

// --- Yapper proxy (mounted before body parsing and authMiddleware — no login required for voice) ---

const YAPPER_TARGET = process.env.YAPPER_PROXY_TARGET || 'http://localhost:8700';

export const yapperHttpProxy = createProxyMiddleware({
  target: YAPPER_TARGET,
  changeOrigin: true,
  pathRewrite: { '^/api/yapper': '' },
});

export const yapperWsProxy = createProxyMiddleware({
  target: YAPPER_TARGET.replace(/^http/, 'ws'),
  changeOrigin: true,
  ws: true,
  pathRewrite: { '^/api/yapper-ws': '' },
});

app.use('/api/yapper', yapperHttpProxy);
app.use('/api/yapper-ws', yapperWsProxy);

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again in a minute' },
});

// --- Version / update state ---

const indexHtmlPath = join(__dirname, '..', 'frontend', 'dist', 'index.html');
let buildHash = '';
try {
  buildHash = createHash('md5').update(readFileSync(indexHtmlPath)).digest('hex').slice(0, 8);
} catch {
  // Expected when frontend hasn't been built yet
}

const startupCommit = getLocalCommit();
let updateAvailable = false;

let onUpdateAvailable: (() => void) | null = null;
let onInboxUpdated: (() => void) | null = null;
let onTaskBroadcast: ((event: Record<string, unknown>) => void) | null = null;
let orchestrator: TaskOrchestrator | null = null;

export function setOrchestrator(o: TaskOrchestrator): void {
  orchestrator = o;
}

// --- Task store ---

const mitzoDir = join(BASE_REPO, '.mitzo');
try {
  mkdirSync(mitzoDir, { recursive: true });
} catch {
  // may already exist
}
export const taskStore = new TaskStore(join(mitzoDir, 'tasks.db'));
setTaskStore(taskStore);
setTokenStorePath(join(mitzoDir, 'device-tokens.json'));

export function setUpdateBroadcast(fn: () => void) {
  onUpdateAvailable = fn;
}

export function setInboxBroadcast(fn: () => void) {
  onInboxUpdated = fn;
}

export function setTaskBroadcast(fn: (event: Record<string, unknown>) => void) {
  onTaskBroadcast = fn;
}

/** Broadcast inbox_updated to all connected WS clients. */
export function broadcastInboxUpdate() {
  onInboxUpdated?.();
}

export function runUpdateCheck() {
  const wasAvailable = updateAvailable;
  updateAvailable = isUpdateAvailable();
  if (updateAvailable && !wasAvailable) {
    log.info('update available — broadcasting to clients');
    onUpdateAvailable?.();
  }
}

// --- Routes ---

app.get('/api/version', (_req, res) =>
  res.json({ hash: buildHash, commit: startupCommit, updateAvailable }),
);

app.post('/api/version/check', authMiddleware, (_req, res) => {
  runUpdateCheck();
  res.json({ updateAvailable });
});

app.post('/api/permission/:permId/respond', (req, res) => {
  const token = req.query.token as string;
  const ntfyToken = process.env.NTFY_AUTH_TOKEN;
  if (!token || !ntfyToken || token !== ntfyToken) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const raw = req.query.decision || req.body?.decision || 'deny';
  const parsed = PermissionDecision.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid decision' });
    return;
  }

  const ok = resolvePending(req.params.permId as string, parsed.data);
  if (!ok) {
    res.status(404).json({ error: 'Permission request not found or already resolved' });
    return;
  }

  res.json({ ok: true, decision: parsed.data });
});

// --- Repo registry API (internal-token auth, no cookie needed) ---

function verifyInternalToken(req: express.Request): boolean {
  return req.headers['x-internal-token'] === INTERNAL_TOKEN;
}

app.get('/api/repos', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  res.json(Object.entries(getRepoConfig().repos).map(([name, path]) => ({ name, path })));
});

app.post('/api/repos/open', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }

  const { repoName, clientId } = req.body || {};

  if (!repoName || typeof repoName !== 'string') {
    res.status(400).json({ error: 'repoName is required' });
    return;
  }

  const config = getRepoConfig();
  const repoPath = config.repos[repoName];
  if (!repoPath) {
    const available = Object.keys(config.repos).join(', ');
    res.status(404).json({ error: `Unknown repo "${repoName}". Available: ${available}` });
    return;
  }

  if (!clientId || typeof clientId !== 'string') {
    res.status(400).json({ error: 'clientId is required' });
    return;
  }

  const session = registry.get(clientId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Idempotent: return existing worktree if already open for this repo
  const existing = session.worktreePaths.get(repoName);
  if (existing) {
    res.json({ path: existing.path, repoName, created: false });
    return;
  }

  // Create a new worktree for this repo using a unique ID
  const wtId = `wt-${Date.now().toString(36)}`;
  try {
    const worktreePath = createWorktree(wtId, repoPath);
    session.worktreePaths.set(repoName, { path: worktreePath, wtId });

    // Persist to event store for replay on reattach. Include sessionId
    // for v2 client demuxing — the client needs to know which session
    // this worktree belongs to.
    const event = {
      v: 2,
      type: 'worktree_opened',
      ts: Date.now(),
      repoName,
      path: worktreePath,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    };
    let seq: number | undefined;
    if (session.sessionId) {
      seq = eventStore.append(session.sessionId, 'worktree_opened', event);
    }

    // Notify the frontend
    if (session.transport.isOpen()) {
      session.transport.send({ ...event, ...(seq != null ? { seq } : {}) });
    }

    log.info('opened repo worktree', { repoName, worktreePath, clientId });
    res.json({ path: worktreePath, repoName, created: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('failed to create repo worktree', { repoName, error: message });
    res.status(500).json({ error: `Failed to create worktree: ${message}` });
  }
});

app.post('/api/sessions', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }

  const { source } = req.body || {};
  if (!source || typeof source !== 'string') {
    res.status(400).json({ error: 'source is required (cursor | claude | mitzo)' });
    return;
  }

  const wtId = generateWtId();
  const config = getRepoConfig();

  try {
    const worktrees = createAllWorktrees(wtId, BASE_REPO, config.repos, {
      prefix: source === 'cursor' ? '.cursor' : '.claude',
    });

    log.info('session worktrees created', {
      sessionId: wtId,
      source,
      repos: Object.keys(worktrees),
    });

    res.json({ sessionId: wtId, worktrees });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('session creation failed', { source, error: message });
    res.status(500).json({ error: `Session creation failed: ${message}` });
  }
});

app.use('/api', authMiddleware);

// --- Task Board API ---

app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: taskStore.getTree() });
});

app.post('/api/tasks', (req, res) => {
  const body = TaskCreateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  try {
    const task = taskStore.create(body.data);
    res.status(201).json({ task });
    // Broadcast full tree so child tasks appear correctly in all clients
    onTaskBroadcast?.({ type: 'task_state', tasks: taskStore.getTree() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/tasks/:id', (req, res) => {
  const task = taskStore.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ task });
});

app.patch('/api/tasks/:id', (req, res) => {
  const body = TaskUpdateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const task = taskStore.update(req.params.id, body.data);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ task });
  onTaskBroadcast?.({ type: 'task_updated', task });
});

app.delete('/api/tasks/:id', (req, res) => {
  const ok = taskStore.delete(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true });
  onTaskBroadcast?.({ type: 'task_deleted', taskId: req.params.id });
});

// --- Internal task-tool endpoints (MCP server callback) ---

function resolveTaskContext(req: express.Request): string | null {
  const clientId = req.headers['x-client-id'] as string | undefined;
  if (!clientId) return null;
  const session = registry.get(clientId);
  return session?.taskContext?.currentTaskId ?? null;
}

app.post('/api/internal/task-tools/set', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskSet(taskStore, taskId, req.body.tasks ?? []);
  res.json({ result });
  onTaskBroadcast?.({
    type: 'task_state',
    tasks: taskStore.getTree(),
  });
});

app.post('/api/internal/task-tools/complete', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskComplete(taskStore, taskId, req.body.summary ?? '');
  res.json({ result });
  onTaskBroadcast?.({
    type: 'task_state',
    tasks: taskStore.getTree(),
  });
});

app.get('/api/internal/task-tools/status', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskStatus(taskStore, taskId);
  res.json({ result });
});

app.post('/api/internal/task-tools/block', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskBlock(taskStore, taskId, req.body.reason ?? '');
  res.json({ result });
  onTaskBroadcast?.({
    type: 'task_state',
    tasks: taskStore.getTree(),
  });
});

// --- Loop orchestrator API ---

app.get('/api/loop/status', (req, res) => {
  if (!orchestrator) {
    res.json({
      state: 'idle',
      goalId: null,
      activeTaskId: null,
      progress: null,
      specMode: false,
      awaitingApproval: false,
    });
    return;
  }
  res.json(orchestrator.getStatus());
});

app.post('/api/loop/start', (req, res) => {
  const body = LoopStartBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'goalId is required' });
    return;
  }
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  const status = orchestrator.getStatus();
  if (status.state === 'running') {
    res.status(409).json({ error: 'Loop already running' });
    return;
  }
  const result = orchestrator.start(body.data.goalId, {
    specMode: body.data.specMode,
  });
  res.json(result);
});

app.post('/api/loop/pause', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.pause());
});

app.post('/api/loop/resume', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.resume());
});

app.post('/api/loop/stop', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.stop());
});

app.post('/api/tasks/:id/approve', (req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  const ok = orchestrator.approveTask(req.params.id);
  if (!ok) {
    res.status(400).json({ error: 'Task not in pending_review state' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/tasks/:id/reject', (req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  const ok = orchestrator.rejectTask(req.params.id, req.body.feedback ?? '');
  if (!ok) {
    res.status(400).json({ error: 'Task not in pending_review state' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/loop/spec/approve', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.approveSpec());
});

app.post('/api/loop/spec/reject', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.rejectSpec());
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'passphrase is required' });
    return;
  }
  const token = await login(body.data.passphrase);
  if (!token) {
    res.status(401).json({ error: 'Invalid passphrase' });
    return;
  }
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: MAX_AGE_HOURS * 60 * 60 * 1000,
  });
  res.json({ ok: true, token });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/auth/check', (_req, res) => res.json({ ok: true }));

app.get('/api/models', (_req, res) => res.json(AVAILABLE_MODELS));

app.get('/api/config', (_req, res) => {
  const config = getRepoConfig();
  const actions = config.quickActions.map((a) => ({
    ...a,
    cwd: a.cwd ? join(BASE_REPO, a.cwd) : undefined,
  }));
  const contextBlocks: Record<string, { path: string; sizeBytes: number }> = {};
  for (const [name, path] of Object.entries(config.contextBlocks)) {
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(path).size;
    } catch {
      // File may not exist yet — show 0 size
    }
    contextBlocks[name] = { path, sizeBytes };
  }
  const fileViewerRoots =
    config.roots.length > 0 ? config.roots : [{ label: 'Root', path: BASE_REPO }];
  res.json({
    repoPath: BASE_REPO,
    mcpServers: getMcpServerNames(),
    quickActions: actions,
    contextBlocks,
    fileViewerRoots,
  });
});

app.get('/api/skills', (req, res) => {
  const cwd = (req.query.cwd as string) || BASE_REPO;
  if (cwd && !isAllowedPath(cwd)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  const skillRegistry = buildSkillRegistry(cwd);
  res.json(skillRegistry.listPublic());
});

app.get('/api/sessions/active', (_req, res) => {
  res.json(registry.getActiveSessions());
});

app.get('/api/sessions', (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 20), 100);
  const full = req.query.full === '1';

  // Fast path: serve from EventStore (SQLite, <1ms) unless ?full=1
  if (!full) {
    const { sessions, hasMore } = getSessionsCached(offset, limit);
    const activeMap = new Map<string, { attached: boolean }>();
    for (const s of registry.getActiveSessions()) {
      if (s.sessionId) activeMap.set(s.sessionId, { attached: s.attached });
    }
    const annotated = sessions.map((s) => {
      const live = activeMap.get(s.id);
      const meta = eventStore.getSession(s.id);
      return {
        ...s,
        isActive: !!live,
        isAttached: live?.attached ?? false,
        totalTokens: meta
          ? meta.inputTokens + meta.outputTokens + meta.cacheReadTokens + meta.cacheCreationTokens
          : undefined,
        numTurns: meta?.numTurns,
      };
    });
    res.json({ sessions: annotated, hasMore });

    // Background: reconcile with filesystem so EventStore stays fresh
    if (offset === 0) reconcileSessionsBackground();
    return;
  }

  // Full path: filesystem scan (original behavior, for ?full=1)
  getSessions(offset, limit).then(({ sessions, hasMore }) => {
    const activeMap = new Map<string, { attached: boolean }>();
    for (const s of registry.getActiveSessions()) {
      if (s.sessionId) activeMap.set(s.sessionId, { attached: s.attached });
    }
    const annotated = sessions.map((s) => {
      const live = activeMap.get(s.id);
      const meta = eventStore.getSession(s.id);
      return {
        ...s,
        isActive: !!live,
        isAttached: live?.attached ?? false,
        totalTokens: meta
          ? meta.inputTokens + meta.outputTokens + meta.cacheReadTokens + meta.cacheCreationTokens
          : undefined,
        numTurns: meta?.numTurns,
      };
    });
    res.json({ sessions: annotated, hasMore });
  });
});

app.get('/api/sessions/:id/messages', async (req, res) => {
  res.json(await getMessages(req.params.id as string));
});

app.delete('/api/sessions/:id', (req, res) => {
  hideSession(req.params.id as string);
  res.json({ ok: true });
});

app.get('/api/sessions/:id/meta', (req, res) => {
  const meta = eventStore.getSession(req.params.id);
  if (!meta) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const totalTokens =
    meta.inputTokens + meta.outputTokens + meta.cacheReadTokens + meta.cacheCreationTokens;
  res.json({
    sessionId: meta.sessionId,
    branch: meta.branch,
    wtId: meta.wtId,
    cwd: meta.cwd,
    mode: meta.mode,
    isActive: meta.isActive,
    totalTokens,
    totalCostUsd: meta.totalCostUsd,
    numTurns: meta.numTurns,
  });
});

app.get('/api/sessions/:id/events', (req, res) => {
  const afterSeq = parseInt(req.query.after as string, 10);
  if (isNaN(afterSeq)) {
    res.status(400).json({ error: 'after query parameter is required (number)' });
    return;
  }
  const events = eventStore.getEventsAfter(req.params.id, afterSeq);
  res.json(events.map((e) => ({ ...e.payload, seq: e.seq })));
});

app.delete('/api/sessions', (_req, res) => {
  clearHiddenSessions();
  res.json({ ok: true });
});

app.put('/api/sessions/:id/rename', async (req, res) => {
  const { title } = req.body || {};
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  try {
    await renameSessionById(req.params.id, title.slice(0, 200));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.get('/api/worktrees', (_req, res) => {
  const worktrees = listWorktrees(BASE_REPO).map((wt) => ({ ...wt, repo: 'primary' }));
  for (const [name, repoPath] of Object.entries(getRepoConfig().repos)) {
    try {
      const repoWts = listWorktrees(repoPath).map((wt) => ({ ...wt, repo: name }));
      worktrees.push(...repoWts);
    } catch {
      // Repo path may not exist yet
    }
  }
  res.json(worktrees);
});

// --- File viewer API ---

export function isAllowedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  if (BASE_REPO && resolved.startsWith(resolve(BASE_REPO))) return true;
  if (BASE_REPO && resolved.startsWith(resolve(`${BASE_REPO}-sessions`))) return true;
  const config = getRepoConfig();
  for (const repoPath of Object.values(config.repos)) {
    if (resolved.startsWith(resolve(repoPath))) return true;
    if (resolved.startsWith(resolve(`${repoPath}-sessions`))) return true;
  }
  for (const extra of config.allowedPaths) {
    if (resolved.startsWith(resolve(extra))) return true;
  }
  return false;
}

function resolveRoot(queryRoot: string | undefined): string {
  if (!queryRoot) return BASE_REPO;
  const resolved = resolve(queryRoot);
  if (!isAllowedPath(resolved)) return BASE_REPO;
  return resolved;
}

function getGitBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: 'pipe',
      timeout: GIT_BRANCH_TIMEOUT_MS,
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

app.get('/api/git/info', (_req, res) => {
  const branch = getGitBranch(BASE_REPO);
  const worktrees = listWorktrees(BASE_REPO).map((wt) => ({
    ...wt,
    branch: getGitBranch(wt.path),
    repo: 'primary',
  }));
  for (const [name, repoPath] of Object.entries(getRepoConfig().repos)) {
    try {
      const repoWts = listWorktrees(repoPath).map((wt) => ({
        ...wt,
        branch: getGitBranch(wt.path),
        repo: name,
      }));
      worktrees.push(...repoWts);
    } catch {
      // Repo path may not exist yet
    }
  }
  res.json({ branch, repoPath: BASE_REPO, worktrees });
});

app.get('/api/files/roots', (_req, res) => {
  res.json(getRepoConfig().roots);
});

app.get('/api/files/list', (req, res) => {
  const root = resolveRoot(req.query.root as string | undefined);
  const dir = (req.query.dir as string) || root;
  if (!dir || !isAllowedPath(dir)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(dir)) {
    res.status(404).json({ error: 'Directory not found' });
    return;
  }
  try {
    const entries = readdirSync(dir)
      .filter((name) => !name.startsWith('.'))
      .map((name) => {
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          return { name, isDir: stat.isDirectory() };
        } catch {
          return { name, isDir: false };
        }
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ currentDir: dir, entries });
  } catch (err: unknown) {
    log.error('failed to read directory', {
      dir,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

app.get('/api/files', (req, res) => {
  const root = resolveRoot(req.query.root as string | undefined);
  const dir = (req.query.dir as string) || root;
  if (!dir || !isAllowedPath(dir)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(dir)) {
    res.status(404).json({ error: 'Directory not found' });
    return;
  }
  try {
    const entries = readdirSync(dir)
      .filter((name) => !name.startsWith('.'))
      .map((name) => {
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          return { name, isDir: stat.isDirectory() };
        } catch {
          return { name, isDir: false };
        }
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ dir, entries });
  } catch (err: unknown) {
    log.error('failed to read directory', {
      dir,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

app.get('/api/files/read', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !isAllowedPath(filePath)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    const ext = extname(filePath).toLowerCase();
    res.json({ path: filePath, content, ext });
  } catch (err: unknown) {
    log.error('failed to read file', {
      path: filePath,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({ error: 'Failed to read file' });
  }
});

app.put('/api/files/write', (req, res) => {
  const body = FileWriteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'path and content are required' });
    return;
  }
  const { path: filePath, content } = body.data;
  if (!isAllowedPath(filePath)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  try {
    writeFileSync(filePath, content, 'utf-8');
    res.json({ ok: true, path: filePath });
  } catch (err: unknown) {
    log.error('failed to write file', {
      path: filePath,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({ error: 'Failed to write file' });
  }
});

// --- Inbox API ---

app.get('/api/inbox', (_req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.json([]);
    return;
  }
  res.json(listInboxItems(inboxPath));
});

app.post('/api/inbox', (req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.status(404).json({ error: 'Inbox not configured' });
    return;
  }
  const { source, title, body, tags } = req.body || {};
  if (!title || typeof title !== 'string' || !body || typeof body !== 'string') {
    res.status(400).json({ error: 'title and body are required strings' });
    return;
  }
  const item = createInboxItem(inboxPath, {
    source: typeof source === 'string' ? source : 'chat',
    title,
    body,
    tags: Array.isArray(tags) ? tags : undefined,
  });
  if (!item) {
    res.status(500).json({ error: 'Failed to create inbox item' });
    return;
  }
  res.status(201).json(item);
  broadcastInboxUpdate();
});

app.get('/api/inbox/:filename', (req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.status(404).json({ error: 'Inbox not configured' });
    return;
  }
  const content = readInboxItem(inboxPath, req.params.filename);
  if (content === null) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ content });
});

app.post('/api/inbox/:filename/approve', (req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.status(404).json({ error: 'Inbox not configured' });
    return;
  }
  const ok = approveInboxItem(inboxPath, req.params.filename);
  if (!ok) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ ok: true });
  broadcastInboxUpdate();
});

app.delete('/api/inbox/:filename', (req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.status(404).json({ error: 'Inbox not configured' });
    return;
  }
  const ok = discardInboxItem(inboxPath, req.params.filename);
  if (!ok) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ ok: true });
  broadcastInboxUpdate();
});

// --- Push notification device token registration ---

app.post('/api/push/register', (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  registerToken(token);
  res.json({ ok: true });
});

app.delete('/api/push/register', (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  removeToken(token);
  res.json({ ok: true });
});

// --- Calendar API ---

const execFileAsync = promisify(execFile);
const CALENDAR_SCRIPT = join(BASE_REPO, 'command_center', 'calendar_api.py');
const CALENDAR_TIMEOUT_MS = 20_000;

app.get('/api/calendar', async (req, res) => {
  const dateParam = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  const daysParam = Math.max(1, Math.min(31, parseInt(req.query.days as string) || 7));

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam) || isNaN(Date.parse(dateParam))) {
    res.status(400).json({ error: 'Invalid date format — use YYYY-MM-DD' });
    return;
  }

  const emptyResponse = (error: string) => {
    const endDate = new Date(dateParam);
    endDate.setDate(endDate.getDate() + daysParam - 1);
    return {
      startDate: dateParam,
      endDate: endDate.toISOString().slice(0, 10),
      events: [],
      sprints: [],
      error,
    };
  };

  // calendar_api.py lives in the mgmt repo (REPO_PATH), not in Mitzo
  if (!existsSync(CALENDAR_SCRIPT)) {
    log.warn('calendar script not found', { path: CALENDAR_SCRIPT });
    res.json(emptyResponse(`Calendar script not found at ${CALENDAR_SCRIPT}`));
    return;
  }

  try {
    const { stdout } = await execFileAsync(
      'python3',
      [CALENDAR_SCRIPT, '--date', dateParam, '--days', String(daysParam)],
      { timeout: CALENDAR_TIMEOUT_MS },
    );
    const parsed = CalendarResponse.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      log.warn('calendar API returned unexpected shape', { error: parsed.error.message });
      res.json(emptyResponse('Calendar data failed validation'));
      return;
    }
    res.json(parsed.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.warn('calendar API failed', { error: message });
    res.json(emptyResponse(message));
  }
});

// --- Todo API ---

const TODO_SCRIPT = join(BASE_REPO, 'command_center', 'todo_api.py');
const TODO_TIMEOUT_MS = 30_000;

app.get('/api/todos', async (req, res) => {
  const profile = req.query.profile as string | undefined;
  const refresh = req.query.refresh === 'true';

  if (!existsSync(TODO_SCRIPT)) {
    log.warn('todo script not found', { path: TODO_SCRIPT });
    res.json({ profiles: [], items: [] });
    return;
  }

  try {
    const args = [TODO_SCRIPT];
    if (refresh && profile) {
      args.push('--refresh', '--profile', profile);
    } else {
      args.push('--list');
      if (profile) args.push('--profile', profile);
    }

    const { stdout } = await execFileAsync('python3', args, {
      timeout: TODO_TIMEOUT_MS,
    });
    const parsed = TodoListResponse.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      log.warn('todo API returned unexpected shape', { error: parsed.error.message });
      res.json({ profiles: [], items: [] });
      return;
    }
    res.json(parsed.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.warn('todo API failed', { error: message });
    res.json({ profiles: [], items: [] });
  }
});

app.post('/api/todos', async (req, res) => {
  const body = TodoCreateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false, error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const { summary, profile, parentId } = body.data;

  if (!existsSync(TODO_SCRIPT)) {
    res.status(500).json({ ok: false, error: 'Todo script not found' });
    return;
  }

  try {
    const args = [TODO_SCRIPT, '--create', summary, '--profile', profile];
    if (parentId) {
      args.push('--parent', parentId);
    }

    const { stdout } = await execFileAsync('python3', args, {
      timeout: TODO_TIMEOUT_MS,
    });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      res.status(400).json(parsed);
      return;
    }
    res.status(201).json(parsed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.warn('todo create failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/todos/:id/action', async (req, res) => {
  const { id } = req.params;

  const body = TodoActionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false, error: 'Invalid action body' });
    return;
  }

  if (!existsSync(TODO_SCRIPT)) {
    res.status(500).json({ ok: false, error: 'Todo script not found' });
    return;
  }

  try {
    const args = [TODO_SCRIPT, '--action', body.data.action, id];
    if (body.data.action === 'snooze' && body.data.days) {
      args.push(String(body.data.days));
    }

    const { stdout } = await execFileAsync('python3', args, {
      timeout: TODO_TIMEOUT_MS,
    });
    const parsed = TodoActionResponse.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      res.status(500).json({ ok: false, error: 'Unexpected response' });
      return;
    }
    if (!parsed.data.ok) {
      res.status(404).json(parsed.data);
      return;
    }
    res.json(parsed.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.warn('todo action failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// --- Static files ---

const frontendDist = join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api') || _req.path.startsWith('/ws')) return next();
  res.sendFile(join(frontendDist, 'index.html'), (err) => {
    if (err) next();
  });
});

export { app };
