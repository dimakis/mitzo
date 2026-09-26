# Personal ChatGPT device sign-in

The backend supports an explicit device-code login using upstream Codex
`account/login/start` with `type: "chatgptDeviceCode"`. The phone opens the
provider verification link and enters the one-time code; no localhost callback or
SSH forward is needed. Enable device-code login in the personal account's ChatGPT
Security settings first. See the official [authentication guide](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
and [app-server device flow](https://learn.chatgpt.com/docs/app-server).

The phone and Mac must access the **same running Mitzo server**. Authorization is
installed on that server, not copied from the phone's browser or from a different
Mac installation. The user explicitly chooses Connect or Reconnect; this backend
never starts login, model inference, or a browser fallback automatically.

## API and custody

Actions are scoped to the initiating authenticated operator session (not every
operator session on the same server). A separate browser login cannot retrieve or
cancel a pending code. The installed account catalog remains available on the same
server after successful sign-in. Authenticated session actions use:

- `POST /api/symposium/personal/login` with `{"method":"device-code"}` starts a
  fresh attempt. The response carries `attemptId`, `method`, `state`,
  `verificationUrl`, `userCode`, and `expiresAt` once upstream supplies the code.
- `GET /api/symposium/personal/login/status?attemptId=...` recovers status. Omitting
  the ID recovers the current authenticated session’s latest receipt. During allocation a pending
  receipt may have no code yet. Completed device receipts include only the verified
  display identity as `account: {label, email, planType}`. Terminal receipts omit
  the code and URL. An
  unknown or different-owner receipt never exposes instructions.
- `POST /api/symposium/personal/login/cancel` with `{"attemptId":"..."}` cancels
  the pending attempt and waits for process cleanup. A failed cleanup returns
  `unknown` with `retryBlocked: true`; another attempt is refused until host
  recovery. Cancellation cannot revoke a previously completed account connection.

All responses use `Cache-Control: no-store`. `expiresAt` is a ten-minute **local
attempt deadline**, not a claim about the provider's code lifetime. Terminal
receipts are unavailable after the bounded local receipt window. A server restart
returns `unknown`; neither the receipt nor the active personal account catalog
survives restart. Fresh explicit sign-in is required. This is not durable saved
connection recovery, provider logout, or an account-status/revocation API.

Each attempt gets a private temporary home and file-backed Codex credential store.
Only login/account RPCs are allowed; no thread/model execution is permitted. The
child receives a minimal environment with no inherited API keys, access tokens,
shared Codex home, or keychain auth fallback. On matching upstream completion,
the child must terminate before the isolated credential file is read. The private
credential home must then be deleted before provisioning or reporting success;
deletion failure quarantines the login and blocks retry. Its ID
token is independently verified for signature, issuer, audience, age and personal
account identity. Device login does not invent the browser flow's nonce. Raw
credentials, provider output and failures never enter HTTP responses or logs.

The existing provisioner checks owned-gateway custody around each credential
installation step, pins the physical provider, configures refresh, and publishes
the account catalog only after success. Cancelling or expiring while allocation
or provisioning is in progress fences late completion. Cleanup escalation retains
an unconfirmed child/home in quarantine instead of claiming it is gone.

Reconnect creates a new physical provider and account profile revision. Existing
seat bindings are not rewritten and fail current receipt/revision checks until an
explicit rebind; credentials are never swapped into an existing seat sandbox.
Prior provider/refresh resources remain within the exclusively owned gateway until
its lifecycle cleanup. A failed replacement leaves authority closed. This slice
does not introduce per-provider garbage collection or widen gateway permissions.

## Verification boundary

Mocked tests cover upstream JSON-RPC ordering, private credential mode, matching
completion, cancellation and expiry during allocation, cleanup quarantine,
owner-scoped recovery, restart uncertainty, identity validation, and reconnect
revision fencing. No real OAuth, model inference, gateway provisioning, or
production action was run to validate this slice. A read-only local Codex 0.156.1
process smoke initialized the isolated app-server, requested `account/read` with
refresh disabled, confirmed `account: null`, and confirmed process/home cleanup.
It did not request login or inference. Live acceptance remains an
explicit attended step after the user is ready.
