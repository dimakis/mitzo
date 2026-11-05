# FX Audit: historical callback evidence and bounded recovery proposal

Status: **original effect evidence remains insufficient to authorize recovery;
no recovery implementation or activation authorization**. Original inspection:
4 November 2026. Documentation and source recheck: 5 November 2026.
This follow-up is separate from merged
[#1218](https://github.com/dimakis/mitzo/pull/1218), which preserves proven
pre-delegation refusals for new invocations but cannot reconstruct historical
settlement. Source acceptance alone does not prove runtime adoption or recovery
of the recorded FX chat.

## Evidence inspected

The original 4 November inspection used bounded, exact-session queries against the application's
event store through SQLite `mode=ro`, with `query_only=ON`, and the retained
release's source and structured log. It did not instantiate application stores,
read private native storage, invoke a provider, execute a historical tool, or
modify production state. The 5 November documentation refresh checked referenced
Git source and the accepted integration delta; it did not repeat runtime queries
or collect new incident evidence. Private native storage remains uninspected in
this record; any server-owned evidence projection requires separate authorization.

| Identity                          | Retained value                             |
| --------------------------------- | ------------------------------------------ |
| Blocked context chat              | `0050a0e1-7cb8-8754-9a67-c53067868e69`     |
| Diagnostic reference              | `3981a983-63f6-4b9d-860e-a092ef2db48c`     |
| Original application command      | `1885b0f5-535e-4677-ac61-d54d9b20d8f8`     |
| Application tool ID               | `57615a88-b21f-4f85-81c1-2f6f0eb5336e`     |
| Trace                             | `8ccf691d342a531324e5a1384b99cab6`         |
| Context workspace                 | `32154566-c375-80ef-b228-0f956d74c057`     |
| Retained original FX project chat | `66d683f5-be63-8bf1-a4d4-f85c107e87a4`     |
| Original project chat workspace   | `08e20520-1060-5092-aa52-8960fbb6867f`     |
| Inspected release source          | `b8ae361cf64b81f8715d04182a421085a496fb85` |

The original project directory `/Users/dsaridak/tools/fx-audit` is retained. Neither
that directory nor the original project chat replaces the blocked context chat's
command, workspace or native custody.

The saved invocation at event **3896310**, 19:48:22.387 UTC, is exactly:

```json
{
  "endpoint": "/repos/dimakis/fx-audit/pulls?state=all&per_page=10",
  "view": "summary"
}
```

The saved `GitHubRead` result at event **3897134**, 19:50:00.231 UTC, is an error:

> Tool ran, but its post-tool hook failed or was interrupted. Inspect current state before retrying.

The application terminal event is **3897138**, 19:50:00.903 UTC. The error result
therefore precedes the application terminal. This is not the late-result ordering
proved for the existing 30 October incident repair. The log reports
`callbacks_failed` with the selected diagnostic at 19:50:00.899 UTC.

The original admission is retained as `consumed`, mode `agent`, local Codex target
`host-mac-codex`, account `host-personal-subscription`, provider `openai-codex`.
Its account profile revision is
`e11b7d2081c91ab83b7a05dc3dd8f73897df48e0afe9e29fef301f6c65603d39`.
The admission's request fingerprint is
`ordinary-local-codex-v1:b8230f7d029c3d915604818c4f988e12d369c155c6bbfd1427b163600e8bb38b`.
These are historical selection facts, not fresh authority, a native custody
receipt, or proof that GitHub execution was authorized or completed.

Reproducibility hashes of the original serialized application rows:

- Invocation event payload: `ee98f898b8fc52adf0a6c7153f9bbba5867c142369f8ec9000c90609cdbd42c1`.
- Result event payload: `208a432625b5218ca4ac6d77ef9772ebd87f33f523008cbe8b02f51687fa2f59`.
- Original command admission: `9bb0aae84da4f3af38405d1c9d839ce143cd78d4b787f2fbf3543a0056964d22`.

These hashes identify inspected bytes; they are not settlement capabilities.

## Why the existing evidence cannot authorize recovery

At the inspected release, `createNativeToolExecutor` first calls
`authorizeGitHubRead`, which awaits the permission decision and rechecks signal,
input, account/runtime, skill and session-grant authority. It then delegates to
`executeTrustedGitHubRead`. That executor checks current authority before spawning
`gh api --method GET`, and checks cancellation and delivery authority after return.

Both a cancellation before delegation and an exception after delegation reach the
same unqualified native executor error result. `NativeHooks.executeTool` awaits
that result, sets its own `executed` flag, and checks cancellation **before**
normalizing/preserving the result. Its catch returns the displayed error with an
original `unknown` outcome. The hook wrapper's `executed` flag means that its
callback returned, not that the GitHub subprocess started or settled. The old
path does not durably retain that delegation boundary or the pre-wrapper result.

The `host_tool_execution` log measures the whole lifecycle request, including
approval and tool handling; it is not an executor-entry receipt. Absence of a
permission-response log does not prove a refusal: retained grants, other control
paths and incomplete diagnostics cannot be excluded by log absence. The tool's
GET-only name, the error wording and its 98-character length cannot settle it.

Accepted main now includes #1218's cancellation fix and #1214's public GitHub
read path. These later contracts do not supply original executor or settlement
receipts for this invocation. The historical source analysis above remains pinned
to the inspected release, rather than inferred from current behavior.

## Exact evidence still required

| Required proof                         | Current evidence gap                                                                                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native invocation identity             | Native command/attempt, thread/turn/generation, original call ID and request hash are not inspected. The application tool ID alone is insufficient.                                                                                 |
| Executor boundary and original outcome | No inspected trusted receipt proves refusal before delegation or terminal settlement after dispatch. No pre-wrapper result is available. The old source does not guarantee either was persisted elsewhere.                          |
| Original custody and policy            | Application account/workspace selection is available; original operator ownership, physical provider home, accepted native policy, workspace/adoption witness and hook contract still require qualification by their server owners. |
| Complete continuation scope            | Exact native terminal, completion phases, all original tool receipts, queue identities and other unresolved dispatch/ownership/effect records are not inspected. Application completion is not native settlement.                   |
| Current authority                      | A future inspection/application must revalidate the current signed operator, account/revocation, target, workspace, startup ownership, cancellation and response delivery. Historical admission grants none of these.               |

Private records are **uninspected**, not declared absent. A later inspection may
still find only the wrapper's unknown result. If original positive settlement
evidence was never retained, new code cannot reconstruct it safely.

## Bounded next implementation proposal

1. Add an **inspection-only** case for this exact incident under the existing
   server-owned callback recovery infrastructure. Reuse its authenticated operator
   policy, repository startup mutex, ordinary conversion hold, source qualification
   and private ledger owner. Do not generalize the existing incident's apply
   allowlist or initialize missing custody/workspace state. Keep default-disabled
   operator enablement separate from deployment and use.
2. Select the retained command and tool from server-owned records. Bound the
   inspection to one command/attempt, at most 128 original native items/tool
   receipts and 32 KiB of redacted output; budget overflow refuses. Use pinned
   source/rollout fingerprints and stable file identity. Recheck current authority
   at each I/O and response boundary. Return identity hashes, evidence categories,
   and explicit missing-proof reasons, never credentials, raw provider history,
   supplied filesystem paths or a client-asserted settlement bit. Open no new
   actor/provider turn and do not pump the queue.
3. Only if independently retained original evidence proves the exact operation
   settled, prepare a separate reviewed reconciliation case. Reuse the existing
   inspect/plan-hash/apply transaction, backup, audit, idempotence and final writer
   checks; preserve the original tool error and history. Do not copy the
   30 October exception: it proves a different tool, source, account, ordering,
   native identity and queue. Any unresolved or dispatched effect without positive
   settlement remains blocking. The current evidence does **not** qualify this step.
4. After separately authorized activation and successful qualified reconciliation,
   continue only through the existing Mitzo chat and its normal explicit
   continuation/admission. Neither a merged PR nor an inspection starts FX work.

No generic recovery override is proposed. `Reconnect and continue` handles
qualified interrupted turns and cannot override an explicit unknown receipt.
The currently implemented incident endpoint only accepts
`ce932ac5-186e-87be-96b6-e09968c5d87f`; substituting this FX chat is refused.

## Economical offline regression plan

Use one shared original-incident fixture through the actual authenticated router,
startup owner and private store, with one worker. Before substantial Node checks,
measure fresh RAM, macOS pressure, `memory_pressure`, `vm_stat` and swap trend;
select a command-local heap from measured headroom. Unavailable, warning or
critical pressure, or growing swap, limits local work to focused checks with a
heap of at most 1 GiB; broad validation belongs in CI. No live model calls or
broad local builds are proposed.

- Both cancellation before delegation and dispatched cancellation can produce the
  same public wrapper error; neither qualifies without original positive proof.
- Exact original positive proof may qualify only its matching identity, source,
  account, policy and workspace. JSON copies, log strings, missing/mismatched
  receipts, partial effects and another incident cannot manufacture proof.
- Changed/revoked account or operator, cancellation, live/startup owner, workspace
  or policy changes, a stale plan, changed queue and final-lock/delivery races
  refuse. Budget, source-file and parsing failures remain fenced.
- Inspection leaves receipts/history/queue byte-for-byte unchanged and produces
  zero provider calls, tool executions, new actors or FIFO dispatches. Any later
  qualified apply preserves the original results and has audited exact-repeat
  semantics; uncertain application is inspected before another mutation.

No production recovery code was changed and no tests were added merely to mirror
this proposal. Existing source guards were inspected; executable regression
coverage belongs with the independently reviewable implementation once evidence
access and eligibility are established.

## Preparation history and landing boundary

The original 4 November worktree started at accepted
`8d4b39520dbc5f76f5c145039af7d67083cc7447`. At that preparation boundary, #1218 was
held at `0760922beaac7b8dde93c0efb5e3d4ff260e3d39`, and this document waited for
the coordinator's release after #1203, #1218 and #1215. Those are historical
sequencing facts, not a current merge hold.

On 5 November, #1218 was confirmed merged as
`fc7e1fffe949a56c21570cca390a1c710ef2032d`, and the selected batch completed through
#1191 at `a07969c6e47cbeb5fc9ba6c4a97b54471ab991bf`. This document's landing
candidate integrates that accepted main. Its user-authorized merge still requires
combined CI and trusted exact-head Centaur LGTM, a `merge` recommendation, zero
blocking findings and the required App-bound status. Document acceptance grants
no recovery implementation, private-custody inspection, receipt mutation, queue
dispatch or runtime activation; FX work continues through Mitzo.

A single quota read during the original preparation reported 4,863 core requests remaining
and the next core reset at **5 November 2026, 00:14:30 UTC**. This is an observation,
not a reservation of shared quota. No status polling followed it.

Sources: the selected application's event/admission rows above; retained release
`logs/server.2026-11-04.142957.log` lines 20240, 20428 and 20431–20434;
`server/native-tool-executor.ts`, `server/native-hooks.ts`,
`server/github-read-approval.ts`, `server/trusted-native-operation.ts`,
`server/owned-codex-lifecycle-bridge.ts`, `server/local-codex-observation.ts` and
`packages/harness/src/permission-handler.ts` at the inspected release; and
[the supported recovery contract](callback-completion-recovery.md),
`server/callback-incident-repair.ts`, `server/callback-incident-evidence.ts`,
`server/callback-incident-store.ts` and `server/codex-conversation-store.ts` at the
preparation base. Verification is limited to the stated inspection date and
sources; source inspection is not proof of private production custody or effects.
The 5 November source recheck used accepted
`a07969c6e47cbeb5fc9ba6c4a97b54471ab991bf`; it does not renew the original
runtime observations or qualify the proposed reconciliation.
