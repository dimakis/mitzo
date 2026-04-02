import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, extname } from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { login, authMiddleware, verifyWsAuth, COOKIE_NAME, MAX_AGE_HOURS } from './auth.js';
import {
  startChat,
  stopChat,
  detachChat,
  reattachChat,
  isActive,
  getSessions,
  getMessages,
  hideSession,
  clearHiddenSessions,
  AVAILABLE_MODELS,
  BASE_REPO,
  getMcpServerNames,
  registry,
  repoConfig,
} from './chat.js';
import { cleanupStaleWorktrees, listWorktrees } from './worktree.js';
import { GIT_BRANCH_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, PORT_DEFAULT } from './constants.js';
import { getLocalCommit, isUpdateAvailable } from './git-version.js';
import { createLogger } from './logger.js';

const log = createLogger('server');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || String(PORT_DEFAULT), 10);

const app = express();
app.use(express.json());
app.use(cookieParser());

// Version (no auth)
const indexHtmlPath = join(__dirname, '..', 'frontend', 'dist', 'index.html');
let buildHash = '';
try {
  buildHash = createHash('md5').update(readFileSync(indexHtmlPath)).digest('hex').slice(0, 8);
} catch {
  // Expected when frontend hasn't been built yet
}

const startupCommit = getLocalCommit();
let updateAvailable = false;

function broadcastUpdateAvailable() {
  const msg = JSON.stringify({ type: 'update_available' });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
}

function runUpdateCheck() {
  const wasAvailable = updateAvailable;
  updateAvailable = isUpdateAvailable();
  if (updateAvailable && !wasAvailable) {
    log.info('update available — broadcasting to clients');
    broadcastUpdateAvailable();
  }
}

app.get('/api/version', (_req, res) =>
  res.json({ hash: buildHash, commit: startupCommit, updateAvailable }),
);

app.post('/api/version/check', authMiddleware, (_req, res) => {
  runUpdateCheck();
  res.json({ updateAvailable });
});

// Token-auth endpoint for ntfy action buttons (before cookie auth middleware)
import { resolvePending } from './permissions.js';

app.post('/api/permission/:permId/respond', (req, res) => {
  const token = req.query.token as string;
  const ntfyToken = process.env.NTFY_AUTH_TOKEN;
  if (!token || !ntfyToken || token !== ntfyToken) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const decision = (req.query.decision || req.body?.decision || 'deny') as string;
  if (!['once', 'always', 'deny'].includes(decision)) {
    res.status(400).json({ error: 'Invalid decision' });
    return;
  }

  const ok = resolvePending(req.params.permId as string, decision as any);
  if (!ok) {
    res.status(404).json({ error: 'Permission request not found or already resolved' });
    return;
  }

  res.json({ ok: true, decision });
});

// Auth middleware
app.use('/api', authMiddleware);

// Auth routes
app.post('/api/auth/login', async (req, res) => {
  const { passphrase } = req.body;
  const token = await login(passphrase);
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

// Models
app.get('/api/models', (_req, res) => res.json(AVAILABLE_MODELS));

// Config (exposes non-sensitive settings to frontend)
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

// Session routes
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

app.get('/api/worktrees', (_req, res) => {
  res.json(listWorktrees(BASE_REPO));
});

// File viewer API — restricted to REPO_PATH and its worktrees
function isAllowedPath(filePath: string): boolean {
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
          return { name, isDir: false }; // Broken symlink or permission error — show as file
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
  const { path: filePath, content } = req.body as { path?: string; content?: string };
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content are required' });
    return;
  }
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

// Static files
const frontendDist = join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api') || _req.path.startsWith('/ws')) return next();
  res.sendFile(join(frontendDist, 'index.html'), (err) => {
    if (err) next();
  });
});

// WebSocket for chat
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/ws/chat')) {
    socket.destroy();
    return;
  }

  const authed = await verifyWsAuth(req.headers.cookie);
  if (!authed) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log.info('chat connected', { clientId });
    handleChatWs(ws, clientId);
  });
});

function handleChatWs(ws: WebSocket, initialClientId: string) {
  let clientId = initialClientId;
  ws.send(JSON.stringify({ type: 'client_id', clientId }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'reattach' && msg.clientId) {
        const oldClientId = msg.clientId as string;
        const ok = reattachChat(oldClientId, ws);
        if (ok) {
          // Adopt the old clientId so isActive/stop/detach target the
          // same registry key the running query loop uses.
          clientId = oldClientId;
          const session = registry.get(clientId);
          ws.send(
            JSON.stringify({
              type: 'reattached',
              clientId: oldClientId,
              sessionId: session?.sessionId,
              running: true,
            }),
          );
          log.info('reattached', { oldClientId, newClientId: initialClientId });
        } else {
          ws.send(
            JSON.stringify({
              type: 'reattach_failed',
              clientId: oldClientId,
              reason: 'Session not found or already finished',
            }),
          );
        }
        return;
      }

      if (msg.type === 'send' && msg.prompt) {
        if (isActive(clientId)) {
          ws.send(
            JSON.stringify({
              type: 'error',
              error: 'A query is already running. Wait for it to finish or stop it.',
            }),
          );
          return;
        }
        startChat(ws, clientId, msg.prompt, {
          resume: msg.resume,
          cwd: msg.cwd,
          model: msg.model,
          extraTools: msg.extraTools,
          mode: msg.mode,
          worktree: msg.worktree,
          images: msg.images,
        });
      } else if (msg.type === 'stop') {
        stopChat(clientId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.warn('failed to handle WS message', { clientId, error: message });
      ws.send(JSON.stringify({ type: 'error', error: message }));
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    log.info('chat disconnected', { clientId, code, reason: reason?.toString() });
    if (isActive(clientId)) {
      detachChat(clientId);
      log.info('session detached (surviving)', { clientId });
    }
  });

  ws.on('error', (err) => {
    log.error('ws error', { clientId, error: err.message });
  });
}

import { checkPort } from './port-check.js';

checkPort(PORT).then((inUse) => {
  if (inUse) {
    log.error(`Port ${PORT} already in use. Another Mitzo instance may be running.`);
    log.error('Kill it or set a different PORT in .env.');
    process.exit(1);
  }

  server.listen(PORT, () => {
    log.info(`Chat Agent running on http://localhost:${PORT}`);
    try {
      cleanupStaleWorktrees(BASE_REPO);
    } catch (err: unknown) {
      log.warn('stale worktree cleanup failed (will retry on next restart)', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }

    // Periodic update check every 2 minutes
    const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
    setInterval(runUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
  });
});
