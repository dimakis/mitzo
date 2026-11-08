# Native policy continuity and interrupted chats

Evidence recorded 7 November 2026 against production release `3079701d8f71`
and candidate source based on main `c38e2538`. This is implementation and offline
verification evidence. Review, acceptance, deployment and recovery of a live
conversation require separate receipts.

## Incident and evidence limits

At 15:32 UTC, the reported diagnostic
`f21b24c4-b0a5-4cc2-a5dd-b075a544f263` correlated a native command approval's
`execution_policy` validation failure with transport closure. Another chat hit
the same sequence seconds earlier. The logged cause was “Native execution policy
changed during the active command.” The public error only said the connection
closed. The production logs do not identify which policy field changed, so the
specific initiating configuration change remains unverified.

Production also predates merged PR #1254, which retains session tool authentication
across browser disconnects. That is a separate failure from the policy check;
this candidate includes #1254 through its main baseline.

## Prevention and diagnostics

The active-command validator previously compared exact policy hashes. The shared
private-path registries can acquire redundant descendants
of an already denied directory when another conversation selects a runtime.
Those entries change the hash without changing effective protection.

Compare captured canonical denial scopes instead. A redundant descendant is
equivalent only while its ancestor provides the same final subtree denial. Keep historical
receipt hashes unchanged, do not resolve old paths again, and retain real changes
to account binding, mode, workspace, read scope, scratch access, runtime profiles,
reviewer and credential/runtime protection fences. Positive read-only entries
remain exact: a descendant can add a real restriction beneath implicit temporary
write access. Permission removal or expansion
requires fresh owning admission.

The same live comparator guards active approvals, repository preparation and the
preparation adoption barrier. Valid equivalent policy hashes preserve the original
barrier receipt; substituted or inconsistent hashes remain refused. Owner changes,
revocation, abort and asynchronous ownership proofs retain their existing fences.

A real change raises `native_policy_changed`. Fixed changed-field names are logged
with the owning conversation and diagnostic ID; paths, policy values and credentials
are excluded. The original typed cause survives reply validation and transport
shutdown, including a refusal before response-fence registration. No grant or
generic RPC reply resumes inference on the stale policy. The durable event retains
the strict public failure envelope so live and restored clients can display it.

## Recovery contract and verification

The existing cold reconciliation owner can select current authority, inspect the
exact retained provider turn and reconcile settled effects after a real policy
change. Reconciliation itself starts no thread, turn, tool or queue dispatch.
It preserves original admission/custody receipts, the accepted historical policy,
command identity and attempt, and uncommitted workspace files.

The regression runs through the actual ordinary local owner, private store and
intercepted native RPC. It changes runtime authority after acceptance, rejects
unknown, missing or mismatched host receipts and account changes, then reconciles
only matching settled evidence. Original failed reads remain failed. Actual live
turn recovery has not been performed by these offline fixtures.

Unsettled commands, unsupported native items, active or mismatched provider turns,
missing acceptance and revoked authority remain blocked. A terminal turn alone
does not prove every action settled. Do not clear recovery records or replay an
interrupted merge, publication or command to make a conversation appear usable.
The next step for a blocked live incident is inspection through its original
account/workspace owner, with explicit evidence for outstanding effects.

No staging environment or live model calls are part of these checks. The tracked
continuation work is the existing Telos R06 item `9d5b5357882fe492`; no new outcome
tree is required.

## Candidate verification

The final affected offline batch passed 799 tests across nine suites, using one
worker and a 1 GiB Node heap. It includes native conversation lifecycle,
approval transport, chat composition, preparation adoption, strict retained
diagnostics, policy composition and cold recovery. Design guards passed 108 tests
with one existing skip. Affected ESLint, formatting and registered source checks
passed. Focused correctness, security and failure-contract reviews verified their
corrections and reported no remaining findings. Full compilation, combined CI
and exact-head Centaur review remain hosted gates; these local results do not
establish acceptance or deployment.
