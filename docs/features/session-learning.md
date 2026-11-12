# Session learning foundation

Status: first implementation slice, 12 November 2026. Local source and offline
fixture evidence only. This is not accepted knowledge, a rollout receipt, Telos
assignment, production activation, or completion of the learning feature.

## Policy contract

Mitzo owns `sessions.learning_policy` in its existing controller event store.
Absence on an older row means version 1, Auto, revision 0, exclusion watermark 0.
Unknown or malformed policy fails validation. Provider histories do not own it.
Normal session metadata updates cannot overwrite it. Session metadata, listing,
and reconnect snapshots include the policy; reopening the event database retains
it. Model/reasoning metadata changes preserve it.

| Mode                   | Foundation behavior                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auto (default)         | Agent guidance requests significant sourced candidates at meaningful milestones. Zero candidates is normal. No implicit extraction model, account, workspace, source, or audience enrollment.          |
| Deep learning (`deep`) | Same incremental capture, plus a durable `historyRequest` bounded by `afterSeq` (exclusive) and `throughSeq` (inclusive). `pending_worker` means requested, not analyzed. The full worker is deferred. |
| Off                    | Reject new candidate capture, including explicit “remember this.” Return no learning guidance or source identifiers. Reading accepted Knowledge remains available under its existing authority.        |

Changes use an interactive operator API, not an agent mode-changing tool:
`GET /api/sessions/:id/learning`; `PATCH` with `X-Mitzo-Learning-Intent: set-mode`
and `{mode, expectedRevision}`. Existing operator authentication applies. A stale
revision returns 409. No desktop/phone learning control is introduced in this
slice: the API explicitly reports incomplete integrations.

Off immediately blocks candidate capture and invalidates queued evidence through
the current controller event watermark. Leaving Off advances the watermark
through everything recorded while Off. These exclusions are monotonic: changing
to Auto or Deep never re-enrolls them. A reply that began or contains events before
the watermark is excluded even if its completion arrives later. Accepted knowledge
is not deleted; removing it requires its separate correction/retirement workflow.

Changing the persisted account identity or workspace advances the same exclusion
watermark, increments policy revision and cancels an earlier history request.
Returning to the original identity cannot revive old candidates. New eligible
messages may produce new candidates. A different audience cannot be selected by
an agent. Deep → Auto/Off cancels the previous history request. Repeating the
current mode with its current revision is a no-op, not another analysis job.

An in-flight provider may still have earlier advisory text in its context.
Controller capture checks the current policy regardless. Codex application context
is rebuilt for every turn admission, including continuation after compaction;
learning guidance is not installed as immutable thread instructions. SDK and API
adapters use the same guidance in their composed system prompt. Their prompt
refresh boundary is adapter admission/recreation; SDK preset append survives
compaction. Live mode-switch/compaction behavior for every engine is not claimed.

## Candidate interface and receipts

`CaptureMemoryCandidate` is registered through the existing local host service,
API/OpenShell credential tool, SDK MCP and selectable agent-tool catalog paths.
Existing profile selection, skill restrictions, operator authority, cancellation
and runtime checks remain in force. The live adapter's account/workspace must
agree with persisted controller identity. The tool cannot enable learning.

1. `action: sources` returns at most 100 recent eligible public message anchors,
   with `messageId`, `eventSeq`, role and original observation time. Use
   `beforeSeq` to request earlier anchors. No reasoning, tool payload, media or
   arbitrary provider transcript is returned.
2. `action: capture` requires `candidate`: UUID `requestId`, exact `sources`
   (`messageId`, `eventSeq`), `kind` (`decision`, `correction`, `discovery`,
   `question`), `attribution` (`user_statement`, `agent_interpretation`, `proposal`,
   `outcome`), bounded `text`, optional `rationale`.
3. Only this conversation's unqualified user messages or completed public
   assistant text are eligible. Thinking deltas, tool results, seat histories,
   nonexistent/mismatched anchors and excluded message histories are rejected.
4. The controller derives source session/account/workspace and stores scope
   `unclassified`, provisional status, citations and policy revision. This source
   scope grants no processing enrollment. Candidate wording remains an unverified
   attributed claim; a citation does not prove its semantic correctness.
5. One SQLite transaction writes the existing `memory_candidate` event and its
   `session_learning_captures` receipt. The receipt says `stored` and
   `knowledgeStatus: provisional`, with its durable event sequence. It says
   nothing about extraction, review, acceptance, publication or later retrieval.
6. Retry the same request ID and payload after a lost response/restart. It returns
   the original receipt while still eligible; changed payloads conflict. Off,
   revocation and source changes are rechecked before replay. Generic event append
   rejects `memory_candidate` writes that bypass this interface.

An aborted transaction leaves neither event nor receipt. An interrupted response
after commit can be reconciled by the same request. Failures return `isError`, a
stable stage/code and a recovery instruction to the real tool consumer; structured
logs contain session identity and sanitized cause type, never candidate text or
private reasoning. Settings failures return a visible conflict/unavailable HTTP
response. A promise to remember is never storage acknowledgment.

## Current-state audit

Inspected immutable reference source without changing the MGMT/ContexGin checkouts:

- Mitzo base `1b333750a` from freshly fetched main, independent clone and task branch.
- MGMT local `origin/main` snapshot `c9063c7662676c816c56bc70bbb4db8f862df74f`.
  Its working checkout was older (`c90c49b8`); no parent planning worktree was used.
- ContexGin local `origin/main` snapshot `80485df995cffd58cbff8217e55b89630d3b2b74`.
  These MGMT/ContexGin refs were not refreshed from their remotes in this task.

“Source” below means implementation was read. “Tested” means offline tests ran
in this task, not evidence that a service adopted that source.

| Stage                    | Source evidence and result                                                                                                                                                                                                                                                                                    | Verification                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Controller conversation  | Mitzo `packages/protocol/src/event-store.ts`, replay and metadata stores retain public events independently of provider/runtime.                                                                                                                                                                              | Source; existing event-store/replay regressions tested.                       |
| Agent candidate          | MGMT `mgmt_lib/memory_mitzo.py` already accepts `memory_candidate` as **unverified assistant evidence**. Mitzo had no producer found in the audited base; this slice adds the policy-checked producer.                                                                                                        | Source; new producer, transactional receipts, exclusion and replay tested.    |
| Source selection/capture | MGMT `_controller_source`, `capture_mitzo`, `revalidate_mitzo_sources`: explicit private host enrollment for database, account allowlist, workspace roots and scope. Ordinary chats only; completed text reconstructed without media/tool results. Bounded pages, rewind and ledger event IDs recover/replay. | Source only for MGMT. Live enrollment/coverage unknown.                       |
| Evidence ledger          | MGMT `mgmt_lib/memory_ledger.py`: capture receipts, scoped streams, privacy holds, leases and batch states. Unclassified/restricted evidence cannot enter generic model context.                                                                                                                              | Source only. No private ledger inspected.                                     |
| Extraction/consolidation | `mgmt_lib/memory_pipeline.py`: `extract`, `collect_notes`, `prepare_changes`, current-source checks, original lineage, provisional interpretations, separate model/account selection and zero-claim support.                                                                                                  | Source only. No model calls or maintenance worker started.                    |
| Draft/review/acceptance  | Pipeline `materialize`, `send_for_review`, `acknowledge_main`: owned maintenance worktree, recoverable writes, explicit review send, canonical-main content/hash acceptance. Profile/pattern changes remain proposals. Existing exact-head Centaur and CI gates remain required.                              | Source only for MGMT; no review/acceptance action.                            |
| Publication              | ContexGin `src/server/publication/{routes,publisher}.ts`: authenticated/signed ingress, accepted-ref acquisition, durable delivery IDs and immutable snapshots. MGMT `docs/knowledge-publication.md` describes its pinned runtime conversion.                                                                 | Source only for external services. Service versions and health unknown.       |
| Selection/adoption       | Mitzo `knowledge-publication-bridge.ts`, `openshell-runtime.ts`, `codex-chat-session.ts`: authenticated canonical reconciliation, exact revision/manifest verification, pinned conversion, provider acknowledgment and separate adoption receipt.                                                             | Source; bridge offline regressions tested. No live adoption receipt obtained. |
| Next-session retrieval   | MGMT `memory_context.py`, `memory/scripts/memory.py`: published-view selection, source receipts, search/read freshness and supersession filters. Native hooks distinguish selection from model adoption.                                                                                                      | Source only. No behavioral recall case or live retrieval verified.            |

The npm ContexGin compiler dependency in Mitzo is pinned to `683f9007…`; that
revision lacks the newer publication-route file inspected above. A separately
configured publisher service must not be inferred from the npm dependency or
local checkout. Actual publisher/builder/runtime pins need supported diagnostics.

No supported production diagnostic connection was attached for this learning
pipeline; selected diagnostic-tool discovery exposed none. Private host databases,
credentials, worker enrollment files and provider homes were not inspected.
Production capture, extraction account/model, review backlog, publication health,
consumer adoption and useful recall therefore remain **unknown**, not failed or
passing. Source inspection is sufficient for this foundation, not rollout.

## Verification and remaining integration

Tests ran with fake providers, offline fixtures, one worker and a 1 GiB Node heap.
The final focused regression run passed **411 tests in 12 files**, covering both
controller event-store suites, metadata parity, the three learning suites, actual
Codex/SDK composition, Knowledge tools, tool catalogs and publication bridge.
Red phases demonstrated missing policy/tool APIs and then actual exclusion/source
identity failures. Coverage includes restart/reconnect metadata, model-setting
changes, mode revision conflicts, Off/reenabling, interrupted transaction rollback,
lost acknowledgment/replay, source identity changes, hidden-source rejection,
operator revocation during asynchronous preparation, visible storage failures,
actual Codex prompt composition and fake SDK query composition for all modes.

The legacy metadata extraction oracle is compared on every old field; only the
two new learning policy fields are projected out. Dedicated learning tests assert
their defaults and persistence. Tool inventory fixtures include the new tool.
Reviewed source fingerprints were refreshed, with the new modules included; this
integrity update is not a Centaur approval. Workspace package typechecking passes.
The full server typecheck exhausted the required 1 GiB local heap; full server
typecheck/build and required CI remain pending. No paid model test was run.

**Off is not enforced end to end yet.** The existing MGMT collector can still read
enrolled raw conversation events without consulting `learning_policy`. Its
current revalidation knows account/workspace/cohort scope, not this new session
watermark. Do not present or activate an exclusion guarantee until the next slice
enforces it at capture, dispatch, response/save-back and export boundaries. The
candidate API enforces the controller portion now; it cannot revoke a separate
already running collector's authority. Existing accepted knowledge is distinct.

## Concrete next slice

Build the MGMT policy bridge test-first using local controller/ledger fixtures.
Read this contract and `mgmt_lib/memory_mitzo.py` at the stated source revision.
Consume versioned controller policy, hold Off sources and batches immediately,
enforce message-span exclusions and monotonic watermarks, and revalidate policy
plus current cohort/account/workspace/audience before model dispatch, response
delivery, save-back and Git export. Preserve existing enrollment, privacy replay,
lease and review receipt ownership. Unknown policy versions must fail closed.

Add a durable request/processing receipt for Deep's eligible historical interval,
with crash recovery and source lineage. Deduplicate against existing ledger IDs;
do not count repeated summaries as new confirmation or re-enroll excluded history.
Keep worker/account selection independent of the conversational engine. Prove a
candidate and raw-conversation batch queued before Off cannot be dispatched or
published after it, including across restart and workspace/account transitions.

Then add honest desktop/phone controls and stage-specific progress using the
existing UI contract. Recent provisional evidence retrieval, a review dashboard,
profile promotion, semantic retrieval changes, rollout and cross-runtime behavioral
evaluation remain separate work. Recomposition of retained SDK/API contexts after
mode changes needs explicit adapter coverage before universal lifecycle claims.

When a supported standalone Telos feature ID becomes available, its owner needs:
this document, the originating conversation `d6e8a1dc-064a-845b-a070-a9698037f838`,
this ordinary working session, exact implementation commits and verification
results, plus the remaining boundaries above. Attach through the supported reviewed
source/role flow. No feature/slice ID or dedicated Telos role binding is claimed.
Publishing a PR, source acceptance, merge, enrollment and production activation
retain their separate authority and receipts.
