# PR #1342 reconciliation

14 November 2026. Ordinary delivery conversation
`059e312d-4552-89ed-83e8-1009eeea3c0c`, explicitly requested by Dimitri. Existing
#1342 is the sole delivery vehicle. Formal Telos lead/worker assignments and
active slice IDs remain unchanged. No duplicate PR, backlog or worker is created.

## Source and custody

Initial remote #1342: `b2675af8199ab8a99f3628d3d93c4e65145c7244`, branch
`feat/session-controls-contract`. Initial accepted main:
`19aa8a19b274ae1fee416f0f187c772111251366`. The isolated checkout uses local
`task/claude-parity-1342`; publication uses an explicit refspec to the existing
PR branch. Original commits/authorship remain ancestors; no force push is needed.

The first accepted-base merge reconciles structured approval cancellation from
#1351 and Stop/pre-input/FIFO/terminal behavior from #1348 with the immutable
command ceiling. The second composes accepted #1349 at
`0ad803cdae56ed6e22c89273ae800d3e7aeb9706`: information helpers and all three Telos
artifact/startup/final-delivery corrections remain intact. The reviewed-source
manifest retains every accepted key and adds only residual source/test entries.

The merge coordinator acknowledged this ordinary session's custody and retained
order #1350 → #1353 → #1342, with parallel preparation and no released #1342 turn.
#1350 owns native positive selection and failed-turn Retry, including retained
original context and uncertain-effect refusal. #1353 owns service composition.
Neither is reimplemented here. Their accepted changes must be integrated before
final combined validation. Reporting/device and adjacent Symposium scopes remain
with their owners.

## Coherent residual

- TaskExecution catalog/SDK callback/managed handler selection, canonical bounded
  grant reuse and profile-dependent routing guidance.
- Shared successful-completion notification ownership, preserving central policy
  and deduplication plus the standalone legacy fallback.
- Strict skill/dependency parsing and immutable original-command ceiling through
  the existing admission ledger, FIFO/query binding, callbacks and managed
  handlers. Public restricted prompt execution remains visibly unavailable.
- Existing Access support labels: recorded context usage is limited; optional
  user branching/rewind remain unavailable.

Composition identified missing direct command-ceiling checks in newly accepted
Telos handlers and the existing web helper. Real MCP regression calls reproduced
short-name/empty-ceiling bypass and missing retirement checks before the fix.
The composed handlers now use exact wire names and existing authority callbacks,
including renewed effect/delivery checks. No alternate permission owner was added.

## Offline verification and limitations

Native setup uses this checkout's existing `prepare-development.mjs --install`:
Node24.22.3, npm11.18.0, pinned SDK0.3.322. TaskExecution status returned no grants;
the user explicitly selected native execution after historical executor network
failures. No executor retry or inherited grant is claimed.

All local Vitest runs use one worker and a 1 GiB Node heap. Retained raw logs are
in the delivery conversation workspace, outside the Git working tree:

- `focused-boundaries.log`:130 tests pass across five suites (task effects,
  original FIFO/command/query ceiling, profile retirement, permission handler).
- `focused-composition.log`:231 pass;19 startup cases fail while fixtures inspect
  denied host `.mitzo` paths. These are not green claims. Small attempted offline
  fixture adjustments did not remove that dependency and were reverted. No private
  host access or production configuration was acquired.
- `information-composition.log`:119 pass across five suites after accepted1349
  composition, including real information/Telos/web MCP calls, API admission and
  the existing task effect fixtures.
- `stop-ceiling-composition.log`:five command-boundary cases pass, including
  restricted Stop-before-input → retained FIFO Continue with a deny-all successor.
- `task-all-profiles.log`:21 task tests pass, including default and explicit
  profiles plus exact exclusions across personal Claude, Vertex and API accounts.
- `residual-public-boundaries.log`:368 tests pass across nine existing suites:
  public skill refusal, parser/dependencies, composer replay, Access controls,
  session launch/prompt operations and WebSocket admission.

Some suite counts overlap and must not be summed. Hosted gates will be recorded
after completion. Synthetic
providers/process effects/push transports are distinct from live model/account,
service-write, physical-device, adoption or deployment qualification.

## Delivery checkpoint

Initial published candidate `1c9174bdc` is mergeable and preserves the original
remote history. CI43600568696 caught a fixture inference cycle after the accepted
`beforeInput` return changed from void to boolean. Explicit return/owner types
break that cycle without changing behavior. A scoped semantic TypeScript check
of the fixture and three affected handler sources reports zero diagnostics.
Source fingerprints pass; the full server build remains a hosted gate after
the local1GiB heap exhaustion. Preflight's printed native-failure lines are
expected negative-control output from its Python fixture tests, not additional
native test failures. Automatic Centaur7468 is queued on the failed CI; no
duplicate review was dispatched. Prior job7356 was skipped at the cycle cap.

Current combined-head CI, trusted Centaur final LGTM/merge with zero
blockers, required independent permission review, actual coordinated turn and
head/base-fenced merge remain required. The old #1342 Centaur report at
`183951ef` identifies Symposium authorization replay; inspect superseding accepted
behavior and retain review continuity rather than treating the old report as a
current approval. Initial hosted CI failures were a Telos oversized-brief timeout
and mobile-WebKit draft-value assertion; dependent aggregate failures add no new
root cause. Preserve those logs; current-head CI remains decisive.

Deployment, live provider/service writes, scheduled messages and worker starts
are outside this delivery.
