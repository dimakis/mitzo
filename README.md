# Mitzo

Claude Code on your phone. A self-hosted web UI built on the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), designed for mobile over [Tailscale](https://tailscale.com).

Mitzo turns your Mac into a personal AI workstation accessible from anywhere. It wraps the Claude Agent SDK in a mobile-first streaming interface with session isolation, voice I/O, multi-session task orchestration, a skills system, and production-grade observability. Every session runs in its own git worktree, so concurrent work across repos never collides.

<!-- ![Home Screen](docs/screenshots/home.png) -->
<!-- ![Chat with Tools](docs/screenshots/chat-tools.png) -->

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Skills system](#skills-system)
- [Session isolation](#session-isolation)
- [Task board](#task-board)
- [Voice integration](#voice-integration)
- [iOS app](#ios-app)
- [Push notifications](#push-notifications)
- [MCP integration](#mcp-integration)
- [Observability](#observability)
- [Security](#security)
- [Deployment](#deployment)
- [Development](#development)
- [API reference](#api-reference)
- [Design docs](#design-docs)
- [Troubleshooting](#troubleshooting)
- [Tech stack](#tech-stack)
- [Attribution](#attribution)
- [License](#license)

## Features

- **Streaming chat** with thinking blocks, tool pills, and markdown rendering. Real-time block lifecycle protocol with explicit turn boundaries.
- **Three permission modes** that control what the agent can do. Ask (read-only), Agent (file edits allowed), Auto (shell commands too). Switch mid-conversation.
- **Slash-command skills** for reusable prompt workflows. Type `/` to browse available skills. Bundled set includes `/simplify`, `/risk-scan`, `/pr-review`, `/person`, `/review-response`, `/land-pr`, `/pr-shepherd`, `/plugin`. Add your own.
- **Voice** with push-to-talk input (STT) and auto-speak output (TTS) via [Yapper](https://github.com/dimakis/yapper). Sentence-boundary chunking for natural playback. Graceful degradation when Yapper is offline.
- **MCP tools** loaded from `~/.cursor/mcp.json` and passed to every session automatically. Full Model Context Protocol support.
- **File browser** for viewing and editing repo files directly. Switch between worktree roots and navigate the full file tree.
- **Task board** for recursive multi-session orchestration. Decompose complex work into subtasks, run them in parallel sessions, with spec mode for human approval of decompositions before execution.
- **Worktree sandbox** with opt-in git worktree isolation per session. Multi-repo support via `.mitzo.json`. Each session gets its own branch and working directory so concurrent sessions never collide.
- **Session resilience** across network drops, phone sleep, and app backgrounding. Sessions detach on disconnect and reattach on reconnect. Message snapshot recovery handles iOS silent WebSocket drops.
- **iOS native app** via Capacitor with push notifications, home-screen install, and TestFlight distribution.
- **Desktop mode** with a wider layout and sidebar navigation when accessed from a laptop or desktop browser.
- **Auto-rename sessions** via LLM summarization. Sessions get meaningful names after every few prompts, so your session list stays navigable.
- **Quick actions** for one-tap commands configurable via `.mitzo.json`. Morning briefings, test runs, deploy, inbox triage, all from the home screen.
- **Push notifications** via ntfy, Pushover (Apple Watch), and APNS (iOS native) when Claude needs tool approval or a session completes.
- **Image attachments** from your camera or photo library, sent directly into the conversation.
- **Session history** with resume, search, and swipe-to-dismiss. Pick up where you left off across devices.
- **Boot context injection** from `.mitzo.json` context blocks, project CLAUDE.md files, and ContexGin compiled context.
- **Inbox integration** for reviewing and approving agent proposals from connected workspace agents.
- **Calendar view** for upcoming meetings and schedule overview.
- **Todo view** for task tracking integration with external task systems.

## Quick start

```bash
git clone https://github.com/dimakis/mitzo.git && cd mitzo
npm install
cp .env.example .env  # set AUTH_PASSPHRASE, AUTH_SECRET, REPO_PATH
npm run build:all && npm start
# http://localhost:3100
```

Access from your phone: install [Tailscale](https://tailscale.com/download) on both the server machine and your phone, then open `http://<tailscale-ip>:3100`. No HTTPS needed. Tailscale encrypts the connection via WireGuard.

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **npm 10+** (ships with Node 20)
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **Git** 2.30+ (worktree support)
- **Tailscale** on the server and any client devices (for remote access)
- **macOS** for the server (launchd integration for deployment; the app itself is cross-platform Node.js)

Optional:
- **Yapper** for voice I/O (STT + TTS). See [Yapper on GitHub](https://github.com/dimakis/yapper).
- **Xcode 15+** for iOS builds via Capacitor
- **Docker/Podman** for the observability stack (Jaeger, Grafana, Loki, MLflow)
- **gitleaks** for pre-commit secret scanning (`brew install gitleaks`)

## Installation

### 1. Clone and install

```bash
git clone https://github.com/dimakis/mitzo.git
cd mitzo
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set the three required variables:

```
AUTH_PASSPHRASE=your-secure-passphrase
AUTH_SECRET=replace-with-random-secret-key-min-32-chars
REPO_PATH=/path/to/your/default/repo
```

### 3. Build

```bash
npm run build:all   # builds server (TypeScript) + frontend (Vite)
```

### 4. Start

```bash
npm start           # production mode
# or
npm run dev         # development mode with hot reload
```

### 5. Access

Open `http://localhost:3100` in your browser. Enter the passphrase you configured.

For mobile access via Tailscale, open `http://<your-tailscale-hostname>:3100` on your phone.

## Configuration

### Environment variables

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

### `.mitzo.json`

Drop this file in your repo root to customize the home screen, enable multi-repo sessions, and inject domain knowledge into every session.

```json
{
  "quickActions": [
    {
      "label": "Run Tests",
      "desc": "Full suite",
      "prompt": "Run tests and report.",
      "extraTools": "Bash"
    },
    {
      "label": "Morning Briefing",
      "desc": "Calendar, email, Jira",
      "prompt": "Run the morning briefing and summarize.",
      "extraTools": "Bash"
    }
  ],
  "repos": {
    "sibling-repo": "/path/to/sibling-repo",
    "another-repo": "/path/to/another-repo"
  },
  "contextBlocks": {
    "Architecture": "/path/to/architecture.md",
    "Workflow": "/path/to/workflow-context.md"
  },
  "roots": [
    { "label": "Main Repo", "path": "/path/to/main" },
    { "label": "Sibling", "path": "/path/to/sibling" }
  ],
  "venvPaths": [".venv/bin", "../other-repo/.venv/bin"],
  "allowedPaths": ["/path/to/additional/allowed/dir"],
  "inboxPath": "path/to/inbox"
}
```

| Field             | Description                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `quickActions`    | One-tap buttons on the home screen. Each has a `label`, `desc`, `prompt`, and optional `extraTools` or `path`.   |
| `repos`           | Sibling repos for multi-repo worktree sessions. Each repo gets its own isolated worktree per session.            |
| `contextBlocks`   | Markdown files injected into every session as domain knowledge. Keys become section headers.                     |
| `roots`           | Switchable repo roots in the file browser. Each has a `label` and `path`.                                        |
| `venvPaths`       | Python virtual environment `bin/` directories added to `PATH` for all sessions.                                  |
| `allowedPaths`    | Additional filesystem paths the agent is allowed to access beyond `REPO_PATH`.                                   |
| `inboxPath`       | Path to an inbox directory for agent proposals (relative to repo root).                                          |

See [docs/onboarding.md](docs/onboarding.md) for a full configuration walkthrough.

## Architecture

```
Phone/Desktop (Tailscale) ──┬── HTTP: REST API + SSE
                            └── WebSocket: v2 streaming protocol
                                │
                            Server (Node.js + TypeScript + Express)
                                │
                                ├── query-loop ──── Agent SDK ──── Claude API
                                ├── session-registry: detach/reattach/snapshot
                                ├── skill-registry: slash-command discovery
                                ├── task-orchestrator: multi-session task board
                                ├── worktree-manager: git isolation per session
                                ├── MCP servers (from Cursor config)
                                ├── event-store: SQLite message persistence
                                ├── observability: Pino + OTel + Jaeger + Loki
                                ├── notifications: ntfy + Pushover + APNS
                                └── auth: passphrase + JWT cookie
```

### How it works

1. **You send a message** from your phone or desktop browser.
2. The **WebSocket** carries it to the server, which routes it to the correct session via the v2 protocol.
3. The **query loop** calls the Agent SDK's `query()` method, which streams back events (text, tool calls, thinking).
4. Events are translated into the **v2 block lifecycle protocol**: `block_start`, `block_delta`, `block_end`, with explicit turn boundaries (`message_start`/`message_end`).
5. The frontend **reducer** processes each event type and updates the UI in real time.
6. When Claude calls a tool, the **permission handler** checks the tool tier against the current mode. Safe tools auto-approve. Elevated tools trigger a push notification and a permission banner in the UI.
7. If the WebSocket drops (phone sleep, network change), the session **detaches** rather than aborting. On reconnect, the client reattaches and receives a message snapshot to restore state.

See [docs/design/message-protocol-v2.md](docs/design/message-protocol-v2.md) for protocol details.

### Project structure

```
mitzo/
├── server/                     # Backend (Node.js + Express + TypeScript)
│   ├── *.ts                    # ~56 source modules
│   └── __tests__/              # ~84 test files (Vitest)
├── frontend/                   # Frontend (React 19 + Vite + TypeScript)
│   ├── src/
│   │   ├── pages/              # 10 page components
│   │   ├── components/         # ~57 UI components
│   │   ├── hooks/              # ~27 custom React hooks
│   │   ├── lib/                # ~38 utility modules
│   │   ├── types/              # Shared type definitions
│   │   └── styles/             # Theme tokens
│   ├── capacitor.config.ts     # iOS native wrapper config
│   └── ios/                    # Xcode project (Capacitor-generated)
├── packages/                   # npm workspace shared packages
│   ├── protocol/               # @mitzo/protocol: types, schemas, event store
│   ├── harness/                # @mitzo/harness: sessions, permissions, worktrees
│   └── client/                 # @mitzo/client: frontend state, WS connection
├── skills/                     # Bundled slash-command skills (8 .md files)
├── mcp-server/                 # Standalone MCP server for task board
├── scripts/                    # Build, deploy, and dev scripts
├── docs/                       # Documentation and design specs
│   ├── design/                 # Architecture design documents
│   ├── features/               # Feature specifications
│   └── screenshots/            # UI screenshots
├── infra/                      # Docker Compose configs (observability)
├── certs/                      # HTTPS certificates (gitignored)
├── logs/                       # Rotating structured logs (gitignored)
├── .mitzo/                     # Runtime data: SQLite DBs (gitignored)
├── docker-compose.yml          # Observability stack
├── package.json                # Root workspace config
├── tsconfig.json               # TypeScript config
├── .env.example                # Environment template
├── CLAUDE.md                   # Developer guide + architecture reference
└── SECURITY.md                 # Threat model and security design
```

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
| `index.ts`              | Express app, HTTP/HTTPS server, WebSocket setup, startup orchestration              |
| `app.ts`                | Express app factory (separated for testability via supertest)                        |
| `query-loop.ts`         | SDK event stream to v2 protocol translator. Deferred `message_end`, snapshot state, block lifecycle |
| `chat.ts`               | Agent SDK `query()`, prompt assembly, streaming-input queue, session restore API    |
| `session-registry.ts`   | Session state: detach, reattach, rekey, TTL abort, snapshot storage                 |
| `permission-handler.ts` | `canUseTool` callback: auto-allow by tier, prompt via WS + push notifications       |
| `async-queue.ts`        | `AsyncIterable` queue for follow-up messages and interrupt                          |

**Skills** — Slash-command system

| File                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `skills.ts`          | Skill registry: scoped discovery, precedence, collisions  |
| `slash-commands.ts`  | Slash-command parsing and prompt expansion                 |
| `skill-policy.ts`    | Per-turn tool restriction from skill frontmatter           |
| `skill-watcher.ts`   | File watcher for hot-reload of skill definitions           |
| `native-commands.ts` | Built-in native commands (`/skills`)                       |

**Task Board** — Multi-session orchestration

| File                   | Purpose                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `task-store.ts`        | SQLite persistence: tree queries, cascade status, DFS ordering, orphan detection. WAL mode. |
| `task-orchestrator.ts` | Event-driven state machine (idle/running/paused), DFS sequential task assignment             |
| `task-tools.ts`        | Pure handler functions for agent task tools (TaskSet, TaskComplete, TaskStatus, TaskBlock)   |
| `task-context.ts`      | XML task context builder for system prompt injection                                         |
| `task-mcp-server.ts`   | Stdio MCP server exposing task tools as `mcp__task-board__*`                                 |

**Worktrees and session isolation**

| File               | Purpose                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `worktree.ts`      | Git worktree lifecycle: create, remove, cleanup stale (scans `.claude/` and `.cursor/`)                               |
| `session-index.ts` | YAML session index at `<repo>/.claude/sessions/index.yaml`. Tracks active/closed sessions with repo worktree mappings |

**Observability**

| File                | Purpose                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `logger.ts`         | Pino structured logging: JSON output, daily rotation, OTel trace context mixin, Loki integration |
| `tracing.ts`        | OpenTelemetry: BatchSpanProcessor, OTLP HTTP exporter to Jaeger                                  |
| `trace-context.ts`  | Trace context utilities for span correlation                                                     |
| `health-monitor.ts` | Service health monitoring (Yapper, ContexGin)                                                    |

**Notifications**

| File                      | Purpose                                      |
| ------------------------- | -------------------------------------------- |
| `notify.ts`               | ntfy push notifications                      |
| `pushover.ts`             | Pushover (Apple Watch) notifications         |
| `apns.ts`                 | Apple Push Notification Service (iOS native)  |
| `notification-helpers.ts` | Shared notification formatting utilities      |

**WebSocket and transport**

| File                | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `ws-handler-v2.ts`  | v2 WebSocket message dispatcher: hello handshake, session routing  |
| `ws-transport.ts`   | `SessionTransport` adapter wrapping WebSocket connections           |
| `null-transport.ts` | Null transport for testing                                          |
| `ws-schemas.ts`     | Zod schemas for WebSocket message validation                       |

**Auth and security**

| File                 | Purpose                                          |
| -------------------- | ------------------------------------------------ |
| `auth.ts`            | Passphrase verification + JWT cookie issuance     |
| `internal-token.ts`  | Auto-generated token for inter-process auth       |

**Supporting modules**

| File                    | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `tool-tiers.ts`         | Risk classification + mode/tier auto-allow matrix  |
| `tool-summary.ts`       | Summarizes tool inputs for pill display             |
| `permissions.ts`        | Permission request/response registry               |
| `content-blocks.ts`     | SDK content block parsing                          |
| `event-store.ts`        | Persistent event store for session replay          |
| `auto-rename.ts`        | LLM-based session auto-renaming                    |
| `hook-bridge.ts`        | Project hooks to Agent SDK bridge                  |
| `api-schemas.ts`        | Zod validation schemas for HTTP endpoints          |
| `mcp-config.ts`         | Loads and validates Cursor MCP config              |
| `repo-config.ts`        | `.mitzo.json` reader and validator                 |
| `agent-loader.ts`       | Dynamic agent definition loading                   |
| `goal-client.ts`        | ContexGin Goal Registry client                     |
| `inbox.ts`              | Inbox integration endpoint                         |
| `image-store.ts`        | Image attachment storage                           |
| `signal-processor.ts`   | Signal processing utilities                        |
| `progress-tracker.ts`   | Progress tracking utilities                        |
| `prompt-compare.ts`     | Prompt comparison utilities                        |
| `workflow-templates.ts` | Workflow template definitions                      |
| `workload-store.ts`     | Workload persistence                               |
| `session-overview.ts`   | Session overview and statistics API                |
| `git-version.ts`        | Local/remote commit comparison for update detection|
| `port-check.ts`         | Prevents duplicate server instances                |
| `constants.ts`          | Server-wide constants                              |

### Frontend (`frontend/`) — React 19 + Vite

React 19 with Vite, TypeScript, and Zustand for state management. Capacitor wraps the frontend for iOS deployment via TestFlight.

**Pages (10):**

| Page               | Purpose                                                |
| ------------------ | ------------------------------------------------------ |
| `Login`            | Passphrase entry                                       |
| `SessionList`      | Session history with resume, search, swipe-to-dismiss  |
| `ChatView`         | Mobile chat interface (main view)                      |
| `DesktopChatView`  | Desktop layout with sidebar navigation                 |
| `FileViewer`       | File tree browser with inline editing                  |
| `InboxView`        | Agent proposal review and approval                     |
| `CalendarView`     | Calendar and meeting schedule                          |
| `TodoView`         | Task list with cross-source integration                |
| `TodoDetailView`   | Individual task detail and editing                     |
| `TaskBoard`        | Multi-session task orchestration UI                    |

**Key hooks:**

| Hook                 | Purpose                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `useChatMessages`    | v2 protocol message reducer (MESSAGE_START/BLOCK_START/BLOCK_DELTA/BLOCK_END/TOOL_RESULT/MESSAGE_END/SNAPSHOT)    |
| `useTaskBoard`       | Task CRUD, loop control, and WebSocket subscriptions for orchestration state                                      |
| `useVoice`           | STT (push-to-talk recording) + TTS (auto-speak toggle, voice selection, sequential chunk playback)               |
| `useFileNavigation`  | File browser tree traversal and state                                                                            |
| `useFileEditor`      | Inline file editing with save/discard                                                                            |
| `useSessionOverview` | Session metadata, statistics, and cost tracking                                                                  |
| `useAutoSpeak`       | Auto-speak TTS preference persistence                                                                            |
| `useServiceHealth`   | Health status polling for Yapper, ContexGin                                                                      |

**Key components:**

| Component           | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `MessageBubble`     | User and assistant message rendering (UserBubble/TextBubble)      |
| `ThinkingBlock`     | Expandable thinking/reasoning display                             |
| `ToolPill`          | Compact tool call display with status indicators                  |
| `ToolGroup`         | Grouped tool calls with expand/collapse                           |
| `PermissionBanner`  | Tool approval prompt with approve/deny actions                    |
| `ChatInput`         | Message input with voice button, image attach, slash-command trigger |
| `SlashPicker`       | Skill browser with search, type badges, collision warnings        |
| `TaskNode`          | Individual task in the task board tree                             |
| `TaskCreateForm`    | New task creation with spec mode toggle                           |
| `LoopControls`      | Task board play/pause/stop controls                               |
| `VoiceSettings`     | Speaker toggle with pulse indicator, voice picker by language     |
| `SessionOverview`   | Session metadata card (tokens, cost, duration)                    |
| `ContextPanel`      | Boot context viewer showing injected context blocks               |
| `FileBrowserPanel`  | File tree navigation with root switching                          |

## Skills system

Skills are reusable prompt workflows packaged as Markdown files with YAML frontmatter. Type `/` in the chat input to browse available skills.

### Bundled skills

| Skill              | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `/simplify`        | Find complexity, duplication, and cleanup opportunities in changed code  |
| `/risk-scan`       | Surface failure modes, missing tests, and unsafe assumptions             |
| `/pr-review`       | Review current diff or branch like a mobile-friendly code review         |
| `/person`          | View and update people profiles                                          |
| `/review-response` | Triage PR review comments, investigate each finding, and fix properly    |
| `/land-pr`         | Shepherd a PR from open to merged: CI fixes, review cycles, final merge  |
| `/pr-shepherd`     | Persistent PR monitoring: conflicts, CI, reviews, rebase, fix, report    |
| `/plugin`          | Browse, install, and remove skill plugins from marketplaces              |

### Writing custom skills

Create a `.md` file in any of the skill directories:

```markdown
---
name: my-skill
description: What this skill does
allowed-tools:
  - Read
  - Grep
  - Glob
---

Your prompt instructions here. The agent receives this as the user message
when someone types `/my-skill`.
```

### Skill discovery scopes

Skills are discovered from multiple directories with deterministic precedence (first match wins):

1. **Native commands** — built-in (`/skills`)
2. **Repo skills** — `.mitzo/skills/` in the current repo
3. **User skills** — `~/.mitzo/skills/`
4. **Bundled skills** — `skills/` in the Mitzo installation

The `allowed-tools` frontmatter field restricts which tools the agent can use during skill execution. This acts as a ceiling, not a floor: the permission mode still applies on top.

### Skill hot-reload

Skills are watched for filesystem changes. Add, edit, or remove a skill file and it takes effect immediately without restarting the server.

## Session isolation

Every session can run in its own git worktree, providing full filesystem isolation. This means multiple concurrent sessions (from your phone, desktop, or task board) never interfere with each other.

### How it works

1. When a session starts with worktrees enabled, Mitzo creates a new git worktree at `<repo>/.claude/worktrees/<session-id>/` with a branch named `session/<session-id>`.
2. All file reads, writes, and git operations happen within this worktree.
3. The **worktree guard** enforces isolation at the tool level. Write, Edit, and Bash calls targeting paths outside the worktree are denied with a redirect message. Read operations are unrestricted (reference is fine).
4. When the session ends, the worktree is cleaned up. Dirty worktrees (uncommitted changes) are auto-rescued: changes are committed and a draft PR is created so nothing is lost.

### Multi-repo sessions

Configure sibling repos in `.mitzo.json` under the `repos` field. Each repo gets its own worktree per session, all on the same session branch name. This enables cross-repo work (e.g., updating a library and its consumer in the same session) without touching either repo's main branch.

### Stale worktree cleanup

Worktrees older than 96 hours are automatically cleaned up on server startup. Dirty ones are rescued first (committed + PR created).

### Disabling worktrees

Set `WORKTREE_ENABLED=false` in `.env` to run all sessions directly in the repo. Useful for single-user setups where isolation isn't needed.

## Task board

The task board enables complex, multi-step work by decomposing goals into subtasks that can run across multiple agent sessions.

### Concepts

- **Tasks** form a tree. A root task has subtasks, which can have their own subtasks.
- **DFS ordering** determines execution order. Tasks run depth-first, sequentially.
- **Spec mode** pauses after the agent decomposes a task into subtasks, giving you a chance to review and approve the plan before execution begins.
- **Orphan detection** reclaims tasks from sessions that died mid-execution.
- **Cascade status** propagates completion up the tree. When all children complete, the parent auto-completes.

### Using the task board

1. Navigate to the Task Board page from the session list or sidebar.
2. Create a root task with a description of what you want to accomplish.
3. Optionally enable spec mode to review the agent's decomposition before it starts executing.
4. Use the play/pause/stop controls to manage execution.
5. Each subtask runs in its own agent session with full worktree isolation.

### Task board MCP server

The task board is also exposed as an MCP server (`mcp-server/`), enabling external tools and agents to interact with it programmatically via the standard MCP protocol.

### Persistence

Task state is stored in SQLite (`<mitzo-root>/.mitzo/tasks.db`) with WAL mode for concurrent access. Tasks survive server restarts.

## Voice integration

Mitzo integrates with [Yapper](https://github.com/dimakis/yapper) for bidirectional voice I/O. Voice is client-direct (audio goes straight from your phone to Yapper, no server relay).

### Speech-to-text (STT)

- **Push-to-talk** button in the chat input area.
- Hold to record, release to transcribe. The transcription replaces the text input.
- Uses Yapper's Whisper-based STT endpoint.

### Text-to-speech (TTS)

- **Auto-speak toggle** in the voice settings. When enabled, assistant responses are automatically spoken.
- Responses are split at sentence boundaries and synthesized as sequential audio chunks for natural-sounding playback.
- **Voice picker** with voices grouped by language.
- Uses Yapper's Kokoro-based TTS engine.

### Graceful degradation

When Yapper is offline, the voice button is hidden and auto-speak is disabled. The health monitor polls Yapper status and restores voice features when it comes back online. Chat remains fully functional without voice.

### Setup

1. Install and run [Yapper](https://github.com/dimakis/yapper) on the same machine (default port 8700).
2. Mitzo auto-discovers Yapper at `http://localhost:8700` (or set `YAPPER_PROXY_TARGET` in `.env`).
3. The frontend proxies voice API calls through the Mitzo server for Tailscale connectivity.

## iOS app

Mitzo ships with a Capacitor-based iOS native wrapper for home-screen installation, push notifications, and a native app experience.

### Building

```bash
# Build the frontend for iOS
npm run build:ios

# Open in Xcode
npm run open:ios

# Deploy to TestFlight
npm run deploy:ios

# Bump version before a new release
npm run bump:ios
```

### Configuration

The Capacitor config (`frontend/capacitor.config.ts`) defines:
- **App ID**: `com.mitzo.app`
- **Allowed navigation**: `*.ts.net` domains (Tailscale hostnames)
- **Splash screen**: Dark background, no spinner

### Push notifications (APNS)

For native iOS push notifications, configure the APNS environment variables:

```
APNS_KEY_PATH=/path/to/AuthKey.p8
APNS_KEY_ID=your-key-id
APNS_TEAM_ID=your-team-id
APNS_BUNDLE_ID=com.mitzo.app
APNS_PRODUCTION=true
```

Requires an Apple Developer account with a push notification key.

### Session resilience on iOS

iOS aggressively kills background WebSocket connections without firing `onclose`. Mitzo handles this through:

1. **Message snapshots** stored on the server at every `message_end`.
2. **Force-reconnect on foreground** when `readyState` might be stale.
3. **Two-phase closeout**: graceful TTL window before hard abort.

## Push notifications

Mitzo supports three notification channels, used primarily when Claude needs tool approval while your phone is locked or backgrounded.

| Channel    | Platform     | Configuration                        |
| ---------- | ------------ | ------------------------------------ |
| **ntfy**   | Any (HTTP)   | `NTFY_URL`, `NTFY_TOPIC`, `NTFY_AUTH_TOKEN` |
| **Pushover** | Apple Watch | `PUSHOVER_API_TOKEN`, `PUSHOVER_USER_KEY`   |
| **APNS**   | iOS native   | `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID` |

Notifications include deep links back to the session (when `BASE_URL` is configured), so you can tap to jump straight to the pending approval.

## MCP integration

Mitzo reads your MCP (Model Context Protocol) server configuration and passes all configured servers to every agent session.

### Configuration source

By default, Mitzo reads `~/.cursor/mcp.json`. Override with `MCP_CONFIG_PATH` in `.env`.

### How it works

1. On startup, Mitzo loads the MCP config and validates server entries.
2. Each new session receives the full list of MCP servers.
3. The Agent SDK connects to each server and makes its tools available to Claude.
4. MCP tool calls appear as tool pills in the chat UI, just like built-in tools.

### Task board MCP server

Mitzo also provides its own MCP server (`mcp-server/`) that exposes task board operations. This enables external tools (Claude Code CLI, other agents) to create and manage tasks programmatically.

```bash
npm run build:mcp   # build the MCP server
npm run setup-mcp   # install into your MCP config
```

## Observability

Mitzo includes a full observability stack for debugging, performance analysis, and operational monitoring.

### Stack

| Service    | Purpose                         | Port  | Image             |
| ---------- | ------------------------------- | ----- | ------------------ |
| **Jaeger** | Distributed tracing (OTLP)      | 16686 | jaegertracing 2.19 |
| **Loki**   | Log aggregation                  | 3200  | grafana/loki 3.4   |
| **Grafana**| Dashboards and log exploration   | 3002  | grafana 12.4       |
| **MLflow** | Experiment tracking (LLM traces) | 5050  | mlflow 2.22        |

### Starting the stack

```bash
# Jaeger only (lightweight, just tracing)
npm run tracing:up

# Full stack (all four services)
npm run observability:up

# Shutdown
npm run observability:down
```

Requires Docker or Podman. Data is persisted in dotfile directories (`.jaeger-data/`, `.loki-data/`, `.grafana-data/`, `.mlflow-data/`) and survives restarts.

### Logging

- **Structured JSON logs** via Pino with daily file rotation to `logs/`.
- **OTel trace context** is mixed into every log entry (`trace_id`, `span_id`), enabling log-to-trace correlation.
- **Loki integration** ships logs to Grafana Loki when `LOKI_HOST` is set.
- Log levels: `debug`, `info`, `warn`, `error` (configured via `LOG_LEVEL`).

### Tracing

- **OpenTelemetry** with BatchSpanProcessor and OTLP HTTP exporter.
- Spans cover: session lifecycle, query loop turns, tool calls, permission flows, worktree operations.
- Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your Jaeger instance (default: `http://localhost:4318`).
- View traces at `http://localhost:16686` (Jaeger UI), service name: `mitzo`.

### Health monitoring

The built-in health monitor polls dependent services (Yapper, ContexGin) and exposes their status to the frontend via the `useServiceHealth` hook. Service health is visible in the UI and drives graceful degradation (e.g., hiding voice controls when Yapper is down).

## Security

See [SECURITY.md](SECURITY.md) for the full threat model.

### Summary

- **Network**: Designed for Tailscale-only access. All traffic is encrypted via WireGuard. The server does not need to be exposed to the public internet.
- **Authentication**: Passphrase-based login. The server issues an HS256 JWT stored as an HTTP-only cookie.
- **Secrets**: `AUTH_PASSPHRASE` and `AUTH_SECRET` live in `.env`, which is gitignored. They are never logged or sent to the Claude API.
- **MCP credentials**: Read from `~/.cursor/mcp.json` but not exposed through the Mitzo API.
- **HTTPS**: Optional. Tailscale provides encryption. For non-Tailscale deployments, place certificates in `certs/` and the server will use HTTPS automatically.
- **Rate limiting**: Express rate limiter on auth endpoints.
- **Helmet**: Security headers via Express Helmet middleware.
- **Secret scanning**: Pre-commit hook runs gitleaks (when installed) to prevent accidental credential commits.

### Permission model

Tools are classified into four tiers:

| Tier        | Risk level | Examples                              | Auto-allow in mode |
| ----------- | ---------- | ------------------------------------- | ------------------- |
| `safe`      | Low        | Read, Glob, Grep                      | Ask, Agent, Auto    |
| `standard`  | Medium     | Edit, Write                           | Agent, Auto         |
| `elevated`  | High       | Bash, dangerous commands              | Auto only           |
| `unknown`   | Unclassified | New/custom tools                    | Never               |

When a tool requires approval, the user gets:
1. A **permission banner** in the chat UI showing the tool name and arguments.
2. A **push notification** (if configured) so they can approve from a lock screen.

## Deployment

### Production (macOS with launchd)

The `deploy` script builds the project and installs a launchd service for auto-start on boot:

```bash
npm run deploy
```

This:
1. Builds all packages, server, and frontend
2. Installs `com.mitzo.server.plist` to `~/Library/LaunchAgents/`
3. Starts the service (or restarts if already running)
4. Optionally sets up Podman for the observability stack

The server runs on port 3100 by default. Logs go to `logs/`.

### Manual start

```bash
npm run build:all
npm start
```

### Updating

```bash
git pull
npm install
npm run deploy
```

Or use the "Deploy Mitzo" quick action from the home screen (if configured in `.mitzo.json`), which runs `scripts/deploy.sh` via the agent.

### Running behind a reverse proxy

If running behind nginx or similar, ensure WebSocket upgrade headers are forwarded:

```nginx
location / {
    proxy_pass http://localhost:3100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## Development

### Commands

```bash
npm run dev          # backend (tsx watch) + frontend (Vite) concurrently
npm run dev:server   # backend only with file watching
npm test             # vitest full suite
npm test -- --watch  # vitest in watch mode
npm run lint         # eslint (server + frontend)
npm run lint:fix     # eslint with auto-fix
npm run format       # prettier (write)
npm run format:check # prettier (check only)
```

### Pre-commit hooks

Husky + lint-staged + commitlint enforce quality on every commit:

- **lint-staged** runs ESLint and Prettier on staged files only
- **commitlint** enforces [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, etc.)
- **gitleaks** (optional) scans staged changes for secrets. Install via `brew install gitleaks`. The hook skips gracefully when gitleaks is not found.

### Git workflow

- **Never push directly to main.** All work goes through feature branches and pull requests.
- Pre-commit hooks block commits to `main` as a safety net.
- CI must pass before merging.
- Conventional commit messages are required.

### Test-driven development

All feature work follows TDD:

1. **Red** — write a failing test that defines the contract
2. **Green** — implement the minimum code to pass
3. **Refactor** — clean up while keeping tests green
4. **Commit** — tests and implementation go in a single atomic commit

Tests use Vitest. The test suite covers server modules (`server/__tests__/`) and frontend components/hooks (`frontend/src/**/*.test.*`).

### Dev frontend testing

For testing frontend changes against the backend:

1. The Vite dev server runs on a separate port (default: 5173) and proxies API/WS calls to the backend.
2. Backend runs via `tsx watch` with auto-reload on file changes.
3. `npm run dev` starts both concurrently.

### Code style

- TypeScript strict mode
- No semicolons (Prettier config)
- 100-character line width
- Error variables typed as `unknown` with `instanceof` checks
- Conventional commits for all commit messages

## API reference

### REST endpoints

| Method | Path                      | Description                              | Auth     |
| ------ | ------------------------- | ---------------------------------------- | -------- |
| POST   | `/api/auth/login`         | Passphrase login, returns JWT cookie     | No       |
| GET    | `/api/auth/check`         | Verify current JWT                       | Yes      |
| POST   | `/api/auth/logout`        | Clear JWT cookie                         | Yes      |
| GET    | `/api/sessions`           | List sessions (active + recent)          | Yes      |
| POST   | `/api/sessions`           | Create a new session                     | Yes      |
| GET    | `/api/sessions/:id`       | Get session details                      | Yes      |
| DELETE | `/api/sessions/:id`       | Delete a session                         | Yes      |
| POST   | `/api/sessions/:id/abort` | Abort a running session                  | Yes      |
| GET    | `/api/files`              | List files in a directory                | Yes      |
| GET    | `/api/files/read`         | Read file contents                       | Yes      |
| POST   | `/api/files/write`        | Write file contents                      | Yes      |
| GET    | `/api/inbox`              | List inbox items                         | Yes      |
| POST   | `/api/inbox/:id/approve`  | Approve an inbox item                    | Yes      |
| POST   | `/api/inbox/:id/discard`  | Discard an inbox item                    | Yes      |
| GET    | `/api/health`             | Server health check                      | No       |
| GET    | `/api/version`            | Server version info                      | No       |

### WebSocket protocol

Connect to `/ws` with a JWT cookie. The v2 protocol uses a multiplexed WebSocket with session routing.

**Client to server:**

| Message type      | Purpose                            |
| ----------------- | ---------------------------------- |
| `hello`           | Initial handshake with client ID   |
| `chat`            | Send a user message                |
| `permission`      | Respond to a tool approval request |
| `interrupt`       | Cancel the current turn            |
| `session_switch`  | Switch to a different session      |

**Server to client:**

| Message type       | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `welcome`          | Handshake acknowledgment                         |
| `message_start`    | Beginning of an assistant turn                   |
| `block_start`      | Beginning of a content block (text, tool, think) |
| `block_delta`      | Incremental content within a block               |
| `block_end`        | End of a content block                           |
| `tool_result`      | Result of a tool call                            |
| `message_end`      | End of an assistant turn                         |
| `message_snapshot` | Full message state for reconnect recovery        |
| `session_end`      | Session terminated                               |
| `permission_request` | Tool needs approval                            |
| `error`            | Error message                                    |

See [docs/design/message-protocol-v2.md](docs/design/message-protocol-v2.md) for the complete protocol specification.

## Design docs

Detailed design documents for major features live in `docs/design/`:

| Document                                 | Topic                                             |
| ---------------------------------------- | ------------------------------------------------- |
| `message-protocol-v2.md`                 | v2 WebSocket block lifecycle protocol              |
| `global-task-board.md`                   | Task board architecture and state machine          |
| `task-board-phase1-plan.md`              | Task board phase 1: persistence and tree structure |
| `task-board-phase2-plan.md`              | Task board phase 2: orchestration and MCP          |
| `session-isolation-overhaul.md`          | Session isolation architecture overhaul            |
| `session-isolation-counter-proposal.md`  | Alternative session isolation design               |
| `session-isolation-phase2-handoff.md`    | Session isolation phase 2 handoff notes            |
| `session-state-machine.md`              | Session lifecycle state transitions                |
| `skills-system-v1-plan.md`              | Skills system architecture                         |
| `voice-integration.md`                   | Voice I/O (STT + TTS) design                      |
| `streaming-stt.md`                       | Streaming speech-to-text design                    |
| `tts-playback.md`                        | TTS playback and chunking strategy                 |
| `streaming-input-session-control.md`     | Streaming input and session control flow            |
| `otel-deep-instrumentation.md`           | OpenTelemetry instrumentation plan                 |
| `context-blocks.md`                      | Context block injection design                     |
| `token-visibility.md`                    | Token usage visibility in the UI                   |
| `boot-context-pill-ux-fixes.md`          | Boot context UX improvements                       |
| `phase-a-test-harness.md`               | Test harness architecture                          |

Additional docs:
- [docs/onboarding.md](docs/onboarding.md) — Setup and configuration walkthrough
- [docs/briefing-api-spec.md](docs/briefing-api-spec.md) — Briefing API specification
- [docs/conversational-send-spec.md](docs/conversational-send-spec.md) — Conversational send protocol

## Troubleshooting

### Server won't start

- **Port already in use**: Another instance may be running. Check with `lsof -i :3100`. The server includes port-check logic to prevent duplicates.
- **Missing `.env`**: Copy `.env.example` to `.env` and set the required variables.
- **Node version**: Requires Node.js 20+. Check with `node --version`.

### WebSocket disconnects

- **Phone going to sleep**: Expected behavior. The session detaches and reattaches when you return. If messages are missing, the server sends a message snapshot on reconnect.
- **Tailscale not connected**: Verify Tailscale is running on both server and client. Check with `tailscale status`.

### Worktree issues

- **Worktree creation fails**: Run `git worktree list` in the repo to check for conflicts. Stale worktrees from crashed sessions can block creation.
- **Stale worktrees accumulating**: Run `git worktree prune` in the affected repo, or restart the server (it cleans up stale worktrees on startup).
- **Data files missing in worktree**: Expected. Worktrees don't include gitignored files like `.venv/`, parquet data, or `node_modules/` (for non-workspace repos). Symlink or copy as needed.

### Voice not working

- **Yapper not running**: Start Yapper on the server. Mitzo auto-discovers it at `http://localhost:8700`.
- **Voice button missing**: The health monitor hides voice controls when Yapper is offline. Check `http://localhost:8700/health`.
- **Audio not playing**: Check browser audio permissions. TTS requires the page to have been interacted with (browser autoplay policy).

### iOS app issues

- **Build fails**: Ensure Xcode 15+ is installed. Run `npm run build:ios` before `npm run open:ios`.
- **Push notifications not arriving**: Verify APNS configuration in `.env`. Check that the `.p8` key file exists at `APNS_KEY_PATH`.
- **App shows blank screen after deploy**: The iOS app bundles the frontend locally. After a server-side frontend change, you need to rebuild and redeploy the iOS app.

### Observability stack

- **Jaeger UI not loading**: Check that Docker/Podman is running. Run `npm run tracing:up` and wait for the container to start.
- **No traces appearing**: Verify `OTEL_EXPORTER_OTLP_ENDPOINT` is set in `.env`. Default: `http://localhost:4318`.
- **Logs not appearing in Grafana**: Set `LOKI_HOST` in `.env` and restart the server. Default: `http://localhost:3200`.

## Tech stack

| Layer          | Technology                                                                  |
| -------------- | --------------------------------------------------------------------------- |
| Runtime        | Node.js 20+                                                                |
| Language       | TypeScript 5.9 (strict mode)                                               |
| Backend        | Express 4, WebSocket (ws)                                                  |
| AI             | Claude Agent SDK, Anthropic SDK, Vertex AI SDK (optional)                  |
| Frontend       | React 19, Vite, Zustand, React Router                                      |
| Mobile         | Capacitor (iOS native wrapper)                                             |
| Database       | SQLite (better-sqlite3) with WAL mode                                      |
| Auth           | JWT (jose), passphrase, HTTP-only cookies                                  |
| MCP            | @modelcontextprotocol/sdk                                                  |
| Validation     | Zod 4                                                                      |
| Logging        | Pino with daily rotation, Loki transport                                   |
| Tracing        | OpenTelemetry, Jaeger, MLflow                                              |
| Dashboards     | Grafana                                                                    |
| Notifications  | ntfy, Pushover, Apple Push Notification Service                            |
| Testing        | Vitest, supertest, jsdom                                                   |
| Code quality   | ESLint 9, Prettier, commitlint, lint-staged, husky, gitleaks               |
| Build          | tsc (server), Vite (frontend), npm workspaces                              |
| Deployment     | launchd (macOS), Docker/Podman (observability)                             |

## Attribution

Evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center) by [Afstkla](https://github.com/Afstkla). The original used tmux to manage Claude Code sessions; Mitzo replaced that with the Agent SDK for direct programmatic control, and has since grown into a full mobile command center with session isolation, multi-session orchestration, voice, skills, observability, and an iOS native app.

## License

MIT
