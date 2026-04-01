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
} from './chat.js';
import { cleanupStaleWorktrees, listWorktrees } from './worktree.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3100', 10);

const app = express();
app.use(express.json());
app.use(cookieParser());

// Version (no auth)
const indexHtmlPath = join(__dirname, '..', 'frontend', 'dist', 'index.html');
let buildHash = '';
try {
  buildHash = createHash('md5').update(readFileSync(indexHtmlPath)).digest('hex').slice(0, 8);
} catch {
  // Frontend not built yet — hash stays empty
}
app.get('/api/version', (_req, res) => res.json({ hash: buildHash }));

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
app.get('/api/config', (_req, res) =>
  res.json({ repoPath: BASE_REPO, mcpServers: getMcpServerNames() }),
);

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
      timeout: 5_000,
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
          return { name, isDir: false };
        }
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ dir, entries });
  } catch {
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
  } catch {
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
  } catch {
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
    console.log('[ws] chat connected:', clientId);
    handleChatWs(ws, clientId);
  });
});

function handleChatWs(ws: WebSocket, clientId: string) {
  ws.send(JSON.stringify({ type: 'client_id', clientId }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 15_000);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'reattach' && msg.clientId) {
        const ok = reattachChat(msg.clientId, ws);
        if (ok) {
          const session = registry.get(msg.clientId);
          ws.send(
            JSON.stringify({
              type: 'reattached',
              clientId: msg.clientId,
              sessionId: session?.sessionId,
              running: true,
            }),
          );
          console.log('[ws] reattached:', msg.clientId, '(new ws:', clientId, ')');
        } else {
          ws.send(
            JSON.stringify({
              type: 'reattach_failed',
              clientId: msg.clientId,
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
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    console.log('[ws] chat disconnected:', clientId, 'code:', code, 'reason:', reason?.toString());
    if (isActive(clientId)) {
      detachChat(clientId);
      console.log('[ws] session detached (surviving):', clientId);
    }
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', clientId, err.message);
  });
}

server.listen(PORT, () => {
  console.log(`Chat Agent running on http://localhost:${PORT}`);
  try {
    cleanupStaleWorktrees(BASE_REPO);
  } catch {
    // Non-fatal — stale worktrees will be cleaned next restart
  }
});
