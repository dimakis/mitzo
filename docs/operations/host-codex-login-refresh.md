# Host ChatGPT login refresh and recovery

Native Codex refreshes its selected ChatGPT login during normal operation. A changed
`auth.json` hash alone does not prove an account switch. The host login guard now
accepts a cryptographically verified rotation within the originally selected signed
login session. It retains the original physical file/root identities and verifies
account, email, plan, session, token pairing and monotonic accepted versions. An
account/session change, physical replacement or replay still fails closed.

## Verification cost and errors

This does not request or refresh a secret key on each send. Native Codex remains
the token refresh owner. Public issuer discovery/JWKS are shared across chats:
concurrent lookups coalesce, successful keys cache for five minutes, and an unknown
signing-key ID requests updated keys. Lookups have a bounded deadline and each
waiter retains independent cancellation. Unchanged accepted credential versions
reuse their cryptographic evidence; live ownership and authorization fences remain
at admission, I/O, tool and delivery boundaries.

- `login_verification_unavailable`: public signing keys could not be obtained.
  Preserve the input and retry after connectivity recovers; do not substitute an
  account or silently replay an uncertain turn.
- `login_refresh_invalid`: changed credentials cannot prove continuity of the
  selected account/session. Stop the selected lease and inspect its login.
- `login_refresh_reauthorization`: retained history predates the signed refresh
  anchor. Explicitly review the current selected login before authorizing recovery.

These reviewed diagnostics survive bootstrap, transport close and dispatch catches.
The protocol owns their shared code allowlist and public messages. The client
validates both retained-command and pre-admission failures, saves only the code
and diagnostic ID with the original outbox intent, and restores the reason after
reload. A failure changes a local optimistic Sending label to uncertain; it does
not invent a delivery receipt or acknowledge the command. Successful exact receipt
recovery clears the old diagnostic. Unknown codes and raw upstream text stay out
of the UI. Browser storage keeps diagnostics in a separate bounded namespace so
older tabs and a rolled-back client can still read the original command envelope.
Preparation refusals are logged with the same safe diagnostic ID so
the displayed error can be correlated without logging credentials.
The `login_verification_keys` observation measures actual public fetches, including
failures; cached checks do not create network observations. Deferred notifications
are ordered and bounded, and rejected qualification promises are observed even
when the lease closes or the notification queue overflows. Never log credentials.

## Existing histories: explicit offline reauthorization

For a release containing chats created before refresh continuity, inventory the
whole selected native ledger first. A code deployment alone does not migrate
their saved login custody. This read-only operation records every eligible chat
and reports blocked histories separately rather than aborting at the first one:

```sh
node --import tsx scripts/reauthorize-host-codex-login.ts \
  --database /absolute/native/conversations.db \
  --profiles /absolute/accounts.json --all-legacy \
  --plan-file /absolute/reviewed-legacy-plan.json
```

Review the plan's account identities, operation IDs, eligible count and blocked
list. API logins, already anchored logins and rows without host custody are not
selected. A blocked history remains retained and needs investigation; an empty
plan does not prove that blocked chats are usable. The report is owner-only and
contains account display information, never credential bytes.

After separately authorized production maintenance stops the selected runtime,
apply that exact saved report without rediscovering chats:

```sh
node --import tsx scripts/reauthorize-host-codex-login.ts \
  --database /absolute/native/conversations.db \
  --profiles /absolute/accounts.json \
  --apply-plan /absolute/reviewed-legacy-plan.json
```

Batch apply stops on the first refusal, returns completed receipts and the number
remaining, and exits unsuccessfully for an incomplete batch. Rerun only the same
reviewed report after reconciling its blocker; completed operations return their
existing receipts. Newly created chats never enter that approved list. No stage
of discovery or apply sends, retries or acknowledges a message. Finish by
re-inventorying the ledger, reviewing remaining blockers, and testing an explicit
continuation of an existing chat. Service activation and user acceptance remain
separate evidence from applying a login anchor.

Legacy custody cannot retrospectively prove the original signed session. The
operator tool establishes a new, explicitly reviewed signed anchor for an exact
retained conversation without changing its original custody, thread, commands or
uncertainty state. It does not send a message, acknowledge an interrupted tool,
resume a turn, write tokens or start/stop a service.

The source login must authenticate now, using a current signed assertion or its
cryptographically paired current access token. The matching private login may
have expired: its verified signature proves historical session identity only.
This exception applies solely to explicit reauthorization; ordinary rotation keeps
its expiry checks. Both signing-key IDs are qualified before verification.
Enrollment does not prove provider readiness. Native Codex must refresh an expired
private access token, and a revoked/reused refresh token can still require explicit
sign-in. Keep history and uncertain work intact on that failure.

Create a read-only plan using the actual selected native ledger and account profile:

```sh
node --import tsx scripts/reauthorize-host-codex-login.ts \
  --database /absolute/native/conversations.db \
  --profiles /absolute/accounts.json \
  --conversation RETAINED_ID --plan-file /absolute/reviewed-plan.json
```

Review the selected account and operation IDs. Deployment, stopping production and
applying a production plan require separate explicit authorization. Staging is stood
down. After authorization, stop the selected runtime through its owning procedure,
then use the same arguments with `--apply-plan /absolute/reviewed-plan.json` instead
of `--plan-file`. The tool refuses an open database owner, changed profile/login,
changed custody, running command or pending thread. It checks offline ownership
before opening writable storage or creating the recovery journal.

The native journal records intent before the owner-only ledger artifact and atomically
updates exact custody with its completion receipt. Process interruption between these steps is
retryable with the same plan; a completed plan is inspectable without new effects.
The operator must separately review interrupted/ambiguous work before continuing.

Accepted refresh versions use two fixed checksummed slots in the same physically
anchored 32 KiB file. Only the inactive slot is written and synced, preserving the
last accepted state if a write is interrupted. An unreferenced recovery artifact
can finish only its exact pending operation's byte prefix; unrelated bytes are
refused unchanged. Files and parent directory entries are synced before publishing
custody. Completed receipts never reconstruct a live ledger.

An uncertain **first send with no native conversation** is outside this procedure.
Preserve its original input and attachments, inspect delivery evidence, and obtain
an explicit replacement-send decision. Never manufacture native history or replay
it automatically.

## Validation and cost

The follow-up recovery regressions use synthetic signed logins, fake native RPC,
real local SQLite custody, the actual HTTP entry, outbox/store and browser storage
adapter. They cover every reviewed server diagnostic, pre-admission failures,
reload without replay, exact retry, the idle-chat spinner and preservation of an
already running turn. A two-chat recovery batch reports a separate damaged chat,
refuses an active database, retains interrupted/queued work and original threads,
and preserves idempotent receipts. A migrated login accepts two subsequent signed
refreshes and reopens cold without changing the saved work. Newly captured signed
logins have their refresh anchor from creation.

The offline composer fixture covers both themes on phone and desktop, showing the
reauthorization reason and reference after reload, preserving the draft and
dispatching the identical command only after explicit Retry. The matrix lists
successfully; browser launch remains blocked by the host Seatbelt marker even
after an escalation request. No browser screenshots or full-app acceptance are
claimed locally. Workspace package compilation, focused storage-adapter type
checking and design checks pass. Full server type checking reaches the required
1 GiB heap limit and remains a CI gate. No production data, credentials, service
restart, recovery application or real model call is part of these tests.

The regression coverage extends existing login, bootstrap, admission, lifecycle and
native custody fixtures. Synthetic RSA signatures, fake native RPC and local SQLite
exercise the trust boundaries without model calls or credentials. The final focused run
passed 246 tests across nine existing files in 10.97 seconds
(6.39 seconds executing tests). There is no browser or complete-app journey added.
Historical baseline runtime was not measured, so no runtime delta is claimed.
The existing native history/revocation case also passed in 11.12 seconds
(8.44 seconds executing the case), preserving its real consumer authorization
boundary while requiring the specific revocation diagnostic. The longer cold
tool-rollover consumer reuses its existing CI journey and deadline; no additional
local copy is needed to repeat the shared error-propagation checks.
Broad build/typecheck and required CI/review gates remain mandatory; local checks
use one worker and a 1 GiB heap while this Mac is under memory pressure or its
pressure reading is unavailable.
