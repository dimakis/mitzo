# Mitzo Onboarding

Everything you need to go from a fresh clone to Claude Code on your phone, laptop, and Apple Watch. This guide covers the full stack: server, mobile, desktop, iOS app, voice, task board, observability, and multi-repo workflows.

## What is Mitzo?

Mitzo is a self-hosted web UI for Claude Code. It runs on your Mac, you access it from your phone (or laptop) over Tailscale. Built on the [Anthropic Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) — same engine as Claude Code, different interface.

What you get:

- **Streaming chat** with thinking blocks, tool use pills, and markdown rendering
- **Three permission modes** — Ask (read-only), Agent (file edits), Auto (shell access)
- **Session isolation** — every chat gets its own git worktree, preventing cross-session contamination
- **Slash-command skills** — reusable workflows (`/simplify`, `/pr-review`, `/risk-scan`, `/person`, `/review-response`, `/land-pr`, `/pr-shepherd`)
- **Task board** — drop a goal, Claude decomposes it into subtasks and executes across sessions
- **File browser** — view and edit repo files, switch between worktree roots
- **Voice** — push-to-talk STT and auto-speak TTS via [Yapper](https://github.com/dimakis/yapper)
- **Push notifications** — ntfy (Android/desktop) and Pushover (iOS/Apple Watch) when Claude needs approval
- **iOS native app** — Capacitor wrapper with push notifications and home-screen install
- **Desktop mode** — side-by-side chat + file viewer on laptop screens
- **Quick actions** — one-tap commands customized per repo
- **Session persistence** — phone sleeps, session survives, resume where you left off
- **MCP integration** — reads your Cursor MCP config, passes servers to every session
- **Observability** — OpenTelemetry tracing (Jaeger) + structured logging (Loki/Grafana)

## Prerequisites

```bash
node --version    # 20+ required
npm --version     # comes with Node
git --version     # you have this
claude --version  # Claude Code CLI
```

| Tool        | Install                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| Node.js 20+ | `brew install node@22` or [nodejs.org](https://nodejs.org)                           |
| Claude Code | `npm install -g @anthropic-ai/claude-code` then `claude` to authenticate             |
| Tailscale   | `brew install tailscale` or [tailscale.com/download](https://tailscale.com/download) |

You need an active Claude Code subscription (Claude Max or API key). The Agent SDK authenticates through the same credentials as the `claude` CLI.

## Step 1: Clone and install

```bash
cd ~/tools  # or wherever you keep personal tools
git clone https://github.com/dimakis/mitzo.git
cd mitzo
npm install
cd frontend && npm install && cd ..
```

## Step 2: Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set the three required values:

```bash
AUTH_PASSPHRASE=pick-something-memorable
AUTH_SECRET=replace-with-a-random-string-at-least-32-chars
REPO_PATH=/absolute/path/to/your/main/repo
```

Generate a secret with `openssl rand -hex 32` and paste the output as `AUTH_SECRET`.

### Required variables

| Variable          | Description                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PASSPHRASE` | The password you type to log in from your phone                                                                                             |
| `AUTH_SECRET`     | JWT signing key (min 32 chars). Generate with `openssl rand -hex 32`                                                                        |
| `REPO_PATH`       | Default repo for Claude sessions (absolute path). This is where Claude starts — file browser, quick actions, and new chats all default here |

### Optional variables

| Variable                      | Default                 | Description                                                                       |
| ----------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `PORT`                        | `3100`                  | Server port                                                                       |
| `WORKTREE_ENABLED`            | `true`                  | Git worktree isolation per session                                                |
| `MCP_CONFIG_PATH`             | `~/.cursor/mcp.json`    | MCP server config location                                                        |
| `LOG_LEVEL`                   | `info`                  | Log verbosity: `debug`, `info`, `warn`, `error`                                   |
| `COOKIE_MAX_AGE_HOURS`        | `24`                    | JWT cookie lifetime                                                               |
| `BASE_URL`                    | —                       | Public URL for notification deep links (e.g. `https://<tailscale-hostname>:3100`) |
| `NTFY_URL`                    | `https://ntfy.sh`       | ntfy server URL                                                                   |
| `NTFY_TOPIC`                  | —                       | ntfy topic for push notifications                                                 |
| `NTFY_AUTH_TOKEN`             | —                       | ntfy auth token (if using private topic)                                          |
| `PUSHOVER_API_TOKEN`          | —                       | Pushover API token (for Apple Watch)                                              |
| `PUSHOVER_USER_KEY`           | —                       | Pushover user key                                                                 |
| `YAPPER_PROXY_TARGET`         | `http://localhost:8700` | Yapper backend URL for voice                                                      |
| `CLAUDE_CODE_USE_VERTEX`      | —                       | Set to `1` for Vertex AI auto-rename                                              |
| `ANTHROPIC_VERTEX_PROJECT_ID` | —                       | GCP project ID (with Vertex)                                                      |
| `CLOUD_ML_REGION`             | `us-east5`              | GCP region for Vertex                                                             |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —                       | OTLP endpoint for tracing (e.g. `http://localhost:4318`)                          |
| `LOKI_HOST`                   | —                       | Loki endpoint for log aggregation                                                 |
| `MLFLOW_TRACKING_URI`         | —                       | MLflow endpoint for experiment tracking (e.g. `http://localhost:5050`)            |
| `CONTEXGIN_URL`               | `http://localhost:8321` | ContexGin goal registry URL                                                       |

## Step 3: Generate HTTPS certificate

Mitzo runs over HTTPS so that iOS features (push notifications, clipboard, camera) work correctly over Tailscale.

```bash
# Get your Tailscale hostname
tailscale status | head -1

# Generate a self-signed cert for it
bash scripts/generate-cert.sh <your-hostname>.tailnet.ts.net
```

This creates `certs/key.pem` and `certs/cert.pem`. The server picks them up automatically on start.

> **Tip:** On iOS, you'll need to trust the certificate. Open `https://<your-hostname>:3100` in Safari, tap through the warning, then go to Settings > General > About > Certificate Trust Settings and enable it.

## Step 4: Build and deploy

### Quick start (terminal)

```bash
npm run build:all  # Build server + frontend
npm start          # Start server
```

You should see:

```
Mitzo listening on https://0.0.0.0:3100
```

### Persistent deployment (recommended)

For Mitzo to survive terminal closes and reboots, deploy it as a macOS launchd service:

```bash
npm run deploy
```

This does four things:

1. Compiles TypeScript server to `dist/`
2. Builds the React frontend
3. Installs a launchd plist to `~/Library/LaunchAgents/com.mitzo.server.plist`
4. Sets up a podman machine for the observability stack (Jaeger/Grafana/Loki/MLflow)

Manage the service:

```bash
# Check status
launchctl list | grep mitzo

# View logs
tail -f logs/server-stdout.log

# Restart after changes
npm run deploy
```

## Step 5: Access from your phone

1. **Install Tailscale** on both your Mac and phone
2. **Sign in** with the same account on both devices
3. **Find your Mac's Tailscale hostname**: `tailscale status | head -1`
4. Open `https://<your-tailscale-hostname>:3100` on your phone
5. Log in with your `AUTH_PASSPHRASE`

**Add to home screen:** In Safari, tap Share > Add to Home Screen. It behaves like a native app with full-screen display.

No port forwarding, no public DNS, no cloud hosting. Tailscale encrypts everything via WireGuard tunnels.

## Step 6: First session

### Start a chat

Tap **Chat** on the home screen. Type a message. Claude responds with streaming output — thinking blocks collapse, tool use shows as interactive pills, markdown renders inline.

### Permission modes

Switch modes via the selector in the chat header:

| Mode      | What Claude can do                                                 |
| --------- | ------------------------------------------------------------------ |
| **Ask**   | Read files only. Safe for exploration and questions.               |
| **Agent** | Read + write files + shell. Only prompts for unknown tools (MCP).  |
| **Auto**  | Full access including shell. Only prompts for unknown tools (MCP). |

Start in Ask to explore. Switch to Agent when you're ready to make changes.

### Tool permission tiers

Behind the scenes, every tool has a risk tier:

| Tier         | Examples         | Ask        | Agent      | Auto       |
| ------------ | ---------------- | ---------- | ---------- | ---------- |
| **Safe**     | Read, Glob, Grep | Auto-allow | Auto-allow | Auto-allow |
| **Standard** | Edit, Write      | Prompt     | Auto-allow | Auto-allow |
| **Elevated** | Bash             | Prompt     | Auto-allow | Auto-allow |
| **Unknown**  | MCP tools        | Prompt     | Prompt     | Prompt     |

You can override tiers in `.mitzo.json` (see below).

### Browse files

Tap **Files** to browse your repo. Markdown files have an Edit button for quick edits from your phone. If worktrees are enabled, you'll see a branch pill showing the current branch and a selector to switch between worktree roots.

### Desktop mode

On a laptop screen (wide viewport), Mitzo switches to a side-by-side layout with chat on the left and file viewer on the right.

## Configuring your repo (`.mitzo.json`)

Drop a `.mitzo.json` file in your `REPO_PATH` root to customize everything. Here's a full example:

```json
{
  "quickActions": [
    {
      "label": "Status Check",
      "desc": "What needs my attention",
      "prompt": "Check the current state of the repo and summarize what needs attention.",
      "extraTools": "Bash"
    },
    {
      "label": "Run Tests",
      "desc": "Full suite",
      "prompt": "Run tests and report results.",
      "extraTools": "Bash"
    },
    {
      "label": "Deploy",
      "desc": "Pull, build, restart",
      "prompt": "Run the deploy script and report the result.",
      "extraTools": "Bash"
    }
  ],
  "roots": [
    { "label": "Main", "path": "/Users/you/projects/main-repo" },
    { "label": "Tooling", "path": "/Users/you/projects/tooling" }
  ],
  "repos": {
    "sibling": "/Users/you/projects/sibling-repo",
    "shared-lib": "/Users/you/projects/shared-lib"
  },
  "allowedPaths": ["/Users/you/projects", "/Users/you/tools"],
  "contextBlocks": {
    "Team Structure": "/Users/you/docs/team.md",
    "Architecture": "/Users/you/docs/architecture.md"
  },
  "venvPaths": [".venv/bin"],
  "toolTierOverrides": {
    "mcp__jira__jira_search": "safe",
    "mcp__jira__jira_get_issue": "safe"
  }
}
```

### Quick actions

One-tap buttons on the home screen. Each starts a chat with the given prompt.

| Field        | Required | Description                                                        |
| ------------ | -------- | ------------------------------------------------------------------ |
| `label`      | Yes      | Button text                                                        |
| `desc`       | Yes      | Subtitle under the button                                          |
| `prompt`     | Yes      | The prompt sent to Claude                                          |
| `extraTools` | No       | Additional tools to allow (e.g. `"Bash"`)                          |
| `cwd`        | No       | Working directory override (relative to `REPO_PATH`)               |
| `path`       | No       | Navigate to a page instead of starting a chat (e.g. `"/calendar"`) |

If you find yourself typing the same prompt more than twice, make it a quick action.

### Roots (file browser navigation)

```json
"roots": [
  { "label": "Main", "path": "/Users/you/projects/main-repo" },
  { "label": "Tooling", "path": "/Users/you/projects/tooling" }
]
```

Roots appear as tabs in the file browser, letting you switch between repos without restarting. The first root is the default.

### Repos (multi-repo worktree isolation)

```json
"repos": {
  "sibling": "/Users/you/projects/sibling-repo",
  "shared-lib": "/Users/you/projects/shared-lib"
}
```

When worktree isolation is enabled, every session creates a git worktree for each repo listed here (plus your primary `REPO_PATH`). This means Claude can work across multiple repos in a single session, each isolated to its own branch. Paths must be absolute and point to existing git repos.

### Allowed paths

```json
"allowedPaths": ["/Users/you/projects", "/Users/you/tools"]
```

By default Claude can only access files under `REPO_PATH`. Add directories here to grant access to sibling repos, shared tooling, or config files. These are additive — `REPO_PATH` is always accessible.

### Context blocks (domain knowledge)

```json
"contextBlocks": {
  "Team Structure": "/Users/you/docs/team.md",
  "Workflow": "/Users/you/docs/workflow.md"
}
```

Markdown files injected into every Claude session as reference material. This is how you give Claude persistent domain knowledge — org structure, project conventions, architecture docs — without repeating yourself.

Files are read at session start. They can live anywhere on your filesystem.

### Python virtual environments

```json
"venvPaths": [".venv/bin"]
```

Paths relative to `REPO_PATH`. Resolved and prepended to `PATH` so Claude sessions have the right Python and packages.

### Tier overrides

```json
"toolTierOverrides": {
  "mcp__jira__jira_search": "safe",
  "mcp__jira__jira_get_issue": "safe"
}
```

Override the default risk tier for any tool. MCP tools default to `unknown` (always prompted). If you trust a tool, promote it to `safe` or `standard` to skip the approval prompt.

Tiers: `safe`, `standard`, `elevated`, `unknown`.

## Session isolation (worktrees)

Every Mitzo session gets its own git worktree — an isolated copy of the repo on a dedicated branch. This prevents sessions from stepping on each other's changes.

### How it works

- **Worktree path:** `<repo>/.claude/worktrees/<session-id>/`
- **Branch:** `session/<session-id>`
- **Multi-repo:** if `repos` is configured in `.mitzo.json`, all listed repos get worktrees too
- **Env vars:** `MITZO_SESSION_ID` + `MITZO_REPO_<NAME>` are set for every repo

### Write enforcement

The worktree guard (`checkWorktreePolicy()`) inspects every Write, Edit, and Bash tool call. If Claude tries to write outside the worktree paths, the call is denied with a redirect message. Read operations are unrestricted — Claude can always reference the main repo for context.

### Cleanup

Stale worktrees (older than 96 hours) are cleaned up automatically on server startup. Worktrees with uncommitted changes are flagged rather than deleted.

### Disabling

Set `WORKTREE_ENABLED=false` in `.env` to disable isolation entirely. Sessions will work directly on the main repo.

## Skills

Skills are reusable prompt packages invoked via `/slash-command` in chat.

### Bundled skills

| Skill              | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `/simplify`        | Code review focused on reducing complexity and duplication                 |
| `/risk-scan`       | Security-oriented audit — failure modes, missing tests, unsafe assumptions |
| `/pr-review`       | Review a pull request (diff/branch analysis)                               |
| `/person`          | People profile lookup and update                                           |
| `/review-response` | Triage and fix PR review comments                                          |
| `/land-pr`         | Land a PR — rebase, squash, merge                                          |
| `/pr-shepherd`     | Persistent PR lifecycle monitoring                                         |

Type `/` in the chat input to browse available skills with descriptions.

### Custom skills

Create your own by adding markdown files with YAML frontmatter:

- **Repo-scoped:** `.mitzo/skills/my-skill.md` (in your repo, available in that repo only)
- **User-scoped:** `~/.mitzo/skills/my-skill.md` (available in all repos)

```markdown
---
name: deploy
description: Deploy to staging or production
allowed-tools: [Bash, Read]
arguments:
  - name: environment
    description: Target environment
    required: true
---

Deploy the application to the {{environment}} environment.
Run the deployment script and report the result.
```

Invoke with `/deploy staging`.

### Skill precedence

Resolution order: Native > Repo > User > Bundled. If two skills share a name, the higher-precedence one wins. The `/` picker shows collision notes when this happens.

`allowed-tools` in frontmatter acts as a ceiling — it can restrict what Claude can do during the skill, but never expand beyond the current mode's permissions.

## Task board

The task board lets you drop a high-level goal and have Claude decompose it into subtasks, then execute them sequentially across sessions.

### How to use it

1. Navigate to the **Task Board** from the home screen
2. Create a goal (e.g. "Add dark mode support")
3. Start the loop — Claude decomposes the goal into subtasks
4. **Spec mode** (optional): Claude proposes subtasks, pauses for your approval before executing
5. Claude picks up tasks one by one, marks them complete, moves to the next

### Key concepts

- Tasks form a tree (parent/child hierarchy)
- Status cascade: if a child fails, the parent reflects it
- Orphan detection: if a session dies, its active tasks get reclaimed to `pending`
- Loop controls: start, pause, resume, stop from the UI
- Task context is injected into Claude's system prompt so it knows what it's working on

### REST API

| Endpoint                      | Description                       |
| ----------------------------- | --------------------------------- |
| `GET /api/tasks`              | List all tasks                    |
| `POST /api/tasks`             | Create a task                     |
| `POST /api/loop/start`        | Start the orchestration loop      |
| `POST /api/loop/pause`        | Pause execution                   |
| `POST /api/loop/resume`       | Resume execution                  |
| `POST /api/loop/stop`         | Stop the loop                     |
| `POST /api/tasks/:id/approve` | Approve a spec-mode decomposition |
| `POST /api/tasks/:id/reject`  | Reject and re-plan                |

## Voice (optional)

Voice requires [Yapper](https://github.com/dimakis/yapper), a local voice service providing Whisper STT and Kokoro TTS.

### Setup

1. Clone and start Yapper:

   ```bash
   cd ~/projects
   git clone https://github.com/dimakis/yapper.git
   cd yapper
   # Follow Yapper's setup instructions
   ```

2. Yapper runs on port 8700 by default. If you changed it, set `YAPPER_PROXY_TARGET` in `.env`.

3. Restart Mitzo. Voice features appear automatically when Yapper is reachable — a microphone button for push-to-talk and a speaker toggle for auto-speak.

Voice degrades gracefully. If Yapper goes offline, voice controls hide and chat continues as normal.

## Push notifications

Get notified when Claude needs permission approval. Two providers, use either or both.

### ntfy (Android / desktop / any platform)

1. Install [ntfy](https://ntfy.sh) on your phone
2. Pick a unique topic name (e.g. `mitzo-yourname`)
3. Add to `.env`:

   ```bash
   NTFY_TOPIC=mitzo-yourname
   BASE_URL=https://<your-tailscale-hostname>:3100
   ```

4. Restart Mitzo (`npm run deploy`)

Notifications include a deep link back to the permission prompt.

### Pushover (iOS / Apple Watch)

1. Install [Pushover](https://pushover.net) on your iPhone
2. Create an application in the Pushover dashboard to get an API token
3. Add to `.env`:

   ```bash
   PUSHOVER_API_TOKEN=your-app-token
   PUSHOVER_USER_KEY=your-user-key
   BASE_URL=https://<your-tailscale-hostname>:3100
   ```

4. Restart Mitzo

Pushover notifications appear on your Apple Watch with a tap to open the approval prompt.

## iOS app (optional)

Mitzo has a native iOS wrapper via Capacitor, with Apple Watch companion for notifications.

### Build and install via TestFlight

```bash
# Build the web app for iOS
npm run build:ios

# Open in Xcode
npm run open:ios

# Or deploy directly to TestFlight
npm run deploy:ios
```

### Xcode setup

1. Open `frontend/ios/App/App.xcodeproj` in Xcode
2. Set your development team in Signing & Capabilities
3. Configure push notification entitlement (for APNs)
4. Build and run on your device, or archive for TestFlight

### Version management

```bash
npm run bump:ios   # Increment build number
```

The iOS app provides native push notifications, proper home-screen icon, and full-screen display without Safari chrome.

## MCP integration

Mitzo reads your Cursor MCP config (`~/.cursor/mcp.json` by default, or `MCP_CONFIG_PATH`) and passes those servers to every Claude session. If you have Jira, GitLab, Slack, or other MCP servers configured in Cursor, they work in Mitzo automatically.

The home screen shows which MCP servers are connected. Tool calls to MCP servers show up as tool pills in chat, just like built-in tools.

MCP tools default to the `unknown` tier (always prompted). Use `toolTierOverrides` in `.mitzo.json` to promote trusted tools.

## Observability (optional)

Mitzo includes a local observability stack for debugging and performance analysis.

### Components

| Service | URL                    | Purpose                            |
| ------- | ---------------------- | ---------------------------------- |
| Jaeger  | http://localhost:16686 | Trace viewer                       |
| Grafana | http://localhost:3002  | Log viewer + dashboards (no login) |
| Loki    | http://localhost:3200  | Log aggregation backend            |
| MLflow  | http://localhost:5050  | Experiment tracking                |

### Quick start

```bash
# Jaeger only (traces)
npm run tracing:up

# Full stack (traces + logs + dashboards)
npm run observability:up

# Tear down
npm run observability:down
```

Requires podman (`brew install podman`) or Docker.

### Enable tracing

Add to `.env`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
LOKI_HOST=http://localhost:3200
```

Restart Mitzo. Traces appear in Jaeger under service `mitzo`. Logs appear in Grafana — query `{app="mitzo"}` in Explore.

Log-to-trace correlation is automatic: Grafana parses `trace_id` from log lines and links directly to Jaeger traces.

## Claude Code / Cursor integration

Mitzo can create worktrees for Claude Code and Cursor sessions too, not just its own. This is done via hooks that call `POST /api/sessions` at session start.

### How it works

1. On startup, Mitzo generates an internal token and persists it to `~/.mitzo/internal-token`
2. A `SessionStart` hook in your repo's `.claude/hooks/` or `.cursor/hooks/` reads this token
3. The hook calls `POST /api/sessions` to create worktrees for all configured repos
4. Claude Code/Cursor sessions get the same isolation as Mitzo sessions

This means all your AI tools — Mitzo, Claude Code, Cursor — share the same worktree infrastructure and the same `.mitzo.json` repo configuration.

## Updating

```bash
cd ~/tools/mitzo
git pull --ff-only origin main
npm install
cd frontend && npm install && cd ..
npm run deploy
```

The deploy script rebuilds everything and restarts the launchd service. Your sessions and configuration are preserved.

## Troubleshooting

| Problem                         | Fix                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `claude: command not found`     | Install Claude Code: `npm install -g @anthropic-ai/claude-code`                    |
| Port 3100 already in use        | Change `PORT` in `.env`, or check `lsof -i :3100` for the existing process         |
| Can't connect from phone        | Verify Tailscale is running on both devices: `tailscale status`                    |
| HTTPS certificate not trusted   | On iOS: Settings > General > About > Certificate Trust Settings > enable your cert |
| Session hangs on start          | Verify `claude` works standalone: run `claude` in your terminal                    |
| Permission errors on file edits | Switch to Agent or Auto mode (Ask mode is read-only)                               |
| Phone disconnects lose messages | Normal — Mitzo auto-recovers. Messages buffer and replay on reconnect              |
| Voice controls don't appear     | Check Yapper is running: `curl http://localhost:8700/health`                       |
| Notifications not arriving      | Verify `BASE_URL` is set in `.env` and the topic/credentials are correct           |
| Worktree creation fails         | Run `git worktree list` to check for conflicts, clean stale worktrees              |
| `npm run deploy` fails          | Check `logs/server-stderr.log` for details                                         |
| Podman machine won't start      | Run `podman machine stop && podman machine start` manually                         |

## Architecture

```
Phone / Laptop (Tailscale)
    │
    ├── HTTPS: REST API (Express)
    └── WSS: v2 streaming protocol
        │
    Your Mac (Node.js + TypeScript)
        │
        ├── Anthropic Agent SDK
        │   └── query-loop: SDK events → v2 block protocol
        ├── Session registry (detach/reattach/snapshot recovery)
        ├── Worktree manager (multi-repo git isolation)
        ├── Task orchestrator (goal decomposition + execution)
        ├── Skill registry (bundled + user + repo scoped)
        ├── MCP servers (from Cursor config)
        ├── Hook bridge (project hooks → SDK)
        ├── Event store (SQLite, session replay)
        ├── Push notifications (ntfy + Pushover)
        └── Passphrase + JWT auth

    Observability (optional, podman)
        ├── Jaeger (OTLP traces)
        ├── Loki (log aggregation)
        ├── Grafana (dashboards)
        └── MLflow (experiment tracking)
```

The server translates raw SDK stream events into a v2 block lifecycle protocol (`block_start` > `block_delta` > `block_end`). Sessions survive WebSocket disconnects — when your phone reconnects, it reattaches and replays from a snapshot.

## Development

If you want to contribute or hack on Mitzo:

```bash
npm run dev          # Backend + frontend concurrently (hot reload)
npm test             # Vitest (full suite)
npm run lint         # ESLint
npm run format:check # Prettier
```

Pre-commit hooks (husky + lint-staged) enforce lint, format, conventional commits, and optional gitleaks secret scanning.

**All work goes through branches and PRs.** Never commit directly to main — a pre-commit hook enforces this.

See [CLAUDE.md](../CLAUDE.md) for full development conventions including TDD requirements.
