# Context measurement implementation handoffs

This slice supplies [contract v1](context-measurement-contract.md), pure adapters,
offline fixtures and the [pinned capability matrix](../operations/context-measurement-matrix.md).
It does not build a second runtime, session API, usage counter or composer UI.

## Propagation — `9683053156990fed`

Extend existing token/session update ownership under `ab5edf8fca9c4c9e`.
Use `ContextMeasurementSchema` and the pure normalizers at the adapter boundary.
Expose the actual active native Claude query and its generation through an
authorized current-owner accessor for `inspectClaudeContext`. Do not pass the
stable `createSdkTurnQuery` proxy as proof that its underlying query is unchanged.
Retire pending observations on the authenticated host retirement event and
model/account/runtime/turn changes. Persist identity and freshness, not just counts.

Test first through real propagation consumers: late response after query
retirement, account/model replacement, parent/subagent separation, malformed
control reply, absent capability, stale reconnect and unsupported placement.
Validate service authorization before requesting data and again before publishing
to the correct session. Avoid polling; summary is explicit and full is separately
authorized, with no automatic fallback. A blocked inspection must remain visible.

## Composer ring — `b08acd7f246ad19a`

Consume validated propagated measurements after those regression tests pass.
Reuse the approved composer and token display patterns. Label estimated context,
latest-request usage, stale evidence and unknown capacity distinctly. Do not turn
Codex latest total into current occupancy, invent free space, or make category
drilldowns additive. The current port intentionally exposes only opaque source
references; an authorized source resolver remains separate work.

Historical inventory `0880117e42734402` may supply labelled read/search/source
history. It is not current occupancy or evidence that content survived compaction.

## Shared runtime dependency

Reuse `d6c89fbaa86354d6` as the ordinary Claude/OpenShell runtime dependency,
with `e76c84742da6c0bf` owning lifecycle work under native-harness feature
`477c9d52d200c0f6`. Account routing `0d7dbc820e14e56d` and readiness
`65129503d34b4bc3` retain their owners. This matches PR-monitor architecture
`d55d0cc700b64680` under `a2869b81e5a6a75d`; no duplicate runtime is proposed.
Do not mark the fourth matrix cell supported because the other three normalize
fixtures or a Symposium Claude seat exists. Ordinary runtime delivery, artifact
qualification and authorized session probes are required.

## Delivery and qualification limits

The contributor is an ordinary implementation chat and changes no canonical
Telos lead/worker assignment. The initial managed checkout request failed before
start at the account's eight-unfinished-preparations limit. Its receipt is retained
in chat/Telos; ordinary native clone inside the admitted workspace was subsequently
used under existing filesystem authority and a bounded TaskExecution grant.
No private preparation record was edited and no cap was bypassed or raised.

Focused tests use one worker and a 1 GiB Node heap. Fixture success establishes
contract/control behavior only, not a live SDK/CLI/provider or four-route runtime
qualification. No generation or token-count call is needed for these tests.
Live tests must declare the exact supported Luna model and charged account before
execution; unavailable Luna or another model requires approval. Landing still
requires CI and Centaur's exact-current-head final LGTM/merge recommendation.
Publication is separate from merge, deployment and product adoption.
