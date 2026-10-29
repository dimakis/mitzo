# Authority observations at native turn boundaries

The 29 October 2026 follow-up retains the existing admission, bootstrap, workspace
and native-reader owners. An observation contains current data for immediate pure
comparisons; it is never a retained authorization result or a substitute for an
effect's fresh current-owner checks.

| Boundary                   | Owner and identity                                                                                                               | Observation and failure rule                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role projection            | Existing Telos role/guidance owner; conversation and account binding                                                             | One fresh, narrowly selected event prefix supplies both role and guidance comparisons. The next call reloads durable records and rejects newly retained conflicts.                                                                                                                 |
| Command admission          | `OwnedLocalCodexChatAdmission`; exact actual EventStore, conversation, command, account, workspace and selected lease            | Mutable lease/current callbacks run first. EventStore then reads command execution admission, original send, session/runtime and role records in one synchronous read transaction. Wrong store/session, changed payload, permission, workspace, context or receipt refuses.        |
| Native host context        | Existing signed native callback, operator, runtime and exact command/attempt/thread/turn/generation/call                         | The context consumes admission's session/runtime/role observation immediately. It continues to qualify native custody, pending tool, live session, permissions, skill and operator authority at each boundary.                                                                     |
| Adopted repository custody | `RepositoryWorkspaces` and `PreparedRepositoryWorkspaceOwner`; exact adoption facts, child command, task and SQL primary pointer | One read transaction owns the adopted ledger and competing ordinary-primary check. The ledger's UNIQUE conversation pointer and original adoption witness qualify the same record used by the pure reservation comparisons and workspace owner. The next boundary reads SQL again. |
| Physical topology          | Existing qualified workspace read owner, barrier scope, native reader and `LocalRepositoryReadAccess`                            | Existing scratch custody, cancellation, credential checks and anchored capture/verification remain. Root/gitfile substitution, revocation and changed metadata continue to refuse.                                                                                                 |

The void assertion entry points remain for existing callers. They delegate to the
same observations; there is no parallel assertion implementation. The prepared
owner no longer reloads the same record with `getForConversation`, re-enters the
reservation owner, or performs a second initial observation before starting its
physical validation. Each independent effect/await boundary still requalifies
current authority. No checked flag, TTL, recursion bypass or process generation
replaces external SQLite or filesystem state.

## Deterministic budgets and repeated evidence

Regressions were observed failing before their implementation. Counts are per
operation in the named fixture, not production attribution.

| Workload                                                                   | Before                                                                 | After / regression budget                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Role plus guidance projection                                              | 2 context-event reads                                                  | 1 fresh context-event read                                                                        |
| One signed native-host synchronous fence, without a native base-read facet | `getSession`: 8; `getSessionRuntimeBinding`: 5; role-event reads: 3    | 6 / 4 / 2, plus one shared admission observation; these are method counters, not total SQL counts |
| One real qualified prepared-owner `get()`                                  | 9 SQLite `get` reads                                                   | 2 SQLite `get` reads: current ledger and competing ordinary primary                               |
| Three adopted-custody assertions                                           | 9 complete ledger-row reads                                            | 3 complete ledger-row reads                                                                       |
| 500 adopted-custody assertions                                             | 500 repeated conversation traversals and 500 reservation-owner entries | 0 / 0; their pure checks consume the owning observation                                           |

The prepared-owner benchmark used the same real SQLite/Git fixture, one worker,
the same Node 24.22.2 runtime, a command-local 1 GiB heap, and five rounds of 100
calls after priming immutable data projections. The baseline source was restored
temporarily in an exclusive validation window, then the implementation was
restored in a `finally` block before other validation resumed.

| Measurement, milliseconds per 100 calls | Before                            | After                             |
| --------------------------------------- | --------------------------------- | --------------------------------- |
| Repeated rounds                         | 45.77, 42.17, 42.21, 37.58, 38.77 | 26.27, 21.20, 22.30, 19.66, 20.46 |
| Median of five rounds                   | 42.17                             | 21.20                             |
| Sampled p95 (maximum of five rounds)    | 45.77                             | 26.27                             |
| SQLite reads in every round             | 900                               | 200                               |

These small local samples demonstrate lower work and latency for this bounded
custody operation. They do not measure end-to-end preparation latency, helper
spawns, keychain reads, native RPCs or shared event-loop delay. SQL counts are
deterministic acceptance gates; elapsed time is supporting evidence only.

The tests compose actual signed host/admission owners with synthetic provider
transport, use an independent better-sqlite3 connection to change permission
after an await, and corrupt the adopted workspace witness through a separate SQL
connection after repeated observations. Both the next synchronous fence and the
full asynchronous fence refuse. Existing focused tests retain account/logout/
expiry, dirty-edit/commit, root/gitfile/commondir/HEAD substitution, cancellation,
owner-function substitution and cleanup/lifetime refusal checks. No real model,
staging, production database or running conversation is involved.

## Physical-phase work still open

This change does not claim the complete authority redesign. Topology still uses
one anchored capture helper followed by a verification helper. Between them the
existing metadata inspector runs Git's bounded configuration parser as an
independent subprocess await. The second helper detects same-inode HEAD,
gitfile, commondir and configuration changes during that interval. Removing it
without moving the relevant parsing/topology comparison into the actual owned
helper phase would weaken the substitution contract.

The next physical phase must keep the same native-reader provenance and anchored
descriptors while owning config parsing, topology comparison, entry/post-effect
credential checks, cancellation and scratch cleanup. Then migrate the actual
ordinary/prepared/cold owner compositions and remove their redundant traversal.
The current two-helper and credential/RPC costs remain unoptimized and must be
measured on that composed path. No authorization cache or extra service is
introduced as a substitute for that work.

Local pressure and swap sysctl readings were unavailable in the sandbox;
`memory_pressure -Q` and `vm_stat` were inspected. The conservative fallback was
one worker and a command-local 1 GiB heap. Required broad combined checks and
review remain delivery gates; these results establish no runtime activation.
