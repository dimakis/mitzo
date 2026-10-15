# Assigned agent tasks: persistence contract

Assigned tasks extend the existing Agent Library. They are separate from `/tasks`
execution-tree rows: taskboard orchestration and Telos integration retain their
existing behavior. Reusable instructions, context recipes and portable tool
references stay in published Library profiles. A task binds an exact owner-scoped
profile ID, revision and content hash, plus its objective, execution intent,
workspace/source references and notification/output policy.

## Owner and storage

`AgentTaskStore` uses the same `.mitzo/events.db` as published profile revisions.
Initialization adds `agent_task_revisions` and `agent_task_retries` without
rewriting legacy profiles or taskboard tables. Each edit appends an immutable
revision; deletion appends a tombstone and reserves the identity. Historical
revisions remain available to future run admission. There is no purge endpoint.

An immediate SQLite transaction verifies the expected revision and exact profile
binding, appends the task revision and commits its retry receipt together. A retry
with the same key and validated input returns its original result, even after
later edits, deletion or restart. Reusing that key for different input or another
operation returns 409. Failed writes consume no revision or key. Changing a
profile binding requires an explicit task edit; publishing profile r4 leaves an
existing task on r3.

The existing event-owner SQLite backup captures both new tables, retry receipts
and the referenced published profiles together. Its watermark detects task writes
from another connection and invalidates a concurrent capture. No extra database,
catalog or backup adapter is needed. Restore the `mitzo-events/store.db` member
through the existing backup procedure; reopening the task store preserves IDs,
revision history, owner scopes and retry behavior.

## Authenticated API

| Operation               | Route                             | Input                                                           |
| ----------------------- | --------------------------------- | --------------------------------------------------------------- |
| List active definitions | `GET /api/agent-tasks`            | none                                                            |
| Read current definition | `GET /api/agent-tasks/:taskId`    | none                                                            |
| Create                  | `POST /api/agent-tasks`           | `taskId`, `expectedRevision: 0`, `idempotencyKey`, `definition` |
| Replace definition      | `PUT /api/agent-tasks/:taskId`    | `expectedRevision`, `idempotencyKey`, `definition`              |
| Delete                  | `DELETE /api/agent-tasks/:taskId` | `expectedRevision`, `idempotencyKey`                            |

Responses contain the exact saved task record, revision, definition, deletion flag
and creation/update timestamps. List returns active records. A missing or deleted
current definition returns 404; stale revisions, hash mismatches and conflicting
retry keys return 409. Invalid or extra fields return 400. Mutation requests require
same-origin JSON. Internal agent tokens cannot substitute for interactive operator
authentication.

POST requires `expectedRevision: 0`; PUT requires a positive expected revision.
Neither operation can substitute for the other. Rejected requests write no task
revision or retry receipt; an exact create retry still returns its original record
after later edits.

HTTP uses the existing single-operator stable `user` subject shared by the Library,
never a caller-supplied owner or rotating login JTI. The store/service require an
explicit trusted owner and isolate all reads, writes, profile lookups and retry
keys by it. Multi-user HTTP subject resolution must evolve together with Library
authentication if that product model changes.

Controllers forward only five enumerated `agentTasks.*` IPC operations to the
canonical custodian. Unsupported paths and aliases are fenced from local fallback;
controllers do not initialize a task store. The existing authenticated channel
checks epoch/revocation at dispatch; the router rechecks authority before work.

## Configuration is dormant

Incomplete tasks can retain an empty objective and null execution/workspace and
have configuration state `draft`. Complete intent is `blocked` with reason
`admission-unavailable` until the execution slice qualifies it. Configuration
state is owner-derived and cannot be supplied by the client.
Execution settings reuse existing account/provider and harness contract fields,
with model, thinking level, logical target and authority references. Saving them
does not qualify a route, verify an account or grant permission. Credential values
and arbitrary runtime configuration have no fields in this contract. Admission
must later resolve the retained selection against the trusted runtime catalog;
unavailable selections must remain visible without substitution.

`schedule: null` means on demand. A schedule retains numeric five-field cron,
IANA timezone and `state: paused`. Enabled schedules are rejected in this slice:
activation requires the later reviewed admission and occurrence fences. CRUD
creates no run, session, resource allocation, provider request or scheduler.
Run/occurrence types reserve the boundary for later slices; no run endpoints exist.

## Validation evidence

The first implementation artefacts were the store/service and API tests. Their
initial run failed because the task modules did not exist. Tests and implementation
land together. Coverage includes exact r3 pinning across r4 publication, deliberate
profile updates, owner isolation, reopen, competing connections, stale edits,
durable retries, deletion, legacy profile compatibility, incomplete configuration,
closed authenticated transport, revocation, no inference on CRUD, backup restoration
and invalidation on concurrent writes. All providers are fake; this slice requires
no live model or staging deployment.

Remaining delivery: Library UI/shared settings (slice 2), qualified ordinary-session
run admission and receipts (3), scheduler/calendar recovery and activation (4),
Agent Builder task adapters (5), integrated product/route acceptance (6).
