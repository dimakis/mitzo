# Personal connection lifecycle

Each saved personal connection has a distinct account ID, display label, revision,
and independent in-memory provisioning receipt. Explicit reconnect removes the
selected slot's prior provider credentials before starting a new device login.
Other connected slots remain independent. A new provider identity changes the
account binding revision; existing seats require explicit rebind and are never
silently moved to the replacement account.

`GET /api/symposium/personal/connections` lists rows. `POST` on the same path
accepts `{label}` (1–120 characters) and creates a disconnected row. Login accepts
`{method:"device-code",connectionId,expectedRevision}`. Both slot identity and
revision are required, including the configured default slot and legacy callback
login on a multi-slot host. The server never fills in a fresh revision for an
omitted selection. Login status accepts
`connectionId` and optional `attemptId`; receipts for another slot or authenticated
operator session never disclose its code. Disconnect accepts `{expectedRevision}`
at `POST /api/symposium/personal/connections/:id/disconnect`. All routes require
interactive operator authentication. Connection rows belong to this private app
instance; ephemeral codes additionally belong to the initiating authentication
session. At most one login runs at once.

Disconnect immediately fences new dispatch through the slot's receipt/catalog.
It scans every paginated sandbox in the owned workspace before and after provider
removal. Without durable credential projection/deletion lineage, a detached or
unrelated sandbox can still contain a projected credential cache. Therefore any
surviving or starting sandbox, an unknown inventory, a pending provisioning operation, or
failed deletion prevents a successful disconnected result. The slot remains
`recovery_required` until host cleanup is confirmed. This conservative guard can
require cleanup of unrelated seats in the same owned workspace; it does not claim
that present provider attachment absence proves credential erasure. Pending login must be
cancelled through its initiating receipt before disconnect. Successful removal
uses supported upstream refresh-material deletion and provider deletion, followed
by provider absence verification. It does not claim remote revocation of the
user's ChatGPT session, and it does not remove unrelated seats or accounts.

Only display metadata is saved in private `personal-connections.json` under the
configured owned gateway state parent. No access token, refresh token, provider
receipt, or private authentication cache is persisted there. After restart,
previously connected rows become `reauth_required`; interrupted cleanup/login
remains `recovery_required`. Fresh sign-in is required before catalog admission.
A previous-host credential cleanup cannot be inferred from a saved row.

Verified authorization recovery across host restart remains blocked: upstream
owns refresh-token rotation, and a supported custody mechanism for recovering the
latest rotated credentials has not been verified. The implementation does not
restore trust from cached tokens or alter the gateway to expose them.

Validation uses mocked OAuth/native endpoints and local private metadata files.
It covers isolated slots, revision conflicts, code visibility, restart behavior,
late completion, and cleanup refusal. It does not perform real inference or
claim successful live multi-account runtime acceptance.

Cleanup retries retain only in-memory acknowledgements of successful exact-provider
refresh-material and provider deletion commands, under continuously verified
gateway custody. A retry skips those acknowledged stages but repeats empty
workspace and provider-absence checks. `NotFound`, lost custody, and other
unacknowledged outcomes do not prove deletion and remain blocked for host
recovery. These stage proofs are never restored from disk.

## Explicit supported-model refresh

Connected slots offer **Refresh supported models** through the authenticated
`/api/symposium/personal/connections/:id/models/refresh` endpoint, using the revision
currently displayed. This UI requires the owned-host model-discovery backend. Merely
opening Connections never starts discovery. It performs no inference and does not
select a model or rebind active seats.

While the request runs, account mutations are disabled. Persisted pending discovery
markers remain visible after remount and are polled through the connection list; an
uncertain cleanup marker requires host recovery. A successful response refreshes the
account catalog and instructs the user to choose the account/model explicitly. Failed,
malformed and interrupted responses do not claim a new catalog is ready. The local
preview simulates only the exact supported POST and revision; it makes no upstream
request or real sandbox operation.
A retained host coordinator serializes sandbox creation with credential cleanup.
Creation revalidates its seat binding after acquiring the fence and durably marks
the external operation immediately before the create command, after read-only
preflight. The trusted adapter must call the supplied dispatch marker; an
unmarked success is refused. Preflight rejection leaves cleanup available and
does not stamp a seat or artifact as creation-started. Rejection after dispatch or host loss leaves a persistent
uncertain marker: neither inventory absence nor restart clears it. Cleanup waits
for in-flight creation and refuses uncertain outcomes. Interrupted login rows
without a live adapter also remain blocked even when account metadata is absent.

Mounted Symposium account pickers share a payload-free catalog invalidation signal after account mutations or recovered mutation receipts. Each picker reloads independently and clears its parent selection; an unavailable draft remains visible until an explicit available account/model choice. Catalog reads do not emit the signal. Callback allocation and terminal outcomes refresh account state, including unsuccessful attempts, and each callback setup uses its own radio group even when the same saved connection appears in several pickers.

Device receipts remain attempt-scoped across cancellation, status polling and late allocation replies. The preview assigns fresh synthetic attempt identities and verifies a second code can be requested without contacting an upstream host.
