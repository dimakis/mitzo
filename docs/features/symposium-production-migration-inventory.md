# Symposium production migration inventory and application rollback rehearsal

This is a read-only offline gate. It does not start an old application, change
production data, inspect credentials, contact a gateway, or establish physical
quiescence.

After building the server, run on selected offline copies or an explicitly
quiesced source:

```text
node scripts/symposium/inventory-migration.mjs ABS_CONVERSATIONS_DB ABS_EVENTS_DB ABS_SESSION_ARTIFACTS_DB ABS_ARTIFACT_LEASES_DB
```

The Codex conversation database normally lives in the configured private Codex
directory; EventStore is the repository's `.mitzo/events.db`; the artifact and
lease databases live in the owned gateway's stable `stateParent`. The command
opens existing files with SQLite read-only/query-only access. Missing files or
tables are reported as missing coverage. It lists legacy NULL and explicit
ordinary/Symposium ownership, unresolved command IDs, pending creation recovery
identities, lifecycle fences, executing attempts, imported source session IDs,
and artifact lease identities. It also counts issued admissions, source seals,
artifact reservations and pending retention. It never emits command input,
source-import JSON, provider credentials or publication payloads.

The application rollback rehearsal has three refusal outcomes:

| Observation                                            | Result                                              |
| ------------------------------------------------------ | --------------------------------------------------- |
| Any upgraded artifact, source, native or cleanup fence | `refused_upgraded_fences`                           |
| Pending ordinary commands or missing schema coverage   | `refused_pending_or_unknown_state`                  |
| No observed fence                                      | `requires_independent_quiescence_and_compatibility` |

Every outcome has `authorized: false`. A clean SQLite result cannot prove that
native execution stopped or that the old executable honors upgraded state.
Legacy NULL ownership needs evidence-backed classification before supervised
ordinary recovery; IDs and conversation content cannot establish it.

The disposable rehearsal covers application rollback refusal with seeded NULL
ownership, running command, pending creation recovery, lifecycle fence,
executing attempt, issued artifact, pending source import and artifact lease.
It does not exercise a prior production binary, gateway/config rollback, data
restore, pending publication reconciliation, or actual Podman/launchd state.
Those remain separate migration gates. Preserve all original databases and
physical resources while resolving them; restoring an older SQLite copy is not
an uncertainty recovery procedure.
