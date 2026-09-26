# Mitzo

Claude Code on your phone. A self-hosted web UI built on the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), designed for mobile over [Tailscale](https://tailscale.com).

<!-- ![Home Screen](docs/screenshots/home.png) -->
<!-- ![Chat with Tools](docs/screenshots/chat-tools.png) -->

## Features

- **Streaming chat** with thinking blocks, tool pills, and markdown
- **Live token usage** — the chat token bar shows context and session totals for OpenAI Responses turns after the provider reports usage at completion.
- **Three modes** — Ask (read-only), Agent (file edits allowed), Auto (shell too). Switch mid-chat.
- **Slash-command skills** — `/simplify`, `/risk-scan`, `/pr-review`, `/person`, `/review-response`, `/land-pr`, `/pr-shepherd`. Type `/` to browse.
- **Native deliberation** — `/deliberate <task>` runs an Opus/Gemini debate with durable command admission. Repeated delivery does not repeat provider calls. If an attempt ends with an uncertain outcome, review the conversation before explicitly starting another with `/deliberate --confirm-ambiguous <task>`; this may repeat provider work. `/deliberate` alone shows usage.
- **Native fusion** — `/fuse <task>` runs a parallel panel, judge, and synthesis with durable admission; `/fuse --self <task>` uses two independent slots of the same model. Exact retries do not repeat provider work. Uncertain panel outcomes stop later phases; explicitly start another attempt with `/fuse --confirm-ambiguous <task>` (retain `--self` when applicable). Usage-only commands make no provider calls. See [fusion admission](docs/design/fusion-admission.md).
- **Voice** — push-to-talk input (STT) and explicit per-message read-aloud (TTS) via [Yapper](https://github.com/dimakis/yapper). Graceful degradation when offline.
- **MCP tools** — reads `~/.cursor/mcp.json`, passes servers to every session
- **File browser** — view and edit repo files, generated session artifacts, and worktree roots; artifact links stay scoped to the session workspace that created them
- **HTML artifacts** — preview and edit self-contained `.html` prototypes from Files or expandable chat links in a sandboxed, no-network renderer
- **Task board** — recursive multi-session task orchestration with spec mode, completion summaries, and verification hooks
- **Durable Telos capture** — agents can create approved outcomes in live Telos; OpenShell sessions execute the write through a trusted host tool so credentials and persistence stay outside the sandbox
- **Worktree sandbox** — opt-in git worktree isolation per session, multi-repo support via `.mitzo.json`
- **Session resilience** — phone sleeps, WS drops, session survives. Reattach on reconnect. Message snapshot recovery for iOS silent drops.
- **Durable inactivity closeout** — automatic closeout is admitted once per detach episode before runtime dispatch. Exact retries and restart recovery never repeat paid provider work. See [closeout admission](docs/design/closeout-admission.md).
- **Closeout live canary** — an opt-in Luna-only harness validates one durable closeout attempt against an isolated controller and explicit billing account. See [closeout live canary](docs/operations/closeout-live-canary.md).
- **iOS app** — native wrapper via Capacitor with push notifications and home-screen install
- **Auto-rename sessions** — sessions get meaningful names via LLM summarization after every few prompts
- **Quick actions** — one-tap commands via `.mitzo.json`
- **Push notifications** — ntfy + Pushover (Apple Watch) when Claude needs approval
- **Image attachments** — send photos/screenshots from your camera
- **Session history** — resume past conversations, swipe to dismiss
- **Managed Connections** — attach reviewed Jira, GitHub, and bounded custom REST providers to eligible accounts; publish GitHub pull requests through an approved controller operation

## Quick start

```bash
git clone https://github.com/dimakis/mitzo.git && cd mitzo
npm install
cp .env.example .env  # set AUTH_PASSPHRASE, AUTH_SECRET, REPO_PATH
npm run build && npm start
# http://localhost:3100
```

Access from your phone: install [Tailscale](https://tailscale.com/download) on server and phone, then open `http://<tailscale-ip>:3100`. No HTTPS needed — Tailscale encrypts via WireGuard.

### Managed Connections

Connections are optional and require the reviewed OpenShell gateway setup. Enable `MITZO_CONNECTIONS_ENABLED=1` and configure the provider probe policies from [`infra/openshell/production.env.example`](infra/openshell/production.env.example). The [Connections acceptance guide](docs/connections-live-acceptance.md) lists the gateway requirements and checks to run before enabling providers in production.

Open **More → Connections** to choose a provider, enter its one-shot credential, review the exact scope, and assign eligible accounts. For GitHub, enter the repositories as `owner/repository` pairs and the allowed base branches. The GitHub sandbox provider remains read-only. Publishing a committed feature branch and creating or updating a pull request uses the separate `github.publish-pr` operation with an explicit approval. Set a controller-only `GH_TOKEN` or `GITHUB_TOKEN` to enable that operation; it is never injected into the sandbox. Custom REST is an advanced, bounded provider and remains unavailable until its reviewed gateway probe and DNS policy are configured.

After a connection is verified, expand **Manage capability grants** on its card, select the assigned profiles allowed to request a reviewed capability, and save the grant. Reauthorization is required to save or revoke a grant. A grant permits a profile to request the action; each invocation still needs explicit approval and is recorded in the capability operation audit. The setup wizard enables no mutation capability on its own.

If the service template catalog is temporarily unavailable, existing connections remain manageable. You can test, revoke, or rotate their credentials; new connection setup resumes when the catalog is available again. Credential rotation uses nonsecret form metadata returned with each existing connection, so it does not depend on loading the setup catalog.

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

The [durable child session allocation design](docs/design/session-service-core.md) describes the SessionService foundation for future bounded Task Board workers and Symposium seats. It records a child conversation and its parent/grant link in one transaction before runtime setup, fences cancellation across descendants, and retains uncertain starts or missing results for recovery. This foundation does not yet change the current Task Board or Symposium runtime paths.

### Symposium director and portable profiles

The mobile and desktop ChatViews include **Director controls** for the Symposium
roster and directed-delivery approval. Use **Refresh director status** to load
newly queued deliveries while the panel is open. The conversation view offers
an all-seat audience, per-seat asides, and explicit excerpt sharing; queued
messages require approval before dispatch. Uncertain retries retain the original
request key for each audience and excerpt.

Start a fresh session with **New Symposium** from either ChatView, without first
sending an ordinary chat prompt. Select the dedicated Symposium account/model,
a supported coder or reviewer role, and an exact saved profile revision; the
profile picker also supports creating or importing a profile. **Create Symposium
draft** allocates only durable session and roster metadata. Review the draft and
acknowledge its boundary in Director controls before activation; all production
admission checks still apply. Retried creation requests reuse the same session.
Ordinary chat send/interrupt routes cannot execute a configured Symposium, and
converting an existing ordinary conversation requires stopping it first.

Use **Add reviewer** in an existing conversation to choose a saved profile,
account/model, and an explicit review package (objective, acceptance criteria,
repository instructions, relevant diff/source, tests, and selected decisions).
Independent review is the default and includes no earlier conversation. Optional
context choices are an operator-written summary, selected shared excerpts, or
all proven shared excerpts. Only delivered broadcasts to every active member at
creation are eligible; private asides, queued inputs, and legacy turns without
audience proof are excluded. Edited deliveries contribute their delivered text.
The package is queued for approval, never automatically dispatched. Context
source grants default to empty; a reference does not itself load conversation
history. Shared workspace access remains governed by the read-only host grant.

Adding a reviewer can prepare a stopped ordinary conversation's isolated roster,
but admission still requires the verified runtime. A partially completed setup
remains visible in Director controls. Removing the last reviewer simplifies the
composer while preserving durable membership history and isolated routing; it
never switches the session back to ordinary execution. The development-only
`ui-preview.html` includes read-only reviewer choices for visual checks.

Portable profiles save immutable revisions of guidance, expected output, and
acceptance criteria. Select an exact revision for a seat, or export/import its
JSON; older revisions remain selectable after later revisions are saved. Revise
the latest version to create a new one. Conversational profile proposals require
operator review before saving. Profiles do not carry account credentials or
execution authority; those are bound separately by host-issued grants.

This is the director and profile foundation. The default server has no Symposium
provider runtime: activation and grant reissue fail closed until a trusted runtime
is installed. These controls do not enable production native seat execution.

Native OpenAI API and personal ChatGPT seats can read Mitzo's saved portable
profile catalog and draft profile updates with session tools. Drafts are persisted
in the session's review queue; only an explicit user **Save** creates an immutable
catalog revision, with revision conflict checks. Rebinding a seat remains a
separate director action. These tools recheck the current seat, durable attempt,
account route, and host grants before each call. Reviewer seats may propose
portable guidance for review but cannot save profiles or mutate shared artifacts.
Claude's native tool path remains unavailable pending its independent evidence
gate. Mitzo owns profile authoring and version history; ContexGin remains a
context source, with explicit imports rather than implicit write-back.

### Symposium native execution contracts

Native seat adapters route Codex and Claude through OpenShell and bind streamed
events and provider-confirmed receipts to an exact delivery claim. A private
host attempt registry records setup before launch and retains uncertain native
attempts across restart. Cleanup releases a claim only after proving it never
launched or confirming that its exact controller has stopped. Pending provider
detaches also survive reconciliation failure until attachments are verified.
The runtime supplies durable transcript recording by default, including early
events and closure after failure or cancellation; live broadcasting is optional.
Persisted native events retain their claim identity so confirmed restart cleanup
can close the exact unfinished transcript without inventing a successful result.

The review coordinator validates membership, recipient claims, profile revisions,
and grants before dispatch and result acceptance. Review content comes from the
trusted host's completed attempt and must match its receipt and artifact identity.
Interactive callers select the recorded result but cannot supply its findings.
These are guarded execution
contracts with mocked integration coverage. The default application still has no
Symposium runtime; production reviewer and Claude admission require further host
attestation and live acceptance. Environment settings alone do not enable them.

### Symposium OpenShell 0.1 per-seat runtime

The experimental 0.1 runtime gives each seat generation its own sandbox and exact
provider attachment inside one OpenShell workspace. Mitzo retains one conversation
view and routes each seat to its own sandbox. Reuse rechecks the physical sandbox
identity and provider attachments; uncertain creation or cleanup keeps the seat
reserved until reconciled. This path uses upstream OpenShell contracts without a
private gateway patch.

Shared artifacts use an explicitly admitted named volume, mounted read-write for
a writer and read-only for a reviewer. Host-side leases fence writers, verify the
physical mount, and release only after gateway and compute-host deletion proof.
Exact release receipts allow cleanup to finish after a crash without releasing a
replacement lease.

Production remains disabled by default. A trusted server bootstrap must install
matching host attestation for the selected CLI, gateway, images, policy, provider
profiles, seed and artifacts. Attestations must map each exact provider instance
name, ID and type to its reviewed profile; the host must verify that association
in the selected workspace. Missing instance mappings or physical proof fail closed.
The first supported attestation scope is OpenAI
writer roles. Claude via Vertex and reviewer admission remain closed pending their
live acceptance checks. An experimental [personal ChatGPT seat route](docs/features/symposium-chatgpt-subscription.md)
uses upstream Codex provider attachments and a private native authentication bootstrap.
It rejects the older private-gateway OAuth binding and host login imports, and keeps
subscription production admission closed pending independent account, credential
isolation and live acceptance evidence. An optional dedicated host, configured with
`MITZO_SYMPOSIUM_OWNED_HOST_CONFIG`, starts a digest-pinned unmodified upstream
gateway with private management authentication and physical native-image and
volume verification. `MITZO_BIND_HOST=127.0.0.1` can restrict the application
listener for local staging. Its Symposium account catalog is separate from regular
chat accounts; unavailable accounts never fall back to a work account. The owned
contract includes writer/reviewer and personal-seat capability, but still requires
independent account authorization and all production evidence gates. See
[dedicated gateway operation](docs/operations/symposium-owned-gateway.md) and the
[per-seat runtime handoff](docs/spikes/openshell-codex/SYMPOSIUM_PHASE3_HANDOFF.md)
for the architecture and remaining gates. Installing this code does not upgrade
or enable the active gateway.

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
| `session-service.ts`    | Durable child allocation, host grant, cancellation, and start reconciliation ledger |
| `permission-handler.ts` | `canUseTool` callback — auto-allow by tier, prompt via WS + push notifications      |
| `async-queue.ts`        | `AsyncIterable` queue for follow-up messages and interrupt                          |

**Skills** — Slash-command system

| File                 | Purpose                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `skills.ts`          | Skill registry — scoped discovery, precedence, collisions                         |
| `slash-commands.ts`  | Slash-command parsing and prompt expansion                                        |
| `skill-policy.ts`    | Per-turn tool restriction from skill frontmatter                                  |
| `native-commands.ts` | Built-in native commands (`/skills`, `/models`, `/close`, `/deliberate`, `/fuse`) |

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

For iOS development, run `./scripts/build-ios.sh` to build the iOS web assets and open Xcode. After the build, `./scripts/build-ios.sh --sync` copies the existing `frontend/dist-ios` assets into the iOS project without rebuilding them.

**Key Hooks:**

- `useChatMessages` — v2 protocol message reducer (MESSAGE_START/BLOCK_START/BLOCK_DELTA/BLOCK_END/TOOL_RESULT/MESSAGE_END/SESSION_END/MESSAGE_SNAPSHOT/RESTORE)
- `useTaskBoard` — task CRUD + loop control + WS subscriptions
- `useVoice` — STT (push-to-talk) + manual TTS (voice selection, sequential chunk playback)
- `useFileNavigation` / `useFileEditor` — file browser and editing
- `useSessionOverview` — session metadata and statistics
- `useServiceHealth` — health status for Yapper, ContexGin

**Key Components:**

- `MessageBubble` (UserBubble/TextBubble), `ThinkingBlock`, `ToolPill`, `ToolGroup`, `PermissionBanner`, `ChatInput`, `SlashPicker`
- `TaskNode`, `TaskCreateForm`, `LoopControls`, `TaskSidebar` — task board UI
- `VoiceSettings` — read-aloud voice picker grouped by language
- `SessionOverview` — session metadata card
- `ContextPanel` — boot context viewer
- `FileBrowserPanel` — file tree navigation

## Environment

| Variable                        | Description                                                    | Required |
| ------------------------------- | -------------------------------------------------------------- | -------- |
| `AUTH_PASSPHRASE`               | Login passphrase                                               | Yes      |
| `AUTH_SECRET`                   | JWT signing key (min 32 chars)                                 | Yes      |
| `REPO_PATH`                     | Default repo for sessions                                      | Yes      |
| `PORT`                          | Server port (default: `3100`)                                  | No       |
| `COOKIE_MAX_AGE_HOURS`          | JWT cookie lifetime in hours (default: `24`)                   | No       |
| `WORKTREE_ENABLED`              | Allow worktrees (default: `true`)                              | No       |
| `MITZO_WORKTREE_CLEANUP_POLICY` | Stale cleanup policy: `report` (default) or `execute`          | No       |
| `MCP_CONFIG_PATH`               | MCP config path (default: `~/.cursor/mcp.json`)                | No       |
| `LOG_LEVEL`                     | Log verbosity: `debug`, `info`, `warn`, `error`                | No       |
| `LOG_FILE_PATH`                 | Log file path (default: `logs/server.log`)                     | No       |
| `LOGGER_SYNC`                   | Set to `1` for synchronous logging                             | No       |
| `BASE_URL`                      | Public URL for notification deep links                         | No       |
| `YAPPER_PROXY_TARGET`           | Yapper backend URL (default: `http://localhost:8700`)          | No       |
| `CLAUDE_CODE_USE_VERTEX`        | Set to `1` to use Vertex AI for auto-rename                    | No       |
| `ANTHROPIC_VERTEX_PROJECT_ID`   | GCP project ID (required when using Vertex)                    | No       |
| `CLOUD_ML_REGION`               | GCP region for Vertex (default: `us-east5`)                    | No       |
| `NTFY_URL`                      | ntfy server URL (default: `https://ntfy.sh`)                   | No       |
| `NTFY_TOPIC`                    | ntfy topic for notifications                                   | No       |
| `NTFY_AUTH_TOKEN`               | ntfy auth token                                                | No       |
| `PUSHOVER_API_TOKEN`            | Pushover API token (for Apple Watch notifications)             | No       |
| `PUSHOVER_USER_KEY`             | Pushover user key                                              | No       |
| `APNS_KEY_PATH`                 | Path to Apple Push Notification Service .p8 key                | No       |
| `APNS_KEY_ID`                   | APNS key ID                                                    | No       |
| `APNS_TEAM_ID`                  | Apple Team ID                                                  | No       |
| `APNS_BUNDLE_ID`                | iOS app bundle ID (default: `com.mitzo.app`)                   | No       |
| `APNS_PRODUCTION`               | Use production APNS (default: `true`)                          | No       |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | OpenTelemetry OTLP endpoint (e.g., `http://localhost:4318`)    | No       |
| `LOKI_HOST`                     | Grafana Loki endpoint (e.g., `http://localhost:3200`)          | No       |
| `TRACE_CONTENT_MAX_CHARS`       | Max chars for trace content (default: `16384`)                 | No       |
| `CORS_ALLOWED_ORIGINS`          | Comma-separated CORS origins                                   | No       |
| `CONTEXGIN_URL`                 | ContexGin Goal Registry URL (default: `http://localhost:8321`) | No       |
| `MITZO_INTERNAL_TOKEN`          | Auto-generated token for inter-process auth                    | No       |

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

### Documentation policy

Every pull request reviews this README. Pull requests that change production code
must update it when they affect installation, configuration, commands,
architecture, supported integrations, or user-visible behavior. A PR that does
not need a README change must record the reason in its PR description; CI checks
both the review acknowledgement and that exception.

```bash
npm run dev          # backend + frontend concurrently
npm test             # vitest — full suite
npm run lint         # eslint
npm run format:check # prettier
```

Production artifacts are staged with
`./scripts/stage-openshell-release.sh <mgmt-repo> <new-seed-output>`. It requires
clean Mitzo and MGMT checkouts at current `origin/main`, then builds and verifies
the immutable image and seed, updates the stack lock and environment example
together, and runs focused tests. It never deploys; its generated diff is
reviewed and merged first.

Production deploys use `./scripts/create-release.sh origin/main`. The command
fetches only current `origin/main`, refuses every other commit, creates a
self-contained detached release clone, records full commit/tree/base provenance
in `release.txt`, and only then builds and updates launchd. `scripts/deploy.sh`
fails closed when those invariants are absent.
For releases built from a clean automation checkout, set `MITZO_RUNTIME_ROOT`
to the canonical installation that owns `.env` and `certs`; runtime material
is never taken from the feature checkout. Paths for checked-in stack locks,
policies, and provider profiles are rewritten to the immutable release so a
copied environment cannot mix code from two deployment generations.
When advancing the prepared MGMT seed, set `MITZO_RELEASE_SEED` to its `mgmt`
directory. Release creation requires the sibling `baseline.json` and changes
only the new release's copied `.env`, leaving the canonical runtime `.env`
untouched.

Pre-commit: husky + lint-staged + commitlint (conventional commits). The hook also runs [gitleaks](https://github.com/gitleaks/gitleaks) if installed, scanning staged changes for secrets. gitleaks is **optional** — the hook skips it gracefully when not found. Install via `brew install gitleaks` (macOS) or see the [gitleaks docs](https://github.com/gitleaks/gitleaks#installing).

## Tech

Node.js, Express, React 19, Vite, TypeScript, Claude Agent SDK, Vitest, ESLint, Prettier.

## Attribution

Evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center) by [Afstkla](https://github.com/Afstkla). The original used tmux; Mitzo uses the Agent SDK directly.

## License

MIT

### macOS runtime startup

The Podman launch agent preserves the VM process group after `podman machine start` exits. Without `AbandonProcessGroup`, launchd terminates those child processes and OpenShell sandbox startup fails even though the start command reports success. After installation, verify `podman info` still succeeds once the launch agent has exited. Use the production `com.mitzo.server` launch agent as the sole supervisor for Mitzo; stop and remove legacy PM2 startup entries before handing over the listening port.

The OpenAI Responses route uses bearer authentication in the Authorization header. Its base policy and gateway provider profile must disable request-body credential rewriting and retain enforced REST inspection. This requires a supervisor with the identity-aware streaming guard: literal placeholder examples in documents must pass unchanged, while actual credential identities in model input remain blocked. Production preflight checks both the configured base policy and live provider profile. Qualify the supervisor and policy together; changing only the policy on an older supervisor reintroduces documentation-triggered denials. Existing sandbox containers retain their supervisor image across stop/start and need a separately verified migration.

Symposium's [reusable reviewer profiles](docs/features/symposium.md#reusable-reviewer-recipes) include five editable starters, versioned portable context recipes, skill/tool references and provider compatibility. Import/export preserves exact revisions; applying a profile and selecting account/context remain explicit.
