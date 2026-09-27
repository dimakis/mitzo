# Native turn observations

The owned native Codex adapter records provider acceptance and terminal notifications in the private attempt registry. This is a diagnostic observation ledger, not a ReviewReceipt, WorkResult, enforcement receipt, or admission capability.

An acceptance records the exact existing reserved claim and session, seat and membership generation, captured account binding and Symposium provenance, and provider thread/turn identity. The accepted identity is immutable. Repeated identical acceptance and terminal notifications are idempotent; conflicting identities or terminal statuses fail closed. Only the matching `turn/completed` callback can record `completed`, `interrupted`, or `failed`. Transport loss, an interrupt request, process exit, sandbox deletion, and controller cleanup do not establish provider completion. Controller cleanup retains its independent registry state. An `accepted` observation with no terminal timestamp means no terminal notification was recorded; it does not claim the provider is still running.

The live conversation retains exact completed turn identities after clearing active work. Identical duplicates are ignored; a conflicting matching terminal notification closes the conversation and records `terminalConflict: true` durably for the original claim. The first observed status and timestamp remain historical facts, but must not be used as completion evidence when this flag is set. This also fences a late conflict while a newer turn is active; it does not mark that newer turn provider-terminal.

Usage is persisted explicitly as `usageStatus: unknown` and `observedUsage: null`. The current terminal callback does not carry attested final per-turn usage. This ledger does not treat the last token sample, cumulative thread totals, missing usage, or numeric zero as a final token count or hard budget proof. It contains no credential material, response text, artifact identity, cost, or invented enforcement ID. Existing native hard-cap and review-admission gates are unchanged.

`SymposiumAttemptRegistry.observations.get(claimToken)` reads an observation from the host-owned registry. There is no new HTTP endpoint or cross-owner catalog. Only the actual native adapter writes observations; client payloads cannot submit them.

## Durability boundary

Rows survive closing and reopening the **same private SQLite registry file**. The current owned bootstrap creates its attempt registry under `gateway.stateDirectory/native-attempts`, and fresh gateway custody uses a fresh state directory. This change does not adopt old live authority, relocate old registries, or automatically expose old observations through a newly bootstrapped app. Historical access across fresh-custody restarts needs a separate owner-authorized design. Full app restart acceptance remains unproved.

## Validation

Mocked native callbacks and local SQLite tests cover acceptance, immutable revisions, exact claim/thread/turn matching, terminal idempotence, conflicting statuses, cleanup independence, unknown usage, and reopening the same database. No live OAuth, model request, or gateway operation is part of these tests.
