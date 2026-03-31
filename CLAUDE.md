# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (runs backend + frontend concurrently)
npm run dev
# Backend: http://localhost:3100
# Frontend: http://localhost:5173 (proxies /api and /ws to backend)

# Production build
npm run build        # Builds frontend into frontend/dist
npm start            # Serves built frontend + API from one process

# Backend only (with file watching)
npm run dev:server

# Frontend only
cd frontend && npx vite
```

Tests: `npm test` (vitest). No linters configured.

## Architecture

Web-based command center for Claude Code sessions via the Agent SDK. Two npm projects share one repo:

**Backend** (`server/`) — Node.js + Express + TypeScript, run via `tsx`
- `index.ts` — Express app, mounts routes, HTTP server + WebSocket. Runs stale worktree cleanup on startup.
- `chat.ts` — Agent SDK integration. Each chat session gets an isolated git worktree (see below). Manages permission handling, mode switching, and streaming.
- `worktree.ts` — Git worktree lifecycle: create, remove, cleanup stale, list.
- `permissions.ts` — Permission request/response registry. Passes SDK `suggestions` through for "Always Allow".
- `notify.ts` — ntfy push notifications for permission prompts.
- `auth.ts` — Passphrase login, JWT (HS256 via jose), cookie-based auth.

**Frontend** (`frontend/`) — React 19 + Vite + TypeScript
- Three pages: `Login`, `SessionList` (quick actions + history), `ChatView` (streaming chat)
- Auth check via `ProtectedRoute` wrapper that calls `/api/auth/check`
- Vite dev server proxies `/api` and `/ws` to backend (port 3100)

**Worktree isolation:**
- Each new chat session (without explicit `cwd` or `resume`) gets its own git worktree at `~/redhat/mgmt-sessions/session-<clientId>/`, branched from the current HEAD of `REPO_PATH`.
- The worktree is removed when the session ends (WebSocket close or stop).
- Stale worktrees older than 24h are cleaned up on server startup.
- Sessions with explicit `cwd` (e.g., quick actions targeting other repos) skip worktree creation.
- `GET /api/worktrees` lists active worktrees for debugging.

**Key conventions:**
- All server imports use `.js` extensions (required for ESM + tsx)
- Frontend and backend have separate `package.json`, `tsconfig.json`, and `node_modules`
- `REPO_PATH` env var controls the default repo (defaults to `/Users/dsaridak/redhat/mgmt`)

## Code Style

- Write minimal, clean code. This project is open source — others will read and contribute to it.
- No machine-specific paths or configuration. Everything must be generic and portable.
- Keep files short and focused. Prefer clarity over cleverness.
