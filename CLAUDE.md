# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Backend + frontend concurrently
npm run build        # Production build (frontend into frontend/dist)
npm start            # Serve built frontend + API from one process
npm run dev:server   # Backend only (with file watching)

npm run lint         # ESLint (server + frontend)
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier (write)
npm run format:check # Prettier (check only)
npm test             # Vitest
```

Pre-commit hooks (husky + lint-staged) run lint and format on staged files. Conventional commit messages enforced via commitlint. CI runs on all PRs via GitHub Actions.

## Architecture

Mobile-first web interface for Claude Code via the Agent SDK. Two npm projects share one repo:

**Backend** (`server/`) — Node.js + Express + TypeScript, run via `tsx`

- `index.ts` — Express app, routes, HTTP server + WebSocket, file viewer API
- `chat.ts` — Agent SDK `query()` integration, permission handling, mode switching, image support
- `worktree.ts` — Git worktree lifecycle (create, remove, cleanup, list). Currently opt-in only.
- `permissions.ts` — Permission request/response registry. Passes SDK `suggestions` through for "Always Allow".
- `notify.ts` — ntfy push notifications for permission prompts
- `auth.ts` — Passphrase login, JWT (HS256 via jose), cookie-based auth

**Frontend** (`frontend/`) — React 19 + Vite + TypeScript

- `pages/Login` — Passphrase entry
- `pages/SessionList` — Quick action grid (dynamic from `/api/config`) + session history
- `pages/ChatView` — Streaming chat, mode pills (Ask/Agent/Auto), permission banner, image attachments, auto-reconnecting WebSocket, sessionStorage persistence
- `pages/FileViewer` — Repo file browser with markdown rendering
- `components/ToolPill` — Compact single-line tool call display
- `components/ToolGroup` — Auto-groups 3+ consecutive tool calls
- `components/MessageBubble` — User/assistant message rendering with markdown
- `components/ChatInput` — Text input with image attachment (camera/gallery), preview strip
- `components/PermissionBanner` — Slide-up approval UI for tool permissions

**API endpoints:**

- `POST /api/auth/login` — passphrase auth, returns JWT cookie
- `GET /api/auth/check` — verify auth
- `GET /api/sessions` — list past sessions from Agent SDK
- `GET /api/sessions/:id/messages` — session message history
- `GET /api/config` — non-sensitive config (repoPath)
- `GET /api/files?dir=` — directory listing (restricted to REPO_PATH)
- `GET /api/files/read?path=` — file content (restricted to REPO_PATH)
- `GET /api/worktrees` — list active worktrees (debug)
- `GET /api/models` — available model list
- `WS /ws/chat` — streaming chat via Agent SDK

**Known issue — session stability:**

The session lifecycle needs stabilization. See `.cursor/plans/mitzo_session_stabilization_*.plan.md` for the TDD plan. The core issue: worktree-per-session creates cwd mismatches that break Agent SDK session resume. The fix: simplify to use BASE_REPO as cwd for all sessions, make worktrees opt-in.

**Key conventions:**

- All server imports use `.js` extensions (required for ESM + tsx)
- Frontend and backend have separate `package.json`, `tsconfig.json`, and `node_modules`
- `REPO_PATH` env var controls the default repo (required — set in `.env`)
- No hardcoded machine-specific paths in source code
- Feature branches + PRs to main. Branch protection requires CI to pass.

## Code Style

- Write minimal, clean code. This project is open source — others will read and contribute to it.
- No machine-specific paths or configuration. Everything must be generic and portable.
- Keep files short and focused. Prefer clarity over cleverness.
- **Test-driven for session lifecycle.** Write tests before fixing session bugs.
