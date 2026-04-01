# Security Model

## Threat Model

This server is designed to run on a private home server (e.g., Mac Mini) and be accessed exclusively over [Tailscale](https://tailscale.com) — a zero-trust mesh VPN with WireGuard encryption. It is **never exposed to the public internet**.

Given that deployment model, the security posture prioritizes simplicity over defense-in-depth. The Tailscale network boundary is the primary perimeter.

## Authentication

- **Passphrase + JWT cookie**: login via `POST /api/auth/login` with a plaintext passphrase, which returns an HS256 JWT stored as an httpOnly cookie.
- **Cookie scope**: `sameSite: strict`, no `secure` flag (HTTP over Tailscale, not HTTPS).
- **Cookie expiry**: configurable via `COOKIE_MAX_AGE_HOURS` (default: 24h).
- **WebSocket auth**: upgrade requests are verified against the same JWT cookie.
- **Insecure defaults blocked**: `auth.ts` refuses to start if `AUTH_PASSPHRASE` or `AUTH_SECRET` are set to the example values from `.env.example`.

## Secrets Management

| Secret                          | Storage                             | Exposure                                                                                                                                                    |
| ------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PASSPHRASE`               | `.env` (gitignored)                 | Never logged, never sent to SDK                                                                                                                             |
| `AUTH_SECRET` (JWT signing key) | `.env` (gitignored)                 | Never logged, never sent to SDK                                                                                                                             |
| `NTFY_AUTH_TOKEN`               | `.env` (gitignored)                 | Used in ntfy API calls and permission endpoint auth. Never sent to SDK                                                                                      |
| Vertex AI credentials           | GCP Application Default Credentials | `ANTHROPIC_VERTEX_PROJECT_ID` is a project name (not sensitive), actual auth uses ADC                                                                       |
| `REPO_PATH`                     | `.env` (gitignored)                 | Exposed to frontend via `/api/config` (non-sensitive — it's a local path)                                                                                   |
| MCP server credentials          | `~/.cursor/mcp.json`                | Read by `mcp-config.ts`, passed to Agent SDK subprocess. Server names (not tokens) exposed via `/api/config`. Credentials never logged or sent to frontend. |

The `sdkEnv()` function in `chat.ts` explicitly deletes `AUTH_PASSPHRASE`, `AUTH_SECRET`, and `NTFY_AUTH_TOKEN` from the environment before passing it to the Agent SDK, preventing accidental exposure to Claude sessions.

## Unauthenticated Endpoints

Two endpoints bypass cookie auth:

1. **`GET /api/version`** — returns a build hash. No sensitive data.
2. **`POST /api/permission/:permId/respond`** — used by ntfy action buttons to approve/deny tool permissions remotely. Authenticated by `NTFY_AUTH_TOKEN` query parameter instead of cookie. This is intentional: ntfy push notification actions can't carry cookies, so token auth is used instead.

Both are acceptable given the Tailscale-only access model.

## Agent SDK Sessions

Each chat session spawns a Claude Code process via the Agent SDK with:

- `cwd` set to the base repo (default) or a worktree (if sandbox mode is enabled)
- Project-level settings from `.cursor/rules/` (read from the cwd)
- MCP servers loaded from `~/.cursor/mcp.json` (stdio-type only, disabled servers excluded)
- Environment variables with secrets stripped

Claude sessions have full filesystem access within their `cwd`. This is by design — the Agent SDK's permission system (`canUseTool`) controls tool-level access, and the user approves or denies from the UI.

Tools are classified into risk tiers (`safe`, `standard`, `elevated`, `unknown`) in `tool-tiers.ts`. Safe tools (reads) are always auto-allowed. Standard tools (file writes) are auto-allowed in Agent and Auto modes. Elevated tools (shell) require explicit approval in Agent mode but are auto-allowed in Auto mode. Unknown tools (MCP, etc.) always require approval. The `auto` mode maps to the SDK's `acceptEdits` permission mode (not `bypassPermissions`), so even in the most permissive mode, unknown tools still prompt.

## Session Resilience

WebSocket disconnects detach (not abort) the active session via `SessionRegistry`. The Agent SDK query continues running server-side. A reconnected WebSocket can reattach within a 10-minute TTL. After the TTL, abandoned sessions are aborted and cleaned up. This prevents session state accumulation from repeated disconnects.

The frontend WS pool buffers messages (capped at 500) while the user navigates between pages, replaying them on return. The buffer only stores UI-relevant message types (text, tool calls, errors, etc.) — connection lifecycle messages are not buffered.

## Repo Configuration

`.mitzo.json` in the repo root is read-only at startup. It cannot execute code — it provides JSON data (quick action labels/prompts and venv path strings). Quick action prompts are sent to the Agent SDK as user messages (same as typing them manually). Venv paths are prepended to `PATH` in the Agent SDK subprocess environment.

## File Browser

The `/api/files`, `/api/files/read`, and `/api/files/write` endpoints restrict access to paths under `REPO_PATH` and its worktree sessions directory. Path traversal is blocked by `resolve()` + `startsWith()` checks. The `root` query parameter (used for worktree browsing) is validated through the same `isAllowedPath()` check.

`PUT /api/files/write` only overwrites existing files within allowed paths — it cannot create new files or write outside the repo boundary. All file endpoints are behind cookie auth middleware.

## Known Limitations

- **No HTTPS**: traffic is encrypted by Tailscale (WireGuard), but the HTTP layer itself is plaintext. If accessed outside Tailscale, cookies and passphrases would be transmitted in the clear.
- **No rate limiting**: brute-force passphrase attempts are possible (mitigated by Tailscale network restriction).
- **No CSRF protection**: `sameSite: strict` mitigates most CSRF vectors, but there's no explicit CSRF token.
- **Single-user**: no user accounts, roles, or audit logging. The passphrase is shared across all access.
- **MCP credentials in mcp.json**: MCP server tokens (e.g., Jira API tokens) are stored in `~/.cursor/mcp.json`. This file is not managed by Mitzo — it's the user's existing Cursor configuration. Mitzo reads it but never modifies or copies it.
