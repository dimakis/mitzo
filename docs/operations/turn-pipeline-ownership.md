# Turn pipeline ownership and work budgets

Source baseline: `9929f4671991` (28 October 2026). This is an offline structural
follow-up to the session lifecycle audit supplied on that date. The concurrent
history-search, SSE, overview and Connections changes are owned by another task;
this branch neither copies their implementation nor claims their validation.

## Ownership model

Keep authoritative effects at explicit boundaries. Projection code consumes
observations and owns only its derived state. It must not initialize application
stores, reload credentials or re-enter admission while updating text or blocks.

| Stage                        | Owner                                                      | Responsibility and lifetime                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command admission            | `send-command.ts`, ordinary runtime/selection owners       | Exact command, account, workspace and permission selection; new commands obtain fresh authority.                                                       |
| Preparation                  | `codex-admission-preparation.ts`, context/knowledge owners | Run under the existing lifecycle reservation; settle concurrent work before releasing ownership.                                                       |
| Provider text projection     | `CodexSessionEvents` → `CodexTextProjection`               | Retain item identities for duplicate/substitution rejection; only the active item retains its text and reconnect offset.                               |
| Live message projection      | `MessageStreamState`, used by `query-loop.ts`              | One index owns block identity, input accumulation and the objects in the ordered reconnect snapshot. The open set owns completion.                     |
| Persistence and delivery     | `query-loop.ts` / EventStore / ConnectionRegistry          | Persist before broadcast. Stream identities, receipts, suspension and watcher ownership remain here.                                                   |
| History/reconnect projection | `conversation-transcript.ts`                               | Consume one caller-owned event prefix. Preserve provenance, late results, partial messages and legacy output semantics without opening runtime stores. |
| Completion                   | Query loop and existing lifecycle owners                   | Project each block stop once; provider terminal receipts and actual dispatch/cleanup remain distinct.                                                  |
| Background maintenance       | Existing overview and Connections owners                   | Separate from turn projection; concurrency changes belong to the concurrent lifecycle task.                                                            |

`chat.ts` retains compatibility exports for transcript callers. The REST consumer
imports the pure module directly. The legacy SDK and durable-event formats still
have distinct readers: their missing-event, metadata and initial-prompt behavior
differs. A single configurable reducer has not been substituted without proving
those compatibility rules. Their terminal projection is shared.

## Implemented reductions

- Codex text flush and reconnect no longer traverse completed items. Completed
  bodies and renderer IDs are released; compact kind/turn identities remain for
  duplicate and substituted-event rejection. Identity retention still grows with
  item count; this change does not claim constant session memory.
- The query loop no longer maintains independent current-message identity,
  block-ID map, tool-input map and open-block counter. Indexed entries reference
  the actual snapshot blocks. Closing an unknown or already closed index is a
  no-op, so duplicate stops cannot complete another block. Forced completion
  visits the open set, and completion releases input buffers.
- Replay reconstruction moved out of `chat.ts`. Both durable readers share a
  terminal projection that visits each finished message at most once during one
  replay. Tool results and subagents are resolved from the exact input prefix
  before that projection; later calls reconstruct afresh. No cross-request cache
  or authority reuse was introduced.
- Legacy SDK reconstruction parses each content array once and reuses its parsed
  representation to attach late results. Temporary parsed data lives only for
  that reconstruction call.

## Deterministic regression evidence

These are instrumented operation counts, not elapsed-time speedups or production
attribution. Each regression was observed failing against the original behavior
before its corresponding implementation change.

| Workload                                                                                            | Before                                     | After         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------- |
| Start reasoning, replay its prefix, start a tool and flush after 10/100/1,000 completed Codex items | 43 / 403 / 4,003 map-entry visits          | 0 / 0 / 0     |
| Two interleaved query loops, each with 100 blocks, a delta per block and forced completion          | 10,100 snapshot block-ID reads per session | 0 per session |
| History or reconnect, 1/10/100 turns with two terminal events per turn                              | 2 / 110 / 10,100 terminal message passes   | 1 / 10 / 100  |
| Legacy SDK tool call and later result                                                               | 4 content-array parses                     | 2             |

The two-loop fixture also checks output isolation, retained snapshot content and
exact message/block completion counts. Existing composed tests exercise the
actual native event mapper, query loop, SQLite EventStore, delivery acknowledgements
and replay, including a held acknowledgement and failed prefix write. Existing
reconstruction tests cover seat attribution, reused IDs, delayed results and
partial turns. This is not the complete competing-maintenance acceptance workload.

Focused regressions run with one Vitest worker and a command-local 1 GiB Node
heap. Changed-path type diagnostics, lint, formatting and runtime source pins are
checked separately. Full builds, broad tests, combined-base CI and trusted review
remain delivery gates. Offline results do not establish activation or deployment.

Combined local validation on 28 October: 10 focused files, 220 tests passed.
All changed TypeScript paths passed focused type diagnostics and lint; formatting,
diff whitespace and source-artifact verification passed. The broad repository
build/typecheck remains a CI gate under the Mac's resource policy.

## Remaining structural work

The source inspection still finds nested authority traversal in
`native-host-tool-context.ts`, `owned-local-codex-chat-admission.ts`, the selection
owner and frozen-host bootstrap. These callbacks can observe or mutate external
SQLite and filesystem state. A passing earlier check cannot authorize later work.
This branch removes no admission, credential, provenance or revocation checks.

The next authority refactor should give each operation an explicit read/effect
boundary: a store-owned coherent read returns the bounded rows needed by pure
comparisons, while dispatch and physical helpers retain fresh checks on entry
and after their effects. Keep generic/mutable callbacks outside shared read
observations. No caller-supplied checked flag, TTL cache, recursion-depth cache or
process-local generation can prove external state is unchanged. Before adopting
that interface, characterize ordinary, prepared, cold-resume and changed-account
paths using actual owners, including external-writer mutation and cancellation.

Other remaining work is explicit:

- Context-block loading still reads the entire file before truncation. Extract a
  bounded reader with UTF-8 and marker compatibility evidence.
- Replay still has retained-error grouping searches and subagent tool-result
  scans. The terminal budget above does not establish that all replay is linear.
- The large query loop still owns usage, subagent routing, persistence and
  notification orchestration. Future extractions must remove competing state or
  repeated work, rather than add forwarding layers.
- Measure event-loop delay, serialized bytes, inserts and queue depth while two
  synthetic sessions compete with history, tools and slow maintenance. Keep
  deterministic count budgets separate from repeated timing measurements.

The existing maintainability outcome `8e11f4cb25ce5c8a` supplies continuity for
shared lifecycle boundaries. Its saved 10 October brief is historical context,
not evidence that these changes have landed. Symposium's current source guide
and feature owner remain authoritative for collaboration behavior. This work
does not create another feature or scheduler owner.
