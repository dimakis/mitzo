# Parallel startup and immediate send feedback

The naturally occurring October 24 new-chat trace on release `3517978b955f`
reached provider dispatch at 9.690 seconds and first output at 11.574 seconds.
Its HTTP receipt took 9.258 seconds. The earlier observed chat took 28.343 seconds
to dispatch and 30.937 seconds to first output. These are observational samples,
not controlled runs with identical remote/provider conditions.

The selected newer trace is `f980dfa064f77ccd2420f3728ed85d9c`, beginning at
17:18:44.349 UTC. Reading that existing trace did not submit another prompt.

## Remaining startup cost

| Observation                                   |      Duration |
| --------------------------------------------- | ------------: |
| Fresh native executable version subprocess    |       2.014 s |
| Keychain reads before dispatch, 34 calls      | 1.304 s total |
| Repository fetch                              |       0.877 s |
| Native executable capture                     |       0.650 s |
| Uninstrumented interval during MCP/tool setup |       2.314 s |
| Native thread creation RPC                    |       0.656 s |
| Provider dispatch to first output             |       1.884 s |

These are selected operations and intervals, not an additive complete breakdown:
parents and some operations overlap. Source selection, bootstrap and admission
have enclosing spans. The old trace's initial 14.526 seconds only has phase-level
attribution; its missing leaf timings cannot be recovered retrospectively.
New metadata-only `mcp.startup.connect` and `mcp.startup.list_tools` spans separate
each configured source's cost without recording paths, credentials or errors.

## Independent work now overlaps

- Configured host MCP servers connect and discover tools concurrently. Pagination
  within each source stays ordered; catalogs merge in configuration order. The
  aggregate count/byte limits, source-specific grants, currentness checks and
  close/cancellation ownership remain enforced, including late connectors.
- Local source refresh and runtime qualification start together after source
  selection and access checks. Failures abort and settle siblings. The original
  fresh authorization still runs after the join and before persistence.
- OpenShell's initial provider inventory and profile catalog reads start together.
  Attestation, later re-observations and final ownership/account/readiness checks
  retain their original ordering.

Local source preparation covers Codex subscription/API, Claude/Vertex and Gemini.
The OpenShell change covers its supported Codex subscription/API accounts.
Unsupported runtime/account tuples are not enabled. Mitzo's custom OpenAI
Responses runtime is excluded from this optimization effort; Gemini's shared
plumbing remains supported. The shared MCP helper retains its existing callers.
Final credential checks are not moved ahead of awaited work that could make an
earlier credential observation stale.

## Immediate composer feedback

The shared composer removes submitted text from the visible input upon local
enqueue, while the existing optimistic transcript and Sending status display it.
The original persisted draft remains until an exact receipt. Failure/uncertainty
reveals it; later typing, dictation, identical pasted text and attachment/context
edits remain protected from the older receipt. Text ownership is tracked separately
from full-payload ownership so resource edits cannot resurrect submitted text.

The server-only improvements need a backend release. The composer change also
needs updated web assets; the bundled iOS client needs a new client build. No
deployment, staging operation or model-backed test is part of this change.

## Native first-execution diagnostic

Three paired offline samples used fresh private copies of the reviewed native
executable, disposable homes, and an OS sandbox that denied network access,
real-home/Keychain reads and writes outside the fixture. Isolation was proved
before native launch. Only `initialize`/`initialized` were permitted, followed by
stdin-EOF shutdown; no account, credential, model, thread or turn operation ran.

Median version-plus-initialize time was 2,237 ms, versus 2,193 ms for direct
initialize. Repeated version checks on the same executable took 41–53 ms. Thus
deleting the version preflight saves about 44 ms in this sample and moves most
of the observed two-second delay into initialization. The exact OS subsystem
responsible was not identified. Reusing a verified executable needs a separate
ownership/integrity/lifecycle design; caching version success alone does not
solve the measured cold-copy cost.

Offline deferred-operation tests prove concurrency and retained safety boundaries.
Intercepted browser tests hold HTTP pending, assert empty input plus visible user
message within one second, then verify recovery on failure/uncertainty across the
supported account routes. They do not measure backend dispatch or model latency.
Post-change live dispatch and first-output timings remain unmeasured; this patch
does not establish subsecond cold startup.
