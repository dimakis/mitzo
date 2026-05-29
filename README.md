# Mitzo

Claude Code on your phone. A self-hosted web UI built on the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), designed for mobile over [Tailscale](https://tailscale.com).

<!-- ![Home Screen](docs/screenshots/home.png) -->
<!-- ![Chat with Tools](docs/screenshots/chat-tools.png) -->

## Features

- **Streaming chat** with thinking blocks, tool pills, and markdown
- **Three modes** — Ask (read-only), Agent (file edits allowed), Auto (shell too). Switch mid-chat.
- **Slash-command skills** — `/simplify`, `/risk-scan`, `/pr-review`, `/person`, `/review-response`, `/land-pr`, `/pr-shepherd`. Type `/` to browse.
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

### Packages (`packages/`) — npm workspace

Mitzo uses an npm workspace with three internal packages shared between server and frontend:

| Package           | Purpose                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mitzo/protocol` | Core protocol types, Zod schemas (v2 WS messages, API schemas), tool summarization, event store definitions                                                      |
| `@mitzo/harness`  | Session registry, connection registry, permission handler, worktree guard, tool tiers, skill policy, auto-rename, notifications, logger                          |
| `@mitzo/client`   | Frontend state management: `MitzoConnection` (single multiplexed WS), Zustand store (`createMitzoStore`), v2 protocol parser, session switching, message reducer |

### Backend (`server/`)

**Core** — Event streaming, session lifecycle, SDK integration

| File                    | Purpose                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `query-loop.ts`         | SDK → v2 event translator. Deferred `message_end`, snapshot state, block lifecycle. |
| `chat.ts`               | Agent SDK `query()`, prompt assembly, streaming-input queue, session restore API    |
| `session-registry.ts`   | Session state: detach, reattach, rekey, TTL abort, snapshot storage                 |
| `permission-handler.ts` | `canUseTool` callback — auto-allow by tier, prompt via WS + push notifications      |
| `async-queue.ts`        | `AsyncIterable` queue for follow-up messages and interrupt                          |

**Skills** — Slash-command system

| File                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `skills.ts`          | Skill registry — scoped discovery, precedence, collisions |
| `slash-commands.ts`  | Slash-command parsing and prompt expansion                |
| `skill-policy.ts`    | Per-turn tool restriction from skill frontmatter          |
| `native-commands.ts` | Built-in native commands (`/skills`)                      |

**Task Board** — Multi-session orchestration

| File                   | Purpose                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `task-store.ts`        | SQLite persistence: tree queries, cascade status, DFS ordering, orphan detection. WAL mode. |
| `task-orchestrator.ts` | Event-driven state machine (idle/running/paused), DFS sequential task assignment            |
| `task-tools.ts`        | Pure handler functions for agent task tools (TaskSet, TaskComplete, TaskStatus, TaskBlock)  |
| `task-context.ts`      | XML task context builder for system prompt injection                                        |
| `task-mcp-server.ts`   | Stdio MCP server exposing task tools as `mcp__task-board__*`                                |

**Worktrees & Session Isolation**

| File               | Purpose                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `worktree.ts`      | Git worktree lifecycle: create, remove, cleanup stale (scans `.claude/` and `.cursor/`)                               |
| `session-index.ts` | YAML session index at `<repo>/.claude/sessions/index.yaml`. Tracks active/closed sessions with repo worktree mappings |

**Observability**

| File                | Purpose                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `logger.ts`         | Pino structured logging: JSON output, daily rotation, OTel trace context mixin, Loki integration |
| `tracing.ts`        | OpenTelemetry: BatchSpanProcessor, OTLP HTTP exporter to Jaeger                                  |
| `trace-context.ts`  | Trace context utilities                                                                          |
| `health-monitor.ts` | Service health monitoring (Yapper, ContexGin)                                                    |

**Notifications**

| File                      | Purpose                                      |
| ------------------------- | -------------------------------------------- |
| `notify.ts`               | ntfy push notifications                      |
| `pushover.ts`             | Pushover (Apple Watch) notifications         |
| `apns.ts`                 | Apple Push Notification Service (iOS native) |
| `notification-helpers.ts` | Shared notification formatting utilities     |

**WebSocket & Transport**

| File                | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `ws-handler-v2.ts`  | v2 WebSocket message dispatcher: hello handshake → session routing |
| `ws-transport.ts`   | `SessionTransport` adapter wrapping WebSocket connections          |
| `null-transport.ts` | Null transport for testing                                         |
| `ws-schemas.ts`     | Zod schemas for WebSocket message validation                       |

**Supporting**

| File                    | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `tool-tiers.ts`         | Risk classification + mode/tier auto-allow matrix |
| `tool-summary.ts`       | Summarizes tool inputs for pill display           |
| `permissions.ts`        | Request/response registry                         |
| `content-blocks.ts`     | SDK content block parsing                         |
| `event-store.ts`        | Persistent event store for session replay         |
| `auto-rename.ts`        | LLM-based session auto-renaming                   |
| `hook-bridge.ts`        | Project hooks → Agent SDK bridge                  |
| `api-schemas.ts`        | Zod validation schemas for HTTP                   |
| `mcp-config.ts`         | Loads Cursor MCP config                           |
| `repo-config.ts`        | `.mitzo.json` reader                              |
| `app.ts`                | Express app factory (testability via supertest)   |
| `inbox.ts`              | Inbox integration endpoint                        |
| `internal-token.ts`     | Internal token generation for inter-process auth  |
| `auth.ts`               | Passphrase + JWT                                  |
| `git-version.ts`        | Local/remote commit comparison                    |
| `port-check.ts`         | Prevents duplicate server instances               |
| `constants.ts`          | Server-wide constants                             |
| `index.ts`              | Express app, HTTP server + WebSocket              |
| `goal-client.ts`        | ContexGin Goal Registry client                    |
| `progress-tracker.ts`   | Progress tracking utilities                       |
| `prompt-compare.ts`     | Prompt comparison utilities                       |
| `workflow-templates.ts` | Workflow templates                                |
| `workload-store.ts`     | Workload persistence                              |
| `session-overview.ts`   | Session overview API                              |
| `signal-processor.ts`   | Signal processing utilities                       |

### Frontend (`frontend/`) — React 19 + Vite

React 19 + Vite. Ten pages (`Login`, `SessionList`, `ChatView`, `DesktopChatView`, `FileViewer`, `InboxView`, `CalendarView`, `TodoView`, `TodoDetailView`, `TaskBoard`), a `useReducer`-based message state machine (`useChatMessages`), module-level WebSocket pool with 500-message buffer, and components for thinking blocks, tool pills, tool groups, permission banners, and a slash-command picker. Capacitor wraps the frontend for iOS deployment via TestFlight.

**Key Hooks:**

- `useChatMessages` — v2 protocol message reducer (MESSAGE_START/BLOCK_START/BLOCK_DELTA/BLOCK_END/TOOL_RESULT/MESSAGE_END/SESSION_END/MESSAGE_SNAPSHOT/RESTORE)
- `useTaskBoard` — task CRUD + loop control + WS subscriptions
- `useVoice` — STT (push-to-talk) + TTS (auto-speak toggle, voice selection, sequential chunk playback)
- `useFileNavigation` / `useFileEditor` — file browser and editing
- `useSessionOverview` — session metadata and statistics
- `useAutoSpeak` — auto-speak TTS preferences
- `useServiceHealth` — health status for Yapper, ContexGin

**Key Components:**

- `MessageBubble` (UserBubble/TextBubble), `ThinkingBlock`, `ToolPill`, `ToolGroup`, `PermissionBanner`, `ChatInput`, `SlashPicker`
- `TaskNode`, `TaskCreateForm`, `LoopControls`, `TaskSidebar` — task board UI
- `VoiceSettings` — speaker toggle with pulse indicator, voice picker dropdown grouped by language
- `SessionOverview` — session metadata card
- `ContextPanel` — boot context viewer
- `FileBrowserPanel` — file tree navigation

## Environment

| Variable                      | Description                                                    | Required |
| ----------------------------- | -------------------------------------------------------------- | -------- |
| `AUTH_PASSPHRASE`             | Login passphrase                                               | Yes      |
| `AUTH_SECRET`                 | JWT signing key (min 32 chars)                                 | Yes      |
| `REPO_PATH`                   | Default repo for sessions                                      | Yes      |
| `PORT`                        | Server port (default: `3100`)                                  | No       |
| `COOKIE_MAX_AGE_HOURS`        | JWT cookie lifetime in hours (default: `24`)                   | No       |
| `WORKTREE_ENABLED`            | Allow worktrees (default: `true`)                              | No       |
| `MCP_CONFIG_PATH`             | MCP config path (default: `~/.cursor/mcp.json`)                | No       |
| `LOG_LEVEL`                   | Log verbosity: `debug`, `info`, `warn`, `error`                | No       |
| `LOG_FILE_PATH`               | Log file path (default: `logs/server.log`)                     | No       |
| `LOGGER_SYNC`                 | Set to `1` for synchronous logging                             | No       |
| `BASE_URL`                    | Public URL for notification deep links                         | No       |
| `YAPPER_PROXY_TARGET`         | Yapper backend URL (default: `http://localhost:8700`)          | No       |
| `CLAUDE_CODE_USE_VERTEX`      | Set to `1` to use Vertex AI for auto-rename                    | No       |
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP project ID (required when using Vertex)                    | No       |
| `CLOUD_ML_REGION`             | GCP region for Vertex (default: `us-east5`)                    | No       |
| `NTFY_URL`                    | ntfy server URL (default: `https://ntfy.sh`)                   | No       |
| `NTFY_TOPIC`                  | ntfy topic for notifications                                   | No       |
| `NTFY_AUTH_TOKEN`             | ntfy auth token                                                | No       |
| `PUSHOVER_API_TOKEN`          | Pushover API token (for Apple Watch notifications)             | No       |
| `PUSHOVER_USER_KEY`           | Pushover user key                                              | No       |
| `APNS_KEY_PATH`               | Path to Apple Push Notification Service .p8 key                | No       |
| `APNS_KEY_ID`                 | APNS key ID                                                    | No       |
| `APNS_TEAM_ID`                | Apple Team ID                                                  | No       |
| `APNS_BUNDLE_ID`              | iOS app bundle ID (default: `com.mitzo.app`)                   | No       |
| `APNS_PRODUCTION`             | Use production APNS (default: `true`)                          | No       |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry OTLP endpoint (e.g., `http://localhost:4318`)    | No       |
| `LOKI_HOST`                   | Grafana Loki endpoint (e.g., `http://localhost:3200`)          | No       |
| `TRACE_CONTENT_MAX_CHARS`     | Max chars for trace content (default: `16384`)                 | No       |
| `CORS_ALLOWED_ORIGINS`        | Comma-separated CORS origins                                   | No       |
| `CONTEXGIN_URL`               | ContexGin Goal Registry URL (default: `http://localhost:8321`) | No       |
| `MITZO_INTERNAL_TOKEN`        | Auto-generated token for inter-process auth                    | No       |

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
npm test             # vitest (2587 tests, 177 suites)
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
