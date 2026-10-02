# Symposium production migration inventory and application rollback rehearsal

This is a read-only offline gate. It does not start an old application, change
production data, inspect credentials, contact a gateway, or establish physical
quiescence.

After building the server, run on selected offline copies or an explicitly
quiesced source:

```text
node scripts/symposium/inventory-migration.mjs ABS_CONVERSATIONS_DB ABS_EVENTS_DB ABS_SESSION_ARTIFACTS_DB ABS_ARTIFACT_LEASES_DB ABS_CAPABILITIES_DB
```

The Codex conversation database normally lives in the configured private Codex
directory; EventStore is the repository's `.mitzo/events.db`; the artifact and
lease databases live in the owned gateway's stable `stateParent`; the shared
CapabilityService store is `.mitzo/capabilities.db`. The command
opens existing files with SQLite read-only/query-only access. Missing files,
tables or columns are reported as missing coverage; counts that depend on
missing columns are `null`. It lists legacy NULL and explicit
ordinary/Symposium ownership, unresolved command IDs, pending creation recovery
identities, lifecycle fences, executing attempts, imported source session IDs,
and artifact volume identities. It also counts issued admissions, source seals,
artifact reservations, pending retention and `github.publish-pr` operations in
`pending_approval`, `running` or `verification_pending` state. It reports
conversation IDs and statuses without operation IDs or request bodies. Missing
capability store path/schema is unknown, not an empty publication inventory.
It never emits command input,
source-import JSON, lease tokens, provider credentials or publication payloads.

To classify historical NULL ownership on the same offline conversation and
EventStore copies, run:

```text
node scripts/symposium/classify-legacy-ownership.mjs ABS_CONVERSATIONS_DB ABS_EVENTS_DB
```

`provenOrdinary` requires one exact session ID matching the conversation ID,
matching stored account binding and workspace, `session_type='chat'`, no
Symposium config and `symposium_revision=0`. These fields are present in the
historical `6aa2652b` schema. Symposium deactivation retains its nonzero
revision, so a currently ordinary-looking session with Symposium history
remains `unknown`. Missing sessions, changed bindings/workspaces, malformed
bindings and missing discriminator columns also remain `unknown`. The report
does not read command input or emit account IDs, account labels, workspace
paths, configuration JSON or transcript content. It only emits conversation
IDs, fixed evidence/reason codes and missing schema names.

This classification is evidence for operator review, not a migration action.
`automaticConversionAuthorized` is always false. The source files must be
offline and quiescent; separate database snapshots are not an atomic view of
live writes. An unknown row needs external, row-specific custody evidence or
must retain NULL ownership. Do not update production rows from this report
alone.

The application rollback rehearsal has four outcomes:

| Observation                                                         | Result                                              |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| Any upgraded artifact, source, native, cleanup or publication fence | `refused_upgraded_fences`                           |
| Unclassified legacy NULL conversation ownership                     | `refused_unclassified_legacy_ownership`             |
| Pending ordinary commands or missing schema coverage                | `refused_pending_or_unknown_state`                  |
| No observed fence                                                   | `requires_independent_quiescence_and_compatibility` |

Every outcome has `authorized: false`. A clean SQLite result cannot prove that
native execution stopped or that the old executable honors upgraded state.
Legacy NULL ownership is an explicit rollback and migration blocker until
evidence-backed classification; IDs and conversation content cannot establish it.

The disposable rehearsal covers application rollback refusal with seeded NULL
ownership, running command, pending creation recovery, lifecycle fence,
executing attempt, issued artifact, pending source import, artifact lease and
pending publication operation. An 82-row legacy NULL fixture exercises the
ownership gate.
It does not exercise a prior production binary, gateway/config rollback, data
restore, pending publication reconciliation, or actual Podman/launchd state.
Those remain separate migration gates. Preserve all original databases and
physical resources while resolving them; restoring an older SQLite copy is not
an uncertainty recovery procedure.
