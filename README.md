# Mitzo

Claude Code on your phone. A self-hosted web UI built on the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), designed for mobile over [Tailscale](https://tailscale.com).

<!-- ![Home Screen](docs/screenshots/home.png) -->
<!-- ![Chat with Tools](docs/screenshots/chat-tools.png) -->

## Features

- **Streaming chat** with thinking blocks, tool pills, and markdown
- **Three modes** — Ask (read-only), Agent (file edits allowed), Auto (shell too). Switch mid-chat.
- **MCP tools** — reads `~/.cursor/mcp.json`, passes servers to every session
- **File browser** — view and edit repo files, switch between worktree roots
- **Worktree sandbox** — opt-in git worktree isolation per session
- **Session resilience** — phone sleeps, WS drops, session survives. Reattach on reconnect. Message snapshot recovery for iOS silent drops.
- **Quick actions** — one-tap commands via `.mitzo.json`
- **Push notifications** — ntfy + Pushover (Apple Watch) when Claude needs approval
- **Image attachments** — send photos/screenshots from your camera
- **Session history** — resume past conversations, swipe to dismiss

## Quick start

```bash
git clone https://github.com/dimakis/mitzo.git && cd mitzo
npm install && cd frontend && npm install && cd ..
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

### Backend (`server/`) — 20 modules

| Core                    | Purpose                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `query-loop.ts`         | SDK → v2 event translator. Deferred `message_end`, snapshot state, block lifecycle. |
| `chat.ts`               | Agent SDK `query()`, prompt assembly, streaming-input queue, session restore API    |
| `session-registry.ts`   | Session state: detach, reattach, rekey, TTL abort, snapshot storage                 |
| `permission-handler.ts` | `canUseTool` callback — auto-allow by tier, prompt via WS + push notifications      |
| `async-queue.ts`        | `AsyncIterable` queue for follow-up messages and interrupt                          |

| Supporting                                                                     | Purpose                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `tool-tiers.ts`                                                                | Risk classification + mode/tier auto-allow matrix |
| `tool-summary.ts`                                                              | Summarizes tool inputs for pill display           |
| `permissions.ts`                                                               | Request/response registry                         |
| `content-blocks.ts`                                                            | SDK content block parsing                         |
| `mcp-config.ts`                                                                | Loads Cursor MCP config                           |
| `worktree.ts`                                                                  | Git worktree lifecycle                            |
| `repo-config.ts`                                                               | `.mitzo.json` reader                              |
| `auth.ts`                                                                      | Passphrase + JWT                                  |
| `notify.ts` / `pushover.ts`                                                    | Push notifications                                |
| `logger.ts` / `constants.ts` / `git-version.ts` / `port-check.ts` / `index.ts` | Infrastructure                                    |

### Frontend (`frontend/`) — React 19 + Vite

Four pages (`Login`, `SessionList`, `ChatView`, `FileViewer`), a `useReducer`-based message state machine (`useChatMessages`), module-level WebSocket pool with 500-message buffer, and components for thinking blocks, tool pills, tool groups, and permission banners.

## Environment

| Variable           | Description                                     | Required |
| ------------------ | ----------------------------------------------- | -------- |
| `AUTH_PASSPHRASE`  | Login passphrase                                | Yes      |
| `AUTH_SECRET`      | JWT signing key (min 32 chars)                  | Yes      |
| `REPO_PATH`        | Default repo for sessions                       | Yes      |
| `PORT`             | Server port (default: `3100`)                   | No       |
| `WORKTREE_ENABLED` | Allow worktrees (default: `true`)               | No       |
| `MCP_CONFIG_PATH`  | MCP config path (default: `~/.cursor/mcp.json`) | No       |

See `.env.example` for the full list.

## `.mitzo.json`

Drop this in your repo root for quick actions and Python venv support:

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
  "venvPaths": [".venv/bin"]
}
```

## Development

```bash
npm run dev          # backend + frontend concurrently
npm test             # vitest (209 tests)
npm run lint         # eslint
npm run format:check # prettier
```

Pre-commit: husky + lint-staged + commitlint (conventional commits).

## Tech

Node.js, Express, React 19, Vite, TypeScript, Claude Agent SDK, Vitest, ESLint, Prettier.

## Attribution

Evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center) by [Afstkla](https://github.com/Afstkla). The original used tmux; Mitzo uses the Agent SDK directly.

## License

MIT
