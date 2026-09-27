# Native completion checkpoints

The owned Codex seat runtime resolves the exact immutable
`SymposiumRecipientAttemptRecord` from the retained EventStore before sending a
turn. It verifies claim, session/delivery, seat, idempotency key, dispatched text and
provenance. A complete v2 execution snapshot is required; legacy records missing
the immutable account binding cannot produce checkpoints. The attempt-registry SQLite database captures a versioned canonical
input envelope containing the attempt ID and dispatch event sequence. This is a
**delivered-input digest**, not a commitment to provider-thread history, system
instructions, tool responses, or the full model context.

After a matching completed terminal observation, the native controller must close
and its exact cleanup must be confirmed. Only then, before returning executor
success, does one database transaction persist exact returned assistant text, its
UTF-8 digest, input envelope/digest, and thread/turn identity. Interrupted or failed
turns, conflicting terminal status, missing cleanup, and changed claims cannot
produce a checkpoint. Inputs and outputs have an 8 MiB UTF-8 bound; malformed UTF-8
string representations are rejected rather than silently hashed as replacement
characters. Only the existing host-owned database is used; no public write API is
added.

The producer does not use `CodexConversation.beforeComplete`: that hook runs before
the terminal observation callback. Both input capture and completion insertion
are idempotent for identical data and reject conflicting data. A failed insertion
rolls back. A crash after insertion but before EventStore recipient completion can
leave a readable checkpoint; this change does not automatically reconcile recipient
state or redispatch. The `get` accessor rechecks durable terminal conflicts on every
read, including conflicts recorded after insertion or through another database
connection. A historical returned object is not a permanent validity authorization.

Checkpoints are **not WorkResult, ReviewReceipt, artifact snapshots, final token or
cost accounting, or evidence of enforced budgets**. The review host remains absent,
`prepareAttempt` remains fail-closed, and publication remains behind its existing
approval and artifact/source-binding requirements. Claude/Vertex is unchanged;
this producer covers the shared Codex API/Personal native path. Existing isolated
fake-conversation tests may omit a claim resolver; real controller launch requires
one. No gateway adoption, credential persistence, or live calls are introduced.

Validation uses temporary SQLite databases and mocked conversations. It exercises
missing/wrong terminal identity, cleanup failure, changed claimed input, identical
and conflicting retries, cross-connection invalidation, and rollback/reopen recovery.
