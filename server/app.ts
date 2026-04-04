import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, extname } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { login, authMiddleware, COOKIE_NAME, MAX_AGE_HOURS } from './auth.js';
import {
  getSessions,
  getMessages,
  hideSession,
  clearHiddenSessions,
  renameSessionById,
  AVAILABLE_MODELS,
  BASE_REPO,
  getMcpServerNames,
  repoConfig,
} from './chat.js';
import { listWorktrees } from './worktree.js';
import { GIT_BRANCH_TIMEOUT_MS } from './constants.js';
import { getLocalCommit, isUpdateAvailable } from './git-version.js';
import { resolvePending } from './permissions.js';
import { createLogger } from './logger.js';
import { LoginBody, FileWriteBody, PermissionDecision } from './api-schemas.js';
import {
  listInboxItems,
  readInboxItem,
  approveInboxItem,
  discardInboxItem,
  createInboxItem,
} from './inbox.js';

const log = createLogger('server');

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export function setUpdateBroadcast(fn: () => void) {
  onUpdateAvailable = fn;
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

app.use('/api', authMiddleware);

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
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/auth/check', (_req, res) => res.json({ ok: true }));

app.get('/api/models', (_req, res) => res.json(AVAILABLE_MODELS));

app.get('/api/config', (_req, res) => {
  const actions = repoConfig.quickActions.map((a) => ({
    ...a,
    cwd: a.cwd ? join(BASE_REPO, a.cwd) : undefined,
  }));
  res.json({
    repoPath: BASE_REPO,
    mcpServers: getMcpServerNames(),
    quickActions: actions,
  });
});

app.get('/api/sessions', async (_req, res) => {
  res.json(await getSessions());
});

app.get('/api/sessions/:id/messages', async (req, res) => {
  res.json(await getMessages(req.params.id as string));
});

app.delete('/api/sessions/:id', (req, res) => {
  hideSession(req.params.id as string);
  res.json({ ok: true });
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
  res.json(listWorktrees(BASE_REPO));
});

// --- File viewer API ---

export function isAllowedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  if (BASE_REPO && resolved.startsWith(resolve(BASE_REPO))) return true;
  if (BASE_REPO && resolved.startsWith(resolve(`${BASE_REPO}-sessions`))) return true;
  for (const extra of repoConfig.allowedPaths) {
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
  }));
  res.json({ branch, repoPath: BASE_REPO, worktrees });
});

app.get('/api/files/roots', (_req, res) => {
  res.json(repoConfig.roots);
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
  const inboxPath = repoConfig.resolvedInboxPath;
  if (!inboxPath) {
    res.json([]);
    return;
  }
  res.json(listInboxItems(inboxPath));
});

app.post('/api/inbox', (req, res) => {
  const inboxPath = repoConfig.resolvedInboxPath;
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
});

app.get('/api/inbox/:filename', (req, res) => {
  const inboxPath = repoConfig.resolvedInboxPath;
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
  const inboxPath = repoConfig.resolvedInboxPath;
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
});

app.delete('/api/inbox/:filename', (req, res) => {
  const inboxPath = repoConfig.resolvedInboxPath;
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
