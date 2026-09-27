# Personal model discovery through the owned host

`POST /api/symposium/personal/connections/:id/models/refresh` accepts
`{ "expectedRevision": <current connection revision> }` with interactive operator
authentication. The response is `no-store`. This endpoint is an explicit application
operation; listing accounts never starts a sandbox or changes model selection.

The connection must be connected under the current live verified login receipt. The
host captures its exact physical provider ID/name, verified email/plan and profile
revision, the retained owned gateway capability, pinned CLI/image/config and a policy
hash captured at bootstrap. Private management environment paths are explicit; ambient
authentication is never inherited. Account/model reads have no inference lifecycle.
`account/read` must match the verified receipt's identity before model discovery.

The connection persists a pending marker before allocation. Reconnect, disconnect and
another discovery cannot race it. Operator expiry/logout, slot revision, provider
receipt and gateway custody are checked around asynchronous operations, including
model reads; inventory pages also recheck the retained gateway/receipt capability.
A client opened during a custody change is closed locally. Unproven cleanup remains
quarantined for host recovery, including after a restart; metadata cannot restore
credentials or imply discovery succeeded.

The helper persists its requested sandbox name before creation and reconciles
ambiguous creation. It verifies sole attachment plus separate global provider
identity and consumes complete bounded inventories. It closes the read client and
waits for both gateway deletion and physical Podman absence before publishing models.
No transcript, artifact data, credentials or raw provider diagnostics are returned.

A successful refresh updates the in-memory model catalog and changes its profile
revision. Existing seat bindings remain unchanged and are stale until the operator
explicitly selects/rebinds the account/model. A failed read with proven cleanup retains
the previous catalog; uncertain cleanup invalidates the connection. This does not
provide a hard inference budget, terminal usage receipt, application review admission
or durable refresh-token restoration. Models are rediscovered only after fresh login
following a host restart.

Validation is mocked. The endpoint has not been exercised against a live gateway or
OAuth account by this implementation. Connections UI refresh controls are a separate
integration; callers must reload connection status after this operation.

Probe creation participates in the retained durable workspace lifecycle coordinator,
shared with credential cleanup and ordinary seat creation. It holds creation until
an exact requested-name/claim/workspace Ready identity is journaled. Any uncertain
creation keeps the workspace fence quarantined across restart, even if the helper
later observes absence; polling cannot prove that a delayed create will not arrive.
