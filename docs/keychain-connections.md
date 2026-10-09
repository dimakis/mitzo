# Apple Keychain service connections

Keychain HTTPS connections and service-neutral WebSocket requests are a provider type in Mitzo's existing Connections overview and management page. They support Home Assistant and custom HTTPS APIs authenticated by a bearer token, HTTP Basic username/password, an API-key header, or a password header. The authentication mapping, destination, allowed paths and methods are configured explicitly. Existing managed OpenShell, Google Workspace and personal account connections keep their owning controls.

The Mac's Keychain remains the credential source of truth. These connections use a trusted host HTTP client, rather than copying credentials into OpenShell. Neither model tool inputs/results, session workspaces, browser storage nor SQLite contain credential values. SQLite stores metadata, pinned Keychain references and exact conversation grants. The host temporarily resolves a credential after checking a grant and injects it into its approved request. Responses are bounded and known raw, URL-encoded and authentication representations are redacted. Only connect services you trust to receive that credential.

## User flow

1. Open **Connections → Add connection → Apple Keychain connections**.
2. Authorize setup with the Mitzo passphrase. This does not authorize any agent session.
3. Choose Home Assistant or a custom HTTPS service, authentication and credential source. Save a new Mitzo-owned item, or explicitly link a generic password item accessible in Keychain Access by its service/account coordinates. Ambiguous coordinates are rejected and a versioned opaque pin binds the selected reference to protected credential state. macOS can reuse raw item references after deletion; the helper does not treat raw reference bytes alone as proof of identity.
4. Review allowed path prefixes and methods. Reads are the default; writes must be selected explicitly. Enable private-network access only for a LAN or Tailscale service that needs it. TLS certificate verification stays enabled.
5. Test an allowed GET endpoint. The test uses a temporary administrative grant and does not grant access to any chat.
6. In chat, the agent calls `ListConnections`, `RequestConnectionAccess`, then `ConnectionRequest`. The approval card shows the destination, methods and paths. Approval is required even in Auto mode, and is retained for that exact session across reconnects and server restarts. Forks and new sessions need their own approval.

`ListConnections` also includes managed OpenShell providers in OpenShell sessions. Requests for those providers reuse their existing reviewed attachment and session approval flow. They are used through their own sandbox clients; Keychain HTTPS requests use the dedicated host client.

**Session access** lists grants and lets the operator revoke one session. **Disable and revoke all access** invalidates every grant immediately. In-flight requests are cancelled where possible; cancellation cannot undo an already accepted external write. Rotation saves a new Keychain item and invalidates all grants, including approvals pending on the old revision. Linked items are never changed or deleted. Changes to an externally linked credential fail closed and require explicit re-enrollment; Mitzo does not silently adopt a changed or re-created item. Disabling a connection retains its Keychain item.

## WebSocket service connections

WebSocket support belongs to each service connection, rather than to a particular service. New and existing connections have **Service WebSocket** controls. Access defaults to disabled. Enable header authentication to reuse the connection's bearer, Basic, API-key or password header, or configure a JSON authentication exchange that privately inserts the same Keychain credential. Set a relative WebSocket path within the connection's allowed path prefixes and, optionally, service subprotocol names. The WSS destination is derived from the enrolled HTTPS origin; agents cannot choose a different origin or supply authentication settings. Updating or disabling WebSocket setup requires recent setup authorization, increments the connection revision, revokes existing chat grants and cancels in-flight operations.

Agents call `ConnectionWebSocket` with `connectionId`, a text `message`, and an optional `responseMatch` containing a top-level JSON `field` and scalar `equals` value. One application message is sent after authentication; the tool returns the first matching text response. Without a matcher it returns the first application response. A matching response is a transport result, not proof that the service accepted the command: inspect the service's response and read back state when needed. Generic commands may write, irrespective of names such as `read` in their payload. The separate WebSocket permission authorizes arbitrary text commands on the configured endpoint and is blocked in Ask mode, even if the HTTPS connection only permits GET. The chat approval card displays this broader scope. Home Assistant's dashboard adapter remains available for restricted list/read/save operations; enabling it does not enable arbitrary WebSocket commands.

For JSON authentication, only non-secret scalar parameters belong in `message`; Mitzo inserts the credential under `credentialField`. Optionally wait for a `challenge` matcher before sending authentication, then require a `success` matcher before sending the application message. For example, HA's preset corresponds to:

```json
{
  "path": "/api/websocket",
  "authentication": {
    "kind": "json",
    "message": "{\"type\":\"auth\"}",
    "credentialField": "access_token",
    "challenge": { "field": "type", "equals": "auth_required" },
    "success": { "field": "type", "equals": "auth_ok" }
  }
}
```

The authenticated control-plane route `POST /api/credential-connections/:id/websocket` takes `{ revision, websocket }`; `websocket: null` disables generic access. This route is service-neutral and uses the same browser identity and recent CSRF reauthorization as credential enrollment. JSON exchange configuration never contains the credential. Authentication frames and raw upstream failures are not returned to agents or persisted by the service.

The shared transport checks TLS and DNS/address policy, refuses redirects, disables compression and rechecks current session ownership, mode, grant and connection revision before each send, receive and result. Application messages are limited to 128 KiB, responses to 256 KiB per frame/final result, total incoming traffic to 768 KiB and 64 frames, and the whole exchange to 30 seconds. Known credential representations are redacted before returning data. Each invocation closes its socket and destroys its dedicated HTTPS agent. It never reconnects or replays a command; a failure after sending is reported as unconfirmed and may have applied. Verify service state before retrying.

The initial generic capability supports bounded text request/response APIs with header or single-step JSON authentication and optional subprotocol negotiation. Binary codecs, continuous subscriptions, OAuth enrollment and multi-step custom authentication require additional adapters; a universal transport does not make all application protocols interchangeable. Adapters reuse the same custody and transport boundary. See the [ws client API](https://github.com/websockets/ws/blob/master/doc/ws.md) for the underlying transport.

## Home Assistant dashboards over WebSocket

For an existing Home Assistant connection, select **Dashboard API access → Read and update dashboards** and save after authorizing setup. New connections expose the same choice. Dashboard access defaults to disabled, including connections enrolled before this feature. It requires bearer authentication and an allowed path prefix covering `/api/websocket`. Changing the scope increments the connection revision, revokes existing grants and cancels in-flight requests. Each chat must approve the new scope. This approval is separate from setup authorization.

Agents use `HomeAssistantDashboard` with `operation: "list"`, `"read"` or `"save"`. Authentication uses the connection's Keychain token in HA's private authentication exchange; this tool cannot select another WebSocket URL or send arbitrary commands. The only application commands are `lovelace/dashboards/list`, `lovelace/config` and `lovelace/config/save`. Omit `urlPath` for the default dashboard, or use the exact path returned by listing dashboards. Dashboard updates require an HA administrator account and a storage-mode dashboard; YAML-backed dashboards must be updated at their owning source.

A read returns the complete configuration and `configHash`. If credential redaction changes the read, the result is marked `redacted: true`, `writable: false`, with `configHash: null`. Saves are also refused whenever the fresh baseline contains a protected credential, so a redaction marker cannot overwrite it. Preserve unrelated views and cards when editing. A save supplies the full configuration as a JSON string plus that hash as `expectedConfigHash`. Mitzo reads the dashboard immediately before writing and refuses a stale hash, then reads back the saved configuration before reporting success. Saves to the same dashboard through this controller cannot overlap. HA does not provide an atomic conditional-save API: another writer can still race between the check and save. The read-back check detects an unexpected final configuration but cannot undo an external concurrent edit.

The controller establishes a bounded WSS connection for each operation, verifies TLS, refuses redirects and applies the existing checked DNS/address policy. It rechecks session permissions and the connection revision before every authentication/command frame and before returning results. Configurations are limited to 128 KiB, each response frame and final redacted result to 256 KiB, and operations to 30 seconds. Known credential representations are redacted using the same code as HTTPS responses. No configuration or authentication frames are persisted by the connection service.

Ask mode permits list/read but blocks saves. A dropped connection or failed verification after sending a save is reported as **unconfirmed**, because the write may already have applied. Neither the transport nor the tool automatically reconnects or repeats a save. Read the dashboard again to settle that outcome before proposing another update.

References: [HA WebSocket authentication and command protocol](https://developers.home-assistant.io/docs/api/websocket/) and [HA Lovelace command implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/lovelace/websocket.py).

## Apple Passwords

Apple Passwords/iCloud Passwords is not a vault that Mitzo can enumerate or continuously synchronize. Username/password fields use standard browser AutoFill attributes; a user can select a credential using the browser's supported password picker or enter it securely. Saving creates an independent Mitzo Keychain item. Changing the original password in Apple Passwords requires updating the Mitzo connection. Existing-item linking supports accessible generic password items in Keychain Access, not arbitrary Apple Passwords records, Internet password entries or passkeys.

## Mac helper setup

This feature is opt-in and requires a signed helper. Build from reviewed, accepted source with an Apple Developer signing identity:

```sh
install -d -m 700 <absolute-private-helper-directory>
bash scripts/build-keychain-helper.sh <absolute-private-helper-directory>/keychain-helper <Developer-ID-signing-identity>
chmod 700 <absolute-private-helper-directory>/keychain-helper
```

The helper uses `SecItem` APIs against the user's file-based Keychain. It uses legacy interaction controls only to return a clear **Unlock Apple Keychain on the Mac, then retry** error instead of blocking remote requests on a desktop prompt. The same signed helper identity should be retained across updates. Initial linking may require local approval on the Mac; normal session approvals happen inside Mitzo.

Configure the owning controller independently:

```dotenv
MITZO_KEYCHAIN_CONNECTIONS_ENABLED=1
MITZO_KEYCHAIN_HELPER=<absolute-private-helper-path>
MITZO_KEYCHAIN_TEAM_ID=<10-character-Apple-Developer-Team-ID>
# Use a distinct namespace for each controller (for example, staging or personal).
MITZO_KEYCHAIN_CONNECTIONS_NAMESPACE=<controller-namespace>
# Optional absolute metadata directory; default is ~/.mitzo/credential-connections/<namespace>
MITZO_KEYCHAIN_CONNECTIONS_DIR=<private-directory>
```

The configured helper must be an executable regular file with a single link, owned by the controller user or root, and must not be writable by group or others. Its ancestor directories must also be owned by that user or root and must not be writable by group or others; root-owned sticky temporary directories are permitted. User-controlled symlinks are rejected; trusted root-owned system aliases are resolved. Install the signed helper in an owned physical directory and configure its actual absolute path. If your build output uses user-owned aliases such as Swift’s `.build/release` or `.build/debug`, resolve the source with `realpath` and copy the signed file into that physical installation directory; do not configure the alias path. Copying preserves the embedded signing identity. A normally packaged root-owned executable with mode `755` satisfies this policy; the private installation above uses mode `700`.

Before each operation, Mitzo opens that source without following a final symlink, checks the opened file identity and copies its bytes into a unique private directory beneath `~/.mitzo/keychain-helper/executables`. This controller-owned storage must have mode `700`; each copied helper has mode `500`. Mitzo verifies and executes the same private copy, then removes it. Signature verification requires `com.mitzo.keychain-helper`, an Apple-issued signing anchor and the configured team. The codesign requirement is passed as a literal expression using `-R "=<requirement>"`; the leading `=` prevents interpreting it as a requirements-file path. Ad-hoc signed helpers are not accepted. The controller creates an owner-only capability/enrollment record at `~/.mitzo/keychain-helper/<namespace>/controller.json`. Namespaces default to `default` and accept a lowercase letter followed by up to 63 lowercase letters, digits or hyphens. Use a distinct namespace and metadata directory for canonical staging; it must not reuse production controller state. Each namespace assumes one owning controller writer process. The helper authenticates the capability and limits reads/removal to enrolled persistent references. It derives the authentication file's home from the OS user, not caller-supplied `HOME`. Test-only keychain/controller overrides are compiled out of installed builds.

The controller, Keychain helper and other unsandboxed processes running as the same OS user are within the trusted host boundary. The capability file does not isolate against a compromised same-user host process. Mitzo agents are outside that boundary: the helper, controller metadata and Keychain directories are protected from their native file and shell tools, and OpenShell receives no credential copies or helper capabilities. Strong isolation between independently trusted same-user applications would require a packaged signed client and XPC peer authentication.

Host Claude Agent SDK sessions use an outer OS sandbox whenever Keychain connections are enabled, the connection runtime exists, or retained controller/metadata directories remain. The entire SDK process and its native file tools, shell commands and subprocesses inherit an immutable read/write denial for controller state, connection metadata, the helper and Keychain files. Provider settings, permission modes and shell sandbox opt-outs cannot remove this boundary. This outer SDK boundary requires macOS. SDK startup fails closed if complete OS sandbox dependencies are unavailable; install the reported dependencies before retrying. Disabling the feature does not expose retained private state. Other providers keep their existing guarded connection flow.

In this protected SDK mode, Mitzo excludes project hook callbacks, the local executable boot-context fallback and configured MCP servers, including task/Telos subprocess servers. ContexGin boot context remains available. The trusted server/runtime directory, Node installation, dependencies and host executable PATH directories are write-protected, so global tool installation or replacement is unavailable from these sessions. Only Mitzo's owned connection, web-access and GitHub publishing servers are supplied. Direct SDK/shell network access is limited to Anthropic/Google provider endpoints, the explicitly configured Anthropic base URL, GitHub and npm/Python package registries; other service access uses Mitzo's approved request tools. Delegated SDK web search uses the same outer process boundary. Host SDK behavior stays unchanged when no protected configuration, runtime or retained state exists.

HTTPS requests remain on the enrolled origin, refuse redirects, use the existing reviewed IANA public-address policy, and allow only explicitly selected RFC1918, Tailscale/CGNAT or IPv6 ULA ranges for private services. Loopback, link-local/metadata, multicast and reserved ranges stay blocked. Credentials are not exposed through shell tools, arbitrary request headers or a credential-returning model tool.

Preserve both metadata and the private controller enrollment record when backing up the host. Keychain references are Mac-specific; restoring metadata on another Mac does not silently select matching credentials. Re-enroll connections on that Mac. If rotation fails after grants are invalidated, the connection remains disabled; it does not restore stale access automatically. Use **Replace credential and enable** with fresh setup authorization to repair it, then approve access again in each chat. Interrupted enrollment can leave an unreferenced Mitzo-owned Keychain item; use Keychain Access for manual cleanup after checking ownership.

## Validation and activation

Unit and integration tests use fixture vaults and mock providers. `python3 scripts/test-keychain-helper.py` compiles a test-only helper and uses a disposable keychain with generated fixture credentials, including unauthorized caller and unenrolled-item checks. It never reads the login Keychain. CI runs these native checks on macOS. `MITZO_TEST_OS_SANDBOX=1 npm test -- server/__tests__/credential-sdk-boundary.test.ts` runs a separate disposable OS regression for direct reads, child shell reads, writes and ancestor renames; it makes no model calls and never reads real Keychain items.

Live Mitzo validation must use the canonical staging instance at `http://mitzo-staging.localhost:3190`, after running `~/.local/share/mitzo-staging/bin/mitzo-staging check`. Safe and stale are separate results. Enabling this provider in staging requires independently reviewed staging configuration and the exact-commit prepare/plan/apply flow. Do not reuse production configuration or force a drain, lock, restart or rollback. Production activation is a separate explicit action. Any live model test must explicitly use a supported Luna model and state the charged account beforehand.
