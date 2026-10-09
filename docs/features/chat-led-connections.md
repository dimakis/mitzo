# Chat-led service connections

Service setup starts inside the user's task. The agent discovers existing
connections, asks for a missing service address, and prepares secret-free setup.
The user opens the setup card and enters their credential in the secure page.
Mitzo verifies the credential privately, saves the connection, and delivers a
readiness notice to the original chat. The original service action still requires
that chat's connection access; setup itself grants no access and executes no action.

## Agent interface

- `ListConnections` discovers configured services and this chat's access.
- `GetConnectionGuide` loads one current workflow: `connect`, `use`, or
  `troubleshoot`. This works even when the credential runtime is unavailable.
- `PrepareConnectionSetup` prepares configuration without accepting secrets.
  Home Assistant's profile selects authentication, request scope, and dashboard
  transport automatically. A custom service requires documented authentication,
  allowed paths/methods, verification path, documentation URL, and a documented
  JSON success field. A successful HTTP status alone is insufficient.
- `GetConnectionSetup` reads non-secret progress for this chat's setup. Both setup
  tools return `{setup}` and cannot inspect another chat's draft.
- `RequestConnectionAccess` asks for separate chat-scoped approval before use.

Detailed usage, including private authentication and safe handling of unconfirmed
commands, lives in `server/connection-guide.ts`. Initial session context contains
only a short pointer. The same schema and definition registry supplies SDK,
Codex, and native Responses providers, so guidance and tools ship together.
Tests assert that the guide's tool list matches the runtime registry.

## Knowledge-store integration

A Mitzo spoke should link its service-connection topic to `GetConnectionGuide`,
rather than copying workflow instructions or tool schemas. The installed runtime
is authoritative for supported capabilities. External knowledge can explain the
product and supply navigation, but cannot change host configuration, credential
destinations, or supported authentication. Updating the code updates the guide
in the same release; publishing or adopting an external spoke follows the
existing accepted knowledge workflow separately.

## Readiness and continuation

Pending setup and delivery state persist in the private connection database.
Readiness is sent with a stable message identity through the existing provider
dispatch, preserving its command deduplication. The notifier coalesces callbacks,
checks the exact owning chat and verified connection revision, and defers busy,
detached, suspended, closing, or aborted chats. Reconnecting retries the same
pending delivery. The notice contains generated identifiers only, never the
credential, service response, or service-controlled instructions. It is context
information: follow the latest user instructions and never repeat completed or
unconfirmed actions.

The secure setup page returns to the originating chat. Credentials and their
verification remain at the browser/Keychain boundary. Verification failures
return a generic retry message and do not expose response bodies or keys.
