# Mitzo

Claude Code on your phone. A self-hosted web UI built on the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), designed for mobile over [Tailscale](https://tailscale.com).

<!-- ![Home Screen](docs/screenshots/home.png) -->
<!-- ![Chat with Tools](docs/screenshots/chat-tools.png) -->

## Features

- **Streaming chat** with thinking blocks, tool pills, and markdown
- **Three modes** — Ask (read-only), Agent (file edits allowed), Auto (shell too). Switch mid-chat.
- **Slash-command skills** — `/simplify`, `/risk-scan`, `/pr-review`, `/person`, `/review-response`, plus repo-local and user skills. Type `/` to browse.
- **Voice** — push-to-talk input (STT) and auto-speak output (TTS) via [Yapper](https://github.com/dimakis/yapper). Graceful degradation when offline.
- **MCP tools** — reads `~/.cursor/mcp.json`, passes servers to every session
- **File browser** — view and edit repo files, switch between worktree roots
- **Task board** — recursive multi-session task orchestration with spec mode, completion summaries, and verification hooks
- **Worktree sandbox** — opt-in git worktree isolation per session, multi-repo support via `.mitzo.json`
- **Session resilience** — phone sleeps, WS drops, session survives. Reattach on reconnect. Message snapshot recovery for iOS silent drops.
- **iOS app** — native wrapper via Capacitor with push notifications and home-screen install
- **Auto-rename sessions** — sessions get meaningful names via LLM summarization after every few prompts
- **Quick actions** — one-tap commands via `.mitzo.json`
- **Push notifications** — ntfy + Pushover (Apple Watch) when Claude needs approval
- **Image attachments** — send photos/screenshots from your camera
- **Session history** — resume past conversations, swipe to dismiss

## Quick start

```bash
git clone https://github.com/dimakis/mitzo.git && cd mitzo
npm install
cp .env.example .env  # set AUTH_PASSPHRASE, AUTH_SECRET, REPO_PATH
npm run build && npm start
# http://localhost:3100
```

Access from your phone: install [Tailscale](https://tailscale.com/download) on server and phone, then open `http://<tailscale-ip>:3100`. No HTTPS needed — Tailscale encrypts via WireGuard.

## Architecture

```
Phone (Tailscale) ──┬── HTTP: REST API
                    └── WebSocket: v2 streaming protocol
                        │
                    Server (Node + TypeScript)
                        │
                        ├── query-loop: SDK events → v2 protocol
                        ├── session-registry: detach/reattach/snapshot
                        ├── MCP servers from Cursor config
                        ├── git worktrees (opt-in)
                        └── passphrase + JWT auth
```

The server translates raw SDK stream events into a v2 block lifecycle protocol (`block_start` → `block_delta` → `block_end`). Explicit turn boundaries (`message_start`/`message_end`), deferred finalization, and message snapshots for reconnect recovery. See [docs/design/message-protocol-v2.md](docs/design/message-protocol-v2.md).

### Backend (`server/`)

| Core                    | Purpose                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `query-loop.ts`         | SDK → v2 event translator. Deferred `message_end`, snapshot state, block lifecycle. |
| `chat.ts`               | Agent SDK `query()`, prompt assembly, streaming-input queue, session restore API    |
| `session-registry.ts`   | Session state: detach, reattach, rekey, TTL abort, snapshot storage                 |
| `permission-handler.ts` | `canUseTool` callback — auto-allow by tier, prompt via WS + push notifications      |
| `async-queue.ts`        | `AsyncIterable` queue for follow-up messages and interrupt                          |

| Skills               | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `skills.ts`          | Skill registry — scoped discovery, precedence, collisions |
| `slash-commands.ts`  | Slash-command parsing and prompt expansion                |
| `skill-policy.ts`    | Per-turn tool restriction from skill frontmatter          |
| `native-commands.ts` | Built-in native commands (`/skills`)                      |

| Supporting                                                                     | Purpose                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `tool-tiers.ts`                                                                | Risk classification + mode/tier auto-allow matrix |
| `tool-summary.ts`                                                              | Summarizes tool inputs for pill display           |
| `permissions.ts`                                                               | Request/response registry                         |
| `content-blocks.ts`                                                            | SDK content block parsing                         |
| `event-store.ts`                                                               | Persistent event store for session replay         |
| `auto-rename.ts`                                                               | LLM-based session auto-renaming                   |
| `hook-bridge.ts`                                                               | Project hooks → Agent SDK bridge                  |
| `api-schemas.ts` / `ws-schemas.ts`                                             | Zod validation schemas                            |
| `mcp-config.ts`                                                                | Loads Cursor MCP config                           |
| `worktree.ts`                                                                  | Git worktree lifecycle                            |
| `repo-config.ts`                                                               | `.mitzo.json` reader                              |
| `app.ts`                                                                       | Express app factory (testability via supertest)   |
| `inbox.ts`                                                                     | Inbox integration endpoint                        |
| `internal-token.ts`                                                            | Internal token generation for inter-process auth  |
| `repo-mcp-server.ts`                                                           | Repo-scoped MCP server configuration              |
| `auth.ts`                                                                      | Passphrase + JWT                                  |
| `notification-helpers.ts`                                                      | Shared notification formatting utilities          |
| `notify.ts` / `pushover.ts`                                                    | Push notifications                                |
| `logger.ts` / `constants.ts` / `git-version.ts` / `port-check.ts` / `index.ts` | Infrastructure                                    |

### Frontend (`frontend/`) — React 19 + Vite

React 19 + Vite. Nine pages (`Login`, `SessionList`, `ChatView`, `DesktopChatView`, `FileViewer`, `InboxView`, `CalendarView`, `TodoView`, `TodoDetailView`), a `useReducer`-based message state machine (`useChatMessages`), module-level WebSocket pool with 500-message buffer, and components for thinking blocks, tool pills, tool groups, permission banners, and a slash-command picker. Capacitor wraps the frontend for iOS deployment via TestFlight.

## Environment

| Variable                      | Description                                           | Required |
| ----------------------------- | ----------------------------------------------------- | -------- |
| `AUTH_PASSPHRASE`             | Login passphrase                                      | Yes      |
| `AUTH_SECRET`                 | JWT signing key (min 32 chars)                        | Yes      |
| `REPO_PATH`                   | Default repo for sessions                             | Yes      |
| `PORT`                        | Server port (default: `3100`)                         | No       |
| `WORKTREE_ENABLED`            | Allow worktrees (default: `true`)                     | No       |
| `MCP_CONFIG_PATH`             | MCP config path (default: `~/.cursor/mcp.json`)       | No       |
| `LOG_LEVEL`                   | Log verbosity: `debug`, `info`, `warn`, `error`       | No       |
| `COOKIE_MAX_AGE_HOURS`        | JWT cookie lifetime in hours (default: `24`)          | No       |
| `BASE_URL`                    | Public URL for notification deep links                | No       |
| `YAPPER_PROXY_TARGET`         | Yapper backend URL (default: `http://localhost:8700`) | No       |
| `CLAUDE_CODE_USE_VERTEX`      | Set to `1` to use Vertex AI for auto-rename           | No       |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP project ID (required when using Vertex)           | No       |
| `CLOUD_ML_REGION`             | GCP region for Vertex (default: `us-east5`)           | No       |
| `NTFY_URL`                    | ntfy server URL (default: `https://ntfy.sh`)          | No       |
| `NTFY_TOPIC`                  | ntfy topic for notifications                          | No       |
| `NTFY_AUTH_TOKEN`             | ntfy auth token                                       | No       |
| `PUSHOVER_API_TOKEN`          | Pushover API token (for Apple Watch notifications)    | No       |
| `PUSHOVER_USER_KEY`           | Pushover user key                                     | No       |
| `MITZO_INTERNAL_TOKEN`        | Auto-generated token for inter-process auth           | No       |

See `.env.example` for a starter template.

## `.mitzo.json`

Drop this in your repo root to customize the home screen, enable multi-repo sessions, and inject domain knowledge:

```json
{
  "quickActions": [
    {
      "label": "Run Tests",
      "desc": "Full suite",
      "prompt": "Run tests and report.",
      "extraTools": "Bash"
    }
  ],
  "repos": [{ "name": "sibling-repo", "path": "../sibling-repo" }],
  "contextBlocks": {
    "Architecture": "/path/to/architecture.md"
  },
  "venvPaths": [".venv/bin"]
}
```

- **quickActions** — one-tap buttons on the home screen
- **repos** — sibling repos for multi-repo worktree sessions (each gets its own isolated worktree)
- **contextBlocks** — markdown files injected into every session as domain knowledge
- **roots** — switchable repo roots in the file browser
- **venvPaths** — Python venv paths added to `PATH`

See [docs/onboarding.md](docs/onboarding.md) for a full configuration walkthrough.

## Development

```bash
npm run dev          # backend + frontend concurrently
npm test             # vitest (1607 tests, 544 suites)
npm run lint         # eslint
npm run format:check # prettier
```

Pre-commit: husky + lint-staged + commitlint (conventional commits). The hook also runs [gitleaks](https://github.com/gitleaks/gitleaks) if installed, scanning staged changes for secrets. gitleaks is **optional** — the hook skips it gracefully when not found. Install via `brew install gitleaks` (macOS) or see the [gitleaks docs](https://github.com/gitleaks/gitleaks#installing).

## Tech

Node.js, Express, React 19, Vite, TypeScript, Claude Agent SDK, Vitest, ESLint, Prettier.

## Attribution

Evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center) by [Afstkla](https://github.com/Afstkla). The original used tmux; Mitzo uses the Agent SDK directly.

## License

MIT
