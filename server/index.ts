import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { login, authMiddleware, verifyWsAuth, COOKIE_NAME, MAX_AGE_HOURS } from './auth.js';
import {
  startChat,
  stopChat,
  isActive,
  getSessions,
  getMessages,
  AVAILABLE_MODELS,
  BASE_REPO,
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
app.get('/api/config', (_req, res) => res.json({ repoPath: BASE_REPO }));

// Session routes
app.get('/api/sessions', async (_req, res) => {
  res.json(await getSessions());
});

app.get('/api/sessions/:id/messages', async (req, res) => {
  res.json(await getMessages(req.params.id as string));
});

app.get('/api/worktrees', (_req, res) => {
  res.json(listWorktrees(BASE_REPO));
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
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

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
        });
      } else if (msg.type === 'stop') {
        stopChat(clientId);
      }
      // permission_response is handled inside startChat's message handler
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[ws] chat disconnected:', clientId);
    stopChat(clientId);
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
