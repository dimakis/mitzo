# Mitzo

Claude Code on your phone. A self-hosted web UI built on the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), designed for mobile over [Tailscale](https://tailscale.com).

## Features

- **Streaming chat** with thinking blocks, tool pills, and markdown
- **Three modes** -- Ask (read-only), Agent (file edits allowed), Auto (shell too). Switch mid-chat.
- **Slash-command skills** -- `/simplify`, `/risk-scan`, `/pr-review`, `/person`, `/review-response`, `/land-pr`, `/pr-shepherd`. Type `/` to browse.
- **Voice** -- push-to-talk input (STT) and auto-speak output (TTS) via [Yapper](https://github.com/dimakis/yapper). Graceful degradation when offline.
- **MCP tools** -- reads `~/.cursor/mcp.json`, passes servers to every session
- **File browser** -- view and edit repo files, switch between worktree roots
- **Task board** -- recursive multi-session task orchestration with spec mode, completion summaries, and verification hooks
- **Worktree sandbox** -- deterministic git worktree isolation per session, multi-repo support via `.mitzo.json`
- **Session resilience** -- phone sleeps, WS drops, session survives. Reattach on reconnect. Message snapshot recovery for iOS silent drops.
- **iOS app** -- native wrapper via Capacitor with push notifications and home-screen install
- **Desktop mode** -- side-by-side chat + file viewer on wide screens
- **Auto-rename sessions** -- sessions get meaningful names via LLM summarization after every few prompts
- **Quick actions** -- one-tap commands via `.mitzo.json`
- **Push notifications** -- ntfy + Pushover (Apple Watch) + APNs when Claude needs approval
- **Image attachments** -- send photos/screenshots from your camera
- **Session history** -- resume past conversations, search, swipe to dismiss
- **Multi-model reasoning** -- deliberation and fusion orchestrators for collaborative multi-model reasoning
- **Observability** -- OpenTelemetry tracing (Jaeger), structured logging (Pino/Loki/Grafana), experiment tracking (MLflow)

## Quick Start

```bash
git clone https://github.com/dimakis/mitzo.git && cd mitzo
npm install
cp .env.example .env  # set AUTH_PASSPHRASE, AUTH_SECRET, REPO_PATH
npm run build && npm start
# https://localhost:3100
```

Access from your phone: install [Tailscale](https://tailscale.com/download) on server and phone, then open `https://<tailscale-ip>:3100`. Tailscale encrypts via WireGuard -- no public DNS, no port forwarding needed.

See [docs/onboarding.md](docs/onboarding.md) for the full setup walkthrough including HTTPS certificates, iOS app, voice, push notifications, and observability.

## Architecture

```
Phone / Laptop (Tailscale)
    |
    +-- HTTPS: REST API (Express)
    +-- WSS: v2 streaming protocol
        |
    Your Mac (Node.js + TypeScript)
        |
        +-- Anthropic Agent SDK
        |   +-- query-loop: SDK events -> v2 block protocol
        +-- Session registry (detach/reattach/snapshot recovery)
        +-- Connection registry (single multiplexed WS per client)
        +-- Worktree manager (multi-repo git isolation)
        +-- Task orchestrator (goal decomposition + DFS execution)
        +-- Skill registry (bundled + user + repo scoped)
        +-- MCP servers (from Cursor config)
        +-- Hook bridge (project hooks -> SDK)
        +-- Event store (SQLite, session replay + search)
        +-- Push notifications (ntfy + Pushover + APNs)
        +-- Passphrase + JWT auth
        +-- Reasoning harness (deliberation + fusion orchestrators)

    Observability (optional, podman)
        +-- Jaeger (OTLP traces)
        +-- Loki (log aggregation)
        +-- Grafana (dashboards)
        +-- MLflow (experiment tracking)
```

The server translates raw SDK stream events into a **v2 block lifecycle protocol** (`block_start` > `block_delta` > `block_end`). Sessions survive WebSocket disconnects -- when your phone reconnects, it reattaches and replays from a snapshot. See [docs/v2-protocol.md](docs/v2-protocol.md).

### Packages (`packages/`) -- npm workspace

Mitzo uses an npm workspace with three internal packages shared between server and frontend:

| Package           | Purpose                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mitzo/protocol` | Core types, Zod schemas (v2 WS messages, API schemas), tool summarization, event store definitions, agent definition types, constants                                             |
| `@mitzo/harness`  | Session registry, connection registry, permission handler, worktree guard, tool tiers, skill policy, auto-rename, notifications, reasoning orchestrators, model providers, logger |
| `@mitzo/client`   | Frontend state management: `MitzoConnection` (single multiplexed WS), Zustand store with 12 state slices, v2 protocol parser, API client, SSE fallback transport, React hooks     |

See [docs/packages.md](docs/packages.md) for the full package reference.

### Backend (`server/`)

**Core** -- Event streaming, session lifecycle, SDK integration

| File                    | Purpose                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `query-loop.ts`         | SDK -> v2 event translator. Deferred `message_end`, snapshot state, block lifecycle. |
| `chat.ts`               | Agent SDK `query()`, prompt assembly, streaming-input queue, session restore API     |
| `session-registry.ts`   | Session state: detach, reattach, rekey, TTL abort, snapshot storage                  |
| `permission-handler.ts` | `canUseTool` callback -- auto-allow by tier, prompt via WS + push notifications      |
| `async-queue.ts`        | `AsyncIterable` queue for follow-up messages and interrupt                           |

**Skills** -- Slash-command system

| File                 | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `skills.ts`          | Skill registry -- scoped discovery, precedence, collisions |
| `slash-commands.ts`  | Slash-command parsing and prompt expansion                 |
| `skill-policy.ts`    | Per-turn tool restriction from skill frontmatter           |
| `native-commands.ts` | Built-in native commands (`/skills`)                       |

**Task Board** -- Multi-session orchestration

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

| File                | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `ws-handler-v2.ts`  | v2 WebSocket message dispatcher: hello handshake -> session routing |
| `ws-transport.ts`   | `SessionTransport` adapter wrapping WebSocket connections           |
| `null-transport.ts` | Null transport for testing                                          |
| `ws-schemas.ts`     | Zod schemas for WebSocket message validation                        |

**Chat REST Handler**

| File                   | Purpose                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `chat-rest-handler.ts` | HTTP alternative to WebSocket: SSE stream + POST endpoints for send/stop/interrupt/permission |

**Supporting**

| File                | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `tool-tiers.ts`     | Risk classification + mode/tier auto-allow matrix |
| `tool-summary.ts`   | Summarizes tool inputs for pill display           |
| `permissions.ts`    | Request/response registry                         |
| `content-blocks.ts` | SDK content block parsing                         |
| `event-store.ts`    | Persistent event store for session replay         |
| `auto-rename.ts`    | LLM-based session auto-renaming                   |
| `hook-bridge.ts`    | Project hooks -> Agent SDK bridge                 |
| `api-schemas.ts`    | Zod validation schemas for HTTP                   |
| `mcp-config.ts`     | Loads Cursor MCP config                           |
| `repo-config.ts`    | `.mitzo.json` reader                              |
| `app.ts`            | Express app factory (testability via supertest)   |
| `auth.ts`           | Passphrase + JWT                                  |
| `internal-token.ts` | Internal token generation for inter-process auth  |
| `goal-client.ts`    | ContexGin Goal Registry client                    |
| `index.ts`          | Express app, HTTP server + WebSocket              |

### Frontend (`frontend/`) -- React 19 + Vite

React 19 + Vite. Ten pages (`Login`, `SessionList`, `ChatView`, `DesktopChatView`, `FileViewer`, `InboxView`, `CalendarView`, `TodoView`, `TodoDetailView`, `TaskBoard`), a `useReducer`-based message state machine (`useChatMessages`), module-level WebSocket with sequence tracking and reconnect recovery, and components for thinking blocks, tool pills, tool groups, permission banners, and a slash-command picker. Capacitor wraps the frontend for iOS deployment via TestFlight.

**Key Hooks:**

- `useChatMessages` -- v2 protocol message reducer (MESSAGE_START/BLOCK_START/BLOCK_DELTA/BLOCK_END/TOOL_RESULT/MESSAGE_END/SESSION_END/MESSAGE_SNAPSHOT/RESTORE)
- `useTaskBoard` -- task CRUD + loop control + WS subscriptions
- `useVoice` -- STT (push-to-talk) + TTS (auto-speak toggle, voice selection, sequential chunk playback)
- `useFileNavigation` / `useFileEditor` -- file browser and editing
- `useSessionOverview` -- session metadata and statistics
- `useAutoSpeak` -- auto-speak TTS preferences
- `useServiceHealth` -- health status for Yapper, ContexGin

**Key Components:**

- `MessageBubble` (UserBubble/TextBubble), `ThinkingBlock`, `ToolPill`, `ToolGroup`, `PermissionBanner`, `ChatInput`, `SlashPicker`
- `TaskNode`, `TaskCreateForm`, `LoopControls`, `TaskSidebar` -- task board UI
- `VoiceSettings` -- speaker toggle with pulse indicator, voice picker dropdown grouped by language
- `SessionOverview` -- session metadata card
- `ContextPanel` -- boot context viewer
- `FileBrowserPanel` -- file tree navigation

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
  "repos": { "sibling-repo": "../sibling-repo" },
  "contextBlocks": {
    "Architecture": "/path/to/architecture.md"
  },
  "venvPaths": [".venv/bin"],
  "toolTierOverrides": {
    "mcp__jira__jira_search": "safe"
  }
}
```

- **quickActions** -- one-tap buttons on the home screen
- **repos** -- sibling repos for multi-repo worktree sessions (each gets its own isolated worktree)
- **roots** -- switchable repo roots in the file browser
- **contextBlocks** -- markdown files injected into every session as domain knowledge
- **allowedPaths** -- additional directories Claude can access beyond `REPO_PATH`
- **venvPaths** -- Python venv paths added to `PATH`
- **toolTierOverrides** -- override default risk tier for any tool (`safe`, `standard`, `elevated`, `unknown`)

See [docs/onboarding.md](docs/onboarding.md) for a full configuration walkthrough.

## API

Mitzo exposes a REST API and a WebSocket protocol for chat interaction:

| Category    | Endpoints                                                     | Description                                                       |
| ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Auth        | `POST /api/auth/login`, `logout`, `check`                     | Passphrase login, JWT cookies                                     |
| Sessions    | `POST /api/sessions`, `GET`, `DELETE`, `PUT rename`, `search` | Session lifecycle and management                                  |
| Chat (WS)   | `ws://host/ws/chat`                                           | v2 streaming protocol -- send, interrupt, stop, permissions, mode |
| Chat (REST) | `GET /api/chat/events` (SSE) + POST endpoints                 | HTTP alternative to WebSocket                                     |
| Tasks       | `GET/POST/PATCH/DELETE /api/tasks`, loop control              | Task board CRUD and orchestration                                 |
| Files       | `GET /api/files/list`, `read`, `download`, `PUT write`        | File browser operations                                           |
| Skills      | `GET /api/skills`                                             | Available skills registry                                         |
| Config      | `GET /api/config`, `models`, `version`                        | Server configuration and metadata                                 |
| Calendar    | `GET /api/calendar`                                           | Calendar events and sprints                                       |
| Todos       | `GET/POST /api/todos`                                         | Todo items (Telos integration)                                    |
| Inbox       | `GET/POST /api/inbox`                                         | Agent inbox items                                                 |
| Workload    | `GET/PATCH/DELETE /api/workload/items`                        | Workload signal tracking                                          |
| Events      | `GET /api/events` (SSE)                                       | Server-sent events for live updates                               |
| Push        | `POST /api/push/register`                                     | Device token registration (APNs)                                  |

See [docs/api-reference.md](docs/api-reference.md) for the complete reference with request/response schemas.

## Documentation

| Document                                       | Description                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| [Onboarding](docs/onboarding.md)               | Full setup walkthrough -- server, mobile, iOS app, voice, observability    |
| [Architecture](docs/architecture.md)           | Deep dive into module structure, data flow, and design decisions           |
| [API Reference](docs/api-reference.md)         | Complete REST API and WebSocket protocol reference                         |
| [v2 Protocol](docs/v2-protocol.md)             | WebSocket streaming protocol -- message lifecycle, reconnection, subagents |
| [Skills](docs/skills.md)                       | Skills system -- discovery, precedence, authoring custom skills            |
| [Task Board](docs/task-board.md)               | Task orchestration -- goal decomposition, DFS execution, spec mode         |
| [Session Isolation](docs/session-isolation.md) | Worktree isolation -- multi-repo, enforcement, cleanup, external hooks     |
| [Packages](docs/packages.md)                   | npm workspace package reference -- protocol, harness, client               |

### Design Documents

Internal design documents live in `docs/design/`. These capture implementation decisions and are not user-facing:

- `message-protocol-v2.md` -- v2 streaming protocol design
- `global-task-board.md` -- task board architecture
- `skills-system-v1-plan.md` -- skills system design
- `session-isolation-overhaul.md` -- session isolation redesign
- `session-state-machine.md` -- session state machine
- `voice-integration.md` -- voice architecture
- `tts-playback.md` -- TTS playback design
- `streaming-input-session-control.md` -- streaming input
- `otel-deep-instrumentation.md` -- observability roadmap
- `context-blocks.md` -- context block injection
- `token-visibility.md` -- token usage display

## Development

```bash
npm run dev          # backend + frontend concurrently
npm test             # vitest -- full suite
npm run lint         # eslint
npm run format:check # prettier
```

Pre-commit: husky + lint-staged + commitlint (conventional commits). The hook also runs [gitleaks](https://github.com/gitleaks/gitleaks) if installed, scanning staged changes for secrets. gitleaks is optional -- the hook skips it gracefully when not found.

**All work goes through branches and PRs.** A pre-commit hook rejects commits on `main`.

## Tech

Node.js, Express, React 19, Vite, TypeScript, Claude Agent SDK, Vitest, ESLint, Prettier, Capacitor (iOS), Zustand, Zod, Pino, OpenTelemetry, SQLite (better-sqlite3).

## Attribution

Evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center) by [Afstkla](https://github.com/Afstkla). The original used tmux; Mitzo uses the Agent SDK directly.

## License

MIT
