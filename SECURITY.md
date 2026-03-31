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

| Secret | Storage | Exposure |
|--------|---------|----------|
| `AUTH_PASSPHRASE` | `.env` (gitignored) | Never logged, never sent to SDK |
| `AUTH_SECRET` (JWT signing key) | `.env` (gitignored) | Never logged, never sent to SDK |
| `NTFY_AUTH_TOKEN` | `.env` (gitignored) | Used in ntfy API calls and permission endpoint auth. Never sent to SDK |
| Vertex AI credentials | GCP Application Default Credentials | `ANTHROPIC_VERTEX_PROJECT_ID` is a project name (not sensitive), actual auth uses ADC |
| `REPO_PATH` | `.env` (gitignored) | Exposed to frontend via `/api/config` (non-sensitive — it's a local path) |

The `sdkEnv()` function in `chat.ts` explicitly deletes `AUTH_PASSPHRASE`, `AUTH_SECRET`, and `NTFY_AUTH_TOKEN` from the environment before passing it to the Agent SDK, preventing accidental exposure to Claude sessions.

## Unauthenticated Endpoints

Two endpoints bypass cookie auth:

1. **`GET /api/version`** — returns a build hash. No sensitive data.
2. **`POST /api/permission/:permId/respond`** — used by ntfy action buttons to approve/deny tool permissions remotely. Authenticated by `NTFY_AUTH_TOKEN` query parameter instead of cookie. This is intentional: ntfy push notification actions can't carry cookies, so token auth is used instead.

Both are acceptable given the Tailscale-only access model.

## Agent SDK Sessions

Each chat session spawns a Claude Code process via the Agent SDK with:
- `cwd` set to a worktree (isolated per session) or the base repo
- Project-level settings from `.cursor/rules/` (read from the worktree)
- Environment variables with secrets stripped

Claude sessions have full filesystem access within their `cwd`. This is by design — the Agent SDK's permission system (`canUseTool`) controls tool-level access, and the user approves or denies from the UI.

## Known Limitations

- **No HTTPS**: traffic is encrypted by Tailscale (WireGuard), but the HTTP layer itself is plaintext. If accessed outside Tailscale, cookies and passphrases would be transmitted in the clear.
- **No rate limiting**: brute-force passphrase attempts are possible (mitigated by Tailscale network restriction).
- **No CSRF protection**: `sameSite: strict` mitigates most CSRF vectors, but there's no explicit CSRF token.
- **Single-user**: no user accounts, roles, or audit logging. The passphrase is shared across all access.
