# Context measurement capability matrix

Inspected 21 November 2026 against accepted `dimakis/mitzo` main
`805fbd9c9e4ce4fed60da643bf73e6a48f5c3772`. Repository `AGENTS.md`, `CLAUDE.md`,
Boy Scout and CI discipline apply. This is source/offline qualification only.

Claude Agent SDK is declared and installed as `0.3.322`. Its `sdk.d.ts` declares
`getContextUsage({detail: 'summary' | 'full'})`; `sdk.mjs` forwards a
`get_context_usage` control request. Omitting detail defaults to **full**, which
invokes per-category token-count APIs. Summary uses last-response usage and local
estimates without those per-category calls. This inspection made no such call.

Native Mac Codex source pins `0.160.0`, artifact SHA256
`112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b`, in
`server/codex-native-artifact-qualification.ts`. Open PR #1420 proposes 0.171.0;
it is not accepted-source evidence. Actual OpenShell binary/version was not
inspected; Mac artifact qualification cannot qualify the container.

| Engine / placement | Native owner and occupancy evidence                                                                                                                                                                                      | Categories and drilldowns                                                                                                                                                                                                                      | Capacity, compaction and refresh                                                                                                                                                                                       | Unsupported or unqualified                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude / Local Mac | `chat.ts` → `sdk-turn-query.ts` → Agent SDK. Existing query loop reports parent response input/cache usage. New port accepts an existing native query; structured context estimates are not wired to a session endpoint. | SDK declares kind-classified categories, memory files, MCP tools and agents, optional skills/system tools/system-prompt sections/deferred tools/MCP instructions. Current normalizer conservatively marks estimates and opaque drilldown refs. | Explicit summary control; separately authorized full. Preserve resolved raw/usable windows, reserve and free observations. Existing `modelUsage.contextWindow/maxOutputTokens` supplies separate model-limit evidence. | Method/type presence does not prove CLI support or service compatibility. Real summary/full responses and costs, native owner exposure, idle/retired behavior and endpoint delivery remain unqualified. |
| Codex / Local Mac  | Native App Server; `codex-session-events.ts` consumes `thread/tokenUsage/updated`, `codex-turn-usage.ts` validates total/last. `last.totalTokens` is latest-response accounting, not current occupancy.                  | Input/output/cache/reasoning only; no category/file attribution in inspected event owner. Host assembly is provenance, not occupancy.                                                                                                          | Event-driven refresh. Optional modelContextWindow; absent/invalid capacity remains unknown. No granular context-refresh control qualified.                                                                             | No current-occupancy total, compaction reserve or precise source attribution demonstrated. Native integration and live notifications not tested by this slice.                                          |
| Codex / OpenShell  | Existing `codex-app-server-client.ts`, `openshell-runtime.ts`, `openshell-lifecycle-controller.ts` and sandbox App Server entrypoints. Pure adapter accepts the same event fixture for this placement.                   | Same reduced request-accounting fixture; no inferred categories.                                                                                                                                                                               | Existing attached-owner events; do not start a runtime to inspect. Capacity remains separate from compaction policy.                                                                                                   | Actual container artifact/version, event delivery and ordinary runtime operation remain unqualified here. Passing fixture normalization is not transport parity.                                        |
| Claude / OpenShell | Ordinary runtime unsupported/unqualified. A Symposium-specific launcher does not establish ordinary support.                                                                                                             | Unavailable.                                                                                                                                                                                                                                   | Unavailable; no allocation or token-count fallback.                                                                                                                                                                    | Existing runtime dependency `d6c89fbaa86354d6` plus lifecycle `e76c84742da6c0bf` must deliver and qualify ordinary support first.                                                                       |

`server/session-control-support.ts` independently labels Codex and Local Claude
as recorded-usage-only and ordinary Claude/OpenShell as route-not-qualified.
The context port does not upgrade that product projection.

## Wrapper and attribution evidence

- `chat.ts:adaptSdkQuery` validates events and binds methods to their original
  receiver. Generic control passthrough is not a capability guarantee.
- `sdk-turn-query.ts:createSdkTurnQuery` retires and replaces native queries on
  later inputs. A retained bound generic method can target the old query.
  The new port requires the actual current query and checks identity before and
  after awaits; native query exposure remains a propagation handoff.
- `sdk-query-retirement.ts` authenticates host retirement events by object
  identity. Provider JSON must not manufacture that boundary.
- `query-loop.ts` separates parent input/cache context from subagent windows.
  Its current gauge is response-derived; the new schema does not relabel it.
- `sdk-query-usage.ts` accumulates accounting counters across fresh SDK queries;
  capacities are metadata, not additive usage.
- `model-token-limits.ts` and protocol `token-limits.ts` retain runtime/provider/
  catalog sources and stale/unknown capacity. Reuse them instead of model-name
  heuristics. `runtime-readiness.ts` owns readiness observations.
- Host boot/context recipe and read/search inventories describe assembled or
  historically consumed sources. None proves native retention after compaction.

## Existing work screened

The open PR response returned 62 entries (page size 100). No title identified a
granular context snapshot implementation. Neighboring PRs include #1418 (Claude
restart), #1417 (query-loop diagnostics), #1371 (Claude retries), #1253 (controls)
and #1067 (Symposium first-command context). This title screen is not a complete
code-overlap audit; integration must revisit actual touched owners.

PR-monitor architecture slice `d55d0cc700b64680` records reviewed local design
through `5b40118c96d882767f39c897d7e17dc5edad9eab`. That completion does not prove
runtime implementation or merged source. Its shared Claude/OpenShell dependency
is reused unchanged; this slice creates no runtime or canonical owner assignment.
