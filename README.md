# Mitzo

A mobile-first web interface for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk). Run it on a home server, access it from your phone over [Tailscale](https://tailscale.com).

## What It Does

- **Chat with Claude** from any device — streaming responses, markdown rendering, tool call visibility
- **Image attachments** — send photos from your phone camera or gallery for Claude to analyze
- **Permission control** — Ask (read-only), Agent (approve tools), Auto (full autonomy), switchable mid-chat
- **File browser** — browse repo directories and read markdown files rendered in the UI
- **Quick actions** — preconfigured one-tap commands (run scripts, fetch data, triage inbox)
- **Push notifications** — get notified via [ntfy](https://ntfy.sh) when Claude needs input
- **Session history** — resume past conversations, with client-side persistence across page refreshes
- **Model selection** — switch between Sonnet, Opus, and Haiku per conversation
- **Smart tool display** — tool calls shown as compact pills, auto-grouped when 3+ fire in sequence

## Architecture

```
Phone (over Tailscale)
  │
  ├── HTTP: REST API (Express)
  └── WebSocket: streaming chat
  │
Server (Node.js + TypeScript)
  │
  ├── Agent SDK: Claude Code sessions
  ├── File viewer API
  └── Passphrase + JWT auth
```

**Backend** (`server/`) — Express + TypeScript, run via `tsx`

| File             | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `index.ts`       | Express app, routes, WebSocket server, file viewer API              |
| `chat.ts`        | Agent SDK `query()` integration, permission handling, image support |
| `worktree.ts`    | Git worktree create/remove/cleanup (opt-in)                         |
| `permissions.ts` | Permission request registry, SDK suggestion passthrough             |
| `notify.ts`      | ntfy push notifications                                             |
| `auth.ts`        | Passphrase login, JWT (HS256), cookie auth                          |

**Frontend** (`frontend/`) — React 19 + Vite + TypeScript

| Page          | Purpose                                                          |
| ------------- | ---------------------------------------------------------------- |
| `Login`       | Passphrase entry                                                 |
| `SessionList` | Quick action grid + session history                              |
| `ChatView`    | Streaming chat, mode pills, image attachments, permission banner |
| `FileViewer`  | Repo file browser with markdown rendering                        |

## Prerequisites

- **Node.js** 20+
- **Claude Code** CLI installed and authenticated
- **Tailscale** (for remote access)

## Setup

```bash
git clone https://github.com/dimakis/mitzo.git
cd mitzo

npm install
cd frontend && npm install && cd ..

cp .env.example .env
# Edit .env — set AUTH_PASSPHRASE, AUTH_SECRET, and REPO_PATH
```

### Environment variables

| Variable               | Description                        | Required |
| ---------------------- | ---------------------------------- | -------- |
| `AUTH_PASSPHRASE`      | Login passphrase                   | Yes      |
| `AUTH_SECRET`          | JWT signing key (min 32 chars)     | Yes      |
| `REPO_PATH`            | Default repo for chat sessions     | Yes      |
| `PORT`                 | Server port (default: `3100`)      | No       |
| `COOKIE_MAX_AGE_HOURS` | Auth cookie expiry (default: `24`) | No       |

See `.env.example` for the full list including ntfy and Vertex AI options.

## Running

### Development

```bash
npm run dev
# Backend: http://localhost:3100
# Frontend: http://localhost:5173 (proxies API to backend)
```

### Production

```bash
npm run build
npm start
# http://localhost:3100 (serves frontend + API)
```

### With pm2

```bash
pm2 start npm --name mitzo -- start
pm2 save && pm2 startup
```

## Accessing from your phone

1. Install [Tailscale](https://tailscale.com/download) on your server and phone
2. `tailscale up` on both
3. Open `http://<tailscale-ip>:3100` on your phone

No HTTPS needed — Tailscale encrypts everything via WireGuard.

## Push notifications

Get notified when Claude needs tool approval:

```bash
# Add ntfy config to .env:
NTFY_ENABLED=true
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=your-secret-topic
BASE_URL=http://<tailscale-ip>:3100

# Configure Claude Code hooks:
./scripts/setup-mcp.sh
./scripts/setup-hooks.sh
```

## Quality

- **ESLint** + **Prettier** for linting and formatting
- **Vitest** for tests
- **husky** + **lint-staged** for pre-commit hooks
- **commitlint** for conventional commit messages
- **GitHub Actions CI** — lint, typecheck, test, build on every PR
- **Branch protection** on main — CI must pass to merge

## Tech stack

| Component | Technology                   |
| --------- | ---------------------------- |
| Backend   | Node.js, Express, TypeScript |
| Frontend  | React 19, Vite, TypeScript   |
| AI        | Claude Agent SDK             |
| Auth      | JWT via jose                 |
| Tests     | Vitest                       |
| Lint      | ESLint 9, Prettier           |
| CI        | GitHub Actions               |

## Security

See [SECURITY.md](SECURITY.md) for the threat model, secrets handling, and known limitations.

## Attribution

Mitzo evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center) by [Afstkla](https://github.com/Afstkla). The original project used tmux for session management; Mitzo replaced that with the Claude Agent SDK for direct programmatic control.

## License

MIT
