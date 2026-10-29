# Authority observations at native turn boundaries

The 29 October 2026 follow-up retains the existing admission, bootstrap, workspace
and native-reader owners. An observation contains current data for immediate pure
comparisons; it is never a retained authorization result or a substitute for an
effect's fresh current-owner checks.

| Boundary                   | Owner and identity                                                                                                               | Observation and failure rule                                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role projection            | Existing Telos role/guidance owner; conversation and account binding                                                             | One fresh, narrowly selected event prefix supplies both role and guidance comparisons. The next call reloads durable records and rejects newly retained conflicts.                                                                                                                                                                  |
| Command admission          | `OwnedLocalCodexChatAdmission`; exact actual EventStore, conversation, command, account, workspace and selected lease            | Mutable lease/current callbacks run first. EventStore then reads command execution admission, original send, session/runtime and role records in one synchronous read transaction. Wrong store/session, changed payload, permission, workspace, context or receipt refuses.                                                         |
| Native host context        | Existing signed native callback, operator, runtime and exact command/attempt/thread/turn/generation/call                         | The context consumes admission's session/runtime/role observation immediately. It continues to qualify native custody, pending tool, live session, permissions, skill and operator authority at each boundary.                                                                                                                      |
| Adopted repository custody | `RepositoryWorkspaces` and `PreparedRepositoryWorkspaceOwner`; exact adoption facts, child command, task and SQL primary pointer | One read transaction owns the adopted ledger and competing ordinary-primary check. The ledger's UNIQUE conversation pointer and original adoption witness qualify the same record used by the pure reservation comparisons and workspace owner. The next boundary reads SQL again.                                                  |
| Physical topology          | Existing qualified workspace read owner, barrier scope, native reader and `LocalRepositoryReadAccess`                            | One owned helper captures topology, parses bounded captured configuration, compares expected identities/edges and verifies entries/bytes/absences while retaining descriptors. Fresh absolute-chain checks refuse substitution during parsing. Scratch, cancellation and entry/post-effect credentials remain with the same reader. |

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
| One linked or standalone current-topology phase through the native factory | 2 physical helpers                                                     | 1 physical helper, including parser-wait postconditions                                           |
| Bootstrap lease + qualified reader + barrier + topology + cleanup          | 9 native `account/read` RPCs                                           | 6 fresh native `account/read` RPCs                                                                |
| Reader-owned topology phase                                                | 6 full credential fences                                               | 3: scratch creation, helper entry and helper result                                               |

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
custody operation. They do not measure end-to-end preparation latency, keychain
reads or shared event-loop delay. SQL and physical helper/RPC counts are
deterministic acceptance gates; elapsed time is supporting evidence only.

The tests compose actual signed host/admission owners with synthetic provider
transport, use an independent better-sqlite3 connection to change permission
after an await, and corrupt the adopted workspace witness through a separate SQL
connection after repeated observations. Both the next synchronous fence and the
full asynchronous fence refuse. Existing focused tests retain account/logout/
expiry, dirty-edit/commit, root/gitfile/commondir/HEAD substitution, cancellation,
owner-function substitution and cleanup/lifetime refusal checks. No real model,
staging, production database or running conversation is involved.

## Owned physical topology phase

Fresh native current-topology callers now enter one factory-owned assertion.
The existing descriptor helper retains anchors while running Git's exact
configuration grammar with bounded captured stdin, fixed argv, `--no-includes`,
an isolated environment and `/` as its cwd. Repository text cannot select the
executable, environment, file paths or options. The same existing process group
owns the parser's timeout/cancellation and is joined before scratch disposal.

Before returning, that phase compares the retained task/source/common/admin
identities, Git edges, branch HEAD, current reference, index kind and shallow/
alternate restrictions. It checks captured bytes and metadata again and reopens
absolute no-follow chains to catch replacement hidden by a live original
descriptor. The old native JS configuration-parser and second verification-helper
path is removed from these callers. Creation/publication qualification retains
its distinct receipt/hash checks and independent effect boundaries.

The private weak-map facet recognizes only the exact frozen factory reader;
proxies and descriptor copies cannot supply it. Every assertion starts a fresh
physical phase, with the original credential/account owner before and after the
effect. The outer qualified read scope and barrier still requalify on entry,
cleanup and exit. No result authorizes a later effect or another assertion.

The composed physical benchmark uses the actual bootstrap lease, qualified read
owner, barrier, factory, fixed Python/Git helper and cleanup. Provider transport
is synthetic, and bootstrap/catalog setup is outside each measured phase. The
same runtime, one worker and command-local 1 GiB heap were used for five fresh
phases per source. Git commits/hooks and other tests were held during this
comparison; an earlier attempt with possible hook overlap was discarded.

All five baseline phases returned successfully. The baseline test exited 1 only
after collecting and printing the samples, because its nine RPCs per phase
failed the new six-RPC regression budget. The bootstrap wrapper therefore logged
the test assertion as failure; it was not a failed physical phase or a retry.
The implementation completed all five phases and passed the same new budget.

| Measurement, milliseconds per phase       | Before                                 | After                                  |
| ----------------------------------------- | -------------------------------------- | -------------------------------------- |
| Repeated rounds                           | 476.13, 436.97, 410.34, 422.74, 418.71 | 342.22, 327.51, 303.12, 306.49, 308.49 |
| Median of five rounds                     | 422.74                                 | 308.49                                 |
| Sampled p95 (maximum of five rounds)      | 476.13                                 | 342.22                                 |
| Native `account/read` RPCs in every phase | 9                                      | 6                                      |
| Physical helper processes in every phase  | 2                                      | 1                                      |

These account RPCs are fixture credential-owner refreshes, not real model calls
or keychain measurements. The helper still owns its bounded Git grammar parser
child. The counts above measure physical helper invocations, not every process
in the process group. No production latency attribution follows from these five
local samples.

The adversarial fixture holds the actual helper at its Git-parser wait and
substitutes configuration, HEAD, task gitfile, commondir or task root. Every case
refuses. Other tests cover unsafe Git grammar, malformed/duplicate packed refs,
non-JavaScript Unicode trimming, post-effect cancellation/credential revocation,
actual bootstrap account change, and an independent SQLite writer changing the
real adopted workspace ledger while the native helper awaits. Legitimate dirty
work/commits and large unconsumed index/reflog files remain usable.

Local pressure and swap sysctl readings were unavailable in the sandbox;
`memory_pressure -Q` and `vm_stat` were inspected. The conservative fallback was
one worker and a command-local 1 GiB heap. Required broad combined checks and
review remain delivery gates; these results establish no runtime activation.
