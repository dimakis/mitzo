# Apple Keychain service connections

Keychain HTTPS connections are a provider type in Mitzo's existing Connections overview and management page. They support Home Assistant and custom HTTPS APIs authenticated by a bearer token, HTTP Basic username/password, an API-key header, or a password header. The authentication mapping, destination, allowed paths and methods are configured explicitly. Existing managed OpenShell, Google Workspace and personal account connections keep their owning controls.

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

## Apple Passwords

Apple Passwords/iCloud Passwords is not a vault that Mitzo can enumerate or continuously synchronize. Username/password fields use standard browser AutoFill attributes; a user can select a credential using the browser's supported password picker or enter it securely. Saving creates an independent Mitzo Keychain item. Changing the original password in Apple Passwords requires updating the Mitzo connection. Existing-item linking supports accessible generic password items in Keychain Access, not arbitrary Apple Passwords records, Internet password entries or passkeys.

## Mac helper setup

This feature is opt-in and requires a signed helper. Build from reviewed, accepted source with an Apple Developer signing identity:

```sh
bash scripts/build-keychain-helper.sh <absolute-private-helper-path> <Developer-ID-signing-identity>
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

Mitzo verifies the helper signature against `com.mitzo.keychain-helper`, an Apple-issued signing anchor and the configured team before each operation. Ad-hoc signed helpers are not accepted. The controller creates an owner-only capability/enrollment record at `~/.mitzo/keychain-helper/<namespace>/controller.json`. Namespaces default to `default` and accept a lowercase letter followed by up to 63 lowercase letters, digits or hyphens. Use a distinct namespace and metadata directory for canonical staging; it must not reuse production controller state. Each namespace assumes one owning controller writer process. The helper authenticates the capability and limits reads/removal to enrolled persistent references. It derives the authentication file's home from the OS user, not caller-supplied `HOME`. Test-only keychain/controller overrides are compiled out of installed builds.

The controller, Keychain helper and other unsandboxed processes running as the same OS user are within the trusted host boundary. The capability file does not isolate against a compromised same-user host process. Mitzo agents are outside that boundary: the helper, controller metadata and Keychain directories are protected from their native file and shell tools, and OpenShell receives no credential copies or helper capabilities. Strong isolation between independently trusted same-user applications would require a packaged signed client and XPC peer authentication.

HTTPS requests remain on the enrolled origin, refuse redirects, use the existing reviewed IANA public-address policy, and allow only explicitly selected RFC1918, Tailscale/CGNAT or IPv6 ULA ranges for private services. Loopback, link-local/metadata, multicast and reserved ranges stay blocked. Credentials are not exposed through shell tools, arbitrary request headers or a credential-returning model tool.

Preserve both metadata and the private controller enrollment record when backing up the host. Keychain references are Mac-specific; restoring metadata on another Mac does not silently select matching credentials. Re-enroll connections on that Mac. If rotation fails after grants are invalidated, the connection remains disabled; it does not restore stale access automatically. Use **Replace credential and enable** with fresh setup authorization to repair it, then approve access again in each chat. Interrupted enrollment can leave an unreferenced Mitzo-owned Keychain item; use Keychain Access for manual cleanup after checking ownership.

## Validation and activation

Unit and integration tests use fixture vaults and mock providers. `python3 scripts/test-keychain-helper.py` compiles a test-only helper and uses a disposable keychain with generated fixture credentials, including unauthorized caller and unenrolled-item checks. It never reads the login Keychain. CI runs these native checks on macOS.

Live Mitzo validation must use the canonical staging instance at `http://mitzo-staging.localhost:3190`, after running `~/.local/share/mitzo-staging/bin/mitzo-staging check`. Safe and stale are separate results. Enabling this provider in staging requires independently reviewed staging configuration and the exact-commit prepare/plan/apply flow. Do not reuse production configuration or force a drain, lock, restart or rollback. Production activation is a separate explicit action. Any live model test must explicitly use a supported Luna model and state the charged account beforehand.
