# Pending native review evidence

`SymposiumReviewAttemptStaging` and `parseUntrustedReviewOutput` are host-only
building blocks. They are not wired into native dispatch, the trusted review host,
or any public route. They cannot produce `ReviewReceipt`, `WorkResult`, final
usage or a completed seal. Pending results explicitly remain untrusted.

The caller must supply a stable private-custody database and a synchronous
validator that checks the existing workflow reservation, selected account/model,
seat generation and current authority. This adapter does not reserve or charge
budgets: `SymposiumReviewStore` remains the budget ledger. A stored enforcement ID
or seal ID is only a reference, never evidence that enforcement or sealing happened.

The immutable link binds the owner/session/workflow/reservation, attempt and native
claim, selection/profile/generation/authority, exact input and artifact commitments,
source seal reference, runtime capability/version and permitted output scope.
SQLite uniqueness and immediate transactions enforce exact replay and prevent
claim/turn reuse. Dispatch uncertainty is durable before a future caller dispatches;
a false transition result is never permission to retry. Provider acceptance binds
one exact thread/turn. Conflicting identities or final items permanently taint the
pending result. Reopening the database preserves uncertainty and taint.

Structured review output is limited to 64 KiB, 64 findings and 64 resolved
fingerprints. Fields and lists have independent bounds. Strict parsing excludes
model-supplied workflow, account, attempt, authority or artifact identifiers.
Criteria, evidence references and resolved fingerprints must be in the host's
immutable scope. Exactly one final complete item may be staged from the accepted
turn; exact replay is idempotent. Instruction-like finding text is inert untrusted
data, never an instruction or a source of authority. The exported JSON schema is
available for later native outputSchema integration; no provider call is enabled.

## Remaining joins and blockers

A future trusted host still needs authoritative native completion and final usage,
proven hard token/cost enforcement, the matching unsettled workflow reservation,
and a completed physical seal before any receipt or work result is promoted.
Checkpoints and latest usage snapshots do not satisfy those contracts. The
inspected native app-server interface does not yet establish the required hard
budget/final usage capability. Subscription cost is not assumed zero.

Completed physical sealing drains the writer and retains the volume. Existing
publication expects a live writer lease, so a reviewed sealed-export path is still
required. An accepted fix needs a new writable generation forked from the retained
sealed parent; removing the retention fence is not a substitute. This adapter does
not solve or obscure those integration gaps.
