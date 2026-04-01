# Mitzo

A mobile-first web interface for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk). Run it on a home server, access it from your phone over [Tailscale](https://tailscale.com).

## What It Does

- **Chat with Claude** from any device — streaming responses, tool calls, markdown rendering
- **Tiered permission control** — Tools classified by risk (safe/standard/elevated/unknown). Ask mode is read-only, Agent auto-allows file edits but prompts for shell access, Auto adds shell. Rich SDK context (title, description, tier badge) in permission prompts. Switchable mid-chat.
- **MCP tool integration** — reads MCP server configs from `~/.cursor/mcp.json` and passes them to Claude sessions (Jira, GitLab, etc.)
- **File browser** — browse repo files, view markdown with full rendering, edit markdown files in-browser, switch between worktree roots, branch indicator
- **Sandbox mode** — opt-in git worktree isolation per session, visible in the header
- **Session resilience** — WebSocket disconnects don't kill sessions; auto-reattach on reconnect
- **Quick actions** — preconfigured one-tap commands (run scripts, fetch data, triage inbox)
- **Push notifications** — get notified via [ntfy](https://ntfy.sh) when Claude needs input
- **Session history** — resume past conversations, deduplicated, swipe-to-dismiss
- **Model selection** — switch between Sonnet, Opus, and Haiku per conversation
- **Image attachments** — send photos/screenshots to Claude from your phone camera

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
  ├── MCP servers: loaded from Cursor config
  ├── Git worktrees: opt-in per-session isolation
  └── Passphrase + JWT auth
```

**Backend** (`server/`) — Express + TypeScript, run via `tsx`

| File                  | Purpose                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `index.ts`            | Express app, routes, WebSocket server, startup cleanup                              |
| `chat.ts`             | Agent SDK integration, session lifecycle, permission handling                       |
| `session-registry.ts` | Session lifecycle decoupled from WebSocket (detach/reattach)                        |
| `mcp-config.ts`       | Loads MCP server configs from Cursor mcp.json                                       |
| `worktree.ts`         | Git worktree create/remove/cleanup/list                                             |
| `tool-tiers.ts`       | Tool risk classification (safe/standard/elevated/unknown) and mode-aware auto-allow |
| `permissions.ts`      | Permission request registry, SDK suggestion passthrough                             |
| `notify.ts`           | ntfy push notifications                                                             |
| `auth.ts`             | Passphrase login, JWT (HS256), cookie auth                                          |
| `content-blocks.ts`   | SDK message content block parsing (shared between stream + API)                     |
| `tool-summary.ts`     | Human-readable tool input summarization                                             |

**Frontend** (`frontend/`) — React 19 + Vite + TypeScript

| Page          | Purpose                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `Login`       | Passphrase entry                                                               |
| `SessionList` | Quick action grid + session history (swipe-to-dismiss)                         |
| `ChatView`    | Streaming chat, mode pills, sandbox toggle, branch pill, permission banner     |
| `FileViewer`  | Directory browser, markdown viewer/editor, worktree selector, branch indicator |

| Directory     | Purpose                                                             |
| ------------- | ------------------------------------------------------------------- |
| `types/`      | Shared TypeScript types (Message, Session, etc.)                    |
| `lib/`        | Shared utilities (groupMessages, formatTime, truncate, resizeImage) |
| `components/` | MessageBubble, ToolPill, ToolGroup, PermissionBanner, ChatInput     |

## Prerequisites

- **Node.js** 20+
- **Git** (for worktree support)
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

| Variable               | Description                                             | Required |
| ---------------------- | ------------------------------------------------------- | -------- |
| `AUTH_PASSPHRASE`      | Login passphrase                                        | Yes      |
| `AUTH_SECRET`          | JWT signing key (min 32 chars)                          | Yes      |
| `REPO_PATH`            | Default repo for chat sessions                          | Yes      |
| `PORT`                 | Server port (default: `3100`)                           | No       |
| `WORKTREE_ENABLED`     | Allow worktree creation (default: `true`)               | No       |
| `MCP_CONFIG_PATH`      | Path to MCP config file (default: `~/.cursor/mcp.json`) | No       |
| `COOKIE_MAX_AGE_HOURS` | Auth cookie expiry (default: `24`)                      | No       |

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

## MCP server integration

Mitzo reads MCP server configurations from `~/.cursor/mcp.json` (the same file Cursor uses). Stdio-type servers are loaded on startup and passed to every Claude session via the Agent SDK's `mcpServers` option. Disabled servers are excluded.

Override the config path with the `MCP_CONFIG_PATH` environment variable.

The server logs which MCP servers were loaded on startup:

```
[mcp] loaded 1 server(s): atlassian
```

## Sandbox mode (worktrees)

Worktrees are **off by default**. Toggle the "WT" button in the chat header before sending your first message to opt in.

When sandbox mode is on:

1. Mitzo creates a git worktree at `${REPO_PATH}-sessions/session-<id>/`
2. The worktree branches from the current HEAD of your repo
3. Claude works in the isolated worktree
4. The chat header shows the branch name with an accent indicator
5. Stale worktrees (>7 days) are pruned on server startup

Disable worktree creation entirely with `WORKTREE_ENABLED=false` in `.env`.

## Push notifications

Get notified when Claude needs tool approval:

```bash
# Add ntfy config to .env:
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=your-secret-topic
BASE_URL=http://<tailscale-ip>:3100

# Configure Claude Code hooks:
./scripts/setup-mcp.sh
./scripts/setup-hooks.sh
```

## Session resilience

WebSocket disconnects (phone sleep, Tailscale hiccup) no longer kill active sessions. The server detaches the session and keeps the Agent SDK query running. When the phone reconnects, the new WebSocket reattaches to the in-flight session. Detached sessions auto-abort after 2 minutes if no reattach arrives.

## Tech stack

| Component | Technology                          |
| --------- | ----------------------------------- |
| Backend   | Node.js, Express, TypeScript        |
| Frontend  | React 19, Vite, TypeScript          |
| AI        | Claude Agent SDK                    |
| MCP       | Cursor-compatible stdio servers     |
| Auth      | JWT via jose                        |
| Isolation | Git worktrees (opt-in)              |
| Tests     | Vitest (102 tests)                  |
| Quality   | ESLint, Prettier, husky, commitlint |

## Security

See [SECURITY.md](SECURITY.md) for the threat model, secrets handling, and known limitations.

## Attribution

Mitzo evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center) by [Afstkla](https://github.com/Afstkla). The original project used tmux for session management; Mitzo replaced that with the Claude Agent SDK for direct programmatic control.

## License

MIT
