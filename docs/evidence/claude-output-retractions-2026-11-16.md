# Claude output retraction evidence

## Current independent-review correction

The complete independent review of `710e2e872e87096126a79be04efd7496262a6b6e`
against accepted `6d320beb1ba543773db7ca16e5825fd25c29cb6d` recommends KEEP:
the projection owners form one coherent change. It requires four corrections,
reproduced as seven failing TypeScript cases plus a failing actual Swift
decoder/phone-relay/Watch consumer. The earlier frozen-prefix control passes.

| Owner                 | Current correction and evidence                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK/query correlation | Retain the original parent stream ID separately from rendered row IDs. Qualify every per-block SDK envelope against that stream before binding the actually observed row. Ordinary SDK, live parser and cold replay cover both adjacent stop orderings, final notices and supersedes, with thinking/text/tool activity.                                                                                                   |
| Public history/search | Share the existing SQL receipt/audience validator with collaboration sources. Apply selected-prefix withdrawals before text enters JavaScript, including receipts beyond the page and query look-behind. Existing indexes, scan/output bounds and cursors remain; invalid ordinary identities refuse the read. Explicit legacy `view: events` remains original audit text, documented separately.                         |
| Native Watch          | Shared Swift decoding and phone relay retain validated message/session/tool identities. The existing Watch view model projects receipts through late frames and delayed history, preserving user input, known tool activity, another running response and the draft. Foreign/attributed receipts cannot erase output. Failed history reads preserve content and show a safe retry message with classified native logging. |
| Fallback scope        | Explicit local/unsupported fallback scopes cannot consume ordinary mappings; absent/session scope remains compatible. Negative controls verify a later valid notice can still use the retained mapping.                                                                                                                                                                                                                   |

Initial focused qualification passes **405 tests across 15 files**, zero failures
or skips, with one worker and a 1 GiB heap. Workspace protocol/harness/client
builds and scoped lint pass. The real Shared/Watch receipt harness executes and
typechecks against the Watch SDK without launching a simulator or model. Its
expanded fixture initially omitted a required tool-result message ID; that
harness decoding failure is retained and corrected, not a product finding.
An exploratory query-plan assertion incorrectly required a new index name;
inspection proved the existing indexed owner already provides the required
session/message/sequence seek. No new index or schema migration is needed.

Targeted independent verification then reproduced a remaining live-consumer gap:
adjacent normalized blocks could receive the same timestamp-based synthetic row
ID. The live reducer deduplicated the later tool row even though cold projection
retained known execution. With the clock pinned, the expanded consumer fixture
retains **two failing cases and 14 passing controls** before correction. Fresh
UUID-based synthetic row identities now preserve known tools in both live and
cold projections; the affected query/SDK/correlator/consumer batch passes **150
tests across four files**. Source fingerprints are renewed at
`v1.0.1222-claude-retraction-consumers.1`. These batches overlap the initial count.

Native combined CI remains unresolved: original job `133107185290` timed out a
30-second nested PublishPreparedRepository helper with unknown effects. Its
diagnostic/command/call identities remain in the coordinator checkpoint. A local
reproduction stopped at a non-escalatable private-account selector fence before
repository setup; it did not reproduce or explain the hosted timeout. No unknown
operation was replayed and no deadline was weakened. Fresh combined CI, bounded
independent correction verification and exact-head trusted Centaur approval are
still required. This source candidate is not activation or live acceptance.

The sections below retain historical witnesses and overlapping test counts;
they do not supersede this current matrix or establish additional acceptance.

Source candidate, 16 November 2026. This document records offline source and
consumer evidence, not runtime activation or live model/account acceptance.
Base: accepted `18d1d4a3e0d8bfdc654cce84d7fa828483582735`.

## Reproduced failure

The pinned SDK 0.3.322 advertises `SDKAssistantMessage.supersedes` as wire UUIDs
of previously delivered assistant or tool-result frames, with the complete audit
list in `system.model_refusal_fallback.retracted_message_uuids`. The existing
query consumer ignored both. A native-query double feeding the actual ordinary
SDK adapter, query loop, EventStore and live/cold projections reproduced both
views retaining replaced response text. The original RED probe and receipts are
retained in the reporting owner's ignored test-results and `/private/tmp`.

## Source behavior

The query-loop-owned bounded correlator binds native UUIDs only to already
observed public assistant identities or their same-command tool results. Parent,
session, provider, identity-conflict and completed-command fences apply. Unknown,
oversized or partially correlated receipts produce a sanitized nonfatal diagnostic
with the original event retained under its reference; they never erase guessed
output. Multiple native frames sharing an API message require complete observed
coverage before removing that response. Native identity caches are bounded at
512; a receipt batch is bounded at 256. Missing or invalid wire identities mark
the whole observed aggregate incomplete. Once binding/quarantine eviction loses
identity history, further correlation stays unavailable until the command result
resets the lifetime; a forgotten UUID cannot be rebound to a guessed new output.

Verified retractions append a durable `message_retracted` projection event.
The live parser validates identity and rejects attributed or cross-session frames.
Shared live/cold projection removes replaced ordinary response text/thinking,
retains known tool and child activity, and replaces an explicitly retracted tool
result with fixed text while clearing its old image/error presentation. User
inputs, attributed seats, host agent messages, original EventStore bytes and tool
effects remain intact. Receipts survive stale REST restoration and late output;
clearing the conversation clears its projection receipts. Reconnect snapshots
cannot reintroduce a verified removed response.

Canonical full and bounded transcript responses carry the verified retraction
receipts from that exact immutable prefix. The API client validates their ordinary
identity; the still-current history request applies them before the existing
merge/restore owner, so a missed live event cannot retain old text or tool results.
The existing current-session/request/cursor/live-suffix fences remain. Empty legacy
history alone grants no deletion authority. Malformed canonical receipts retain
known content and expose the existing history-recovery error.

This does not enable model fallback, retry a provider request, change a selected
model/account or create execution authority. Legacy SDK JSONL reconstruction is
unchanged; this qualifies canonical EventStore live and cold projections.

## Verification

- 313 checks pass across retraction, actual SDK/query live and cold consumers,
  existing transcript/reconstruction/query suites and design guards; one existing
  conditional design check is skipped. One worker, 1 GiB Node heap. The native
  query alone is mocked; provider selection covers Personal Claude, Vertex and
  API, each with and without a tool result. These are six consumer scenarios,
  not six charged model calls.
- Identity tests cover malformed/unknown/child/foreign/conflicting receipts,
  aggregation, bounded eviction, duplicate final audit lists, result-turn fences,
  attributed/user/host preservation, tool results/images, stale restore and
  running successor state. Original audit text remains in EventStore.
- Strict standalone typing of the new correlator and protocol module passes;
  scoped ESLint, formatting, complete source fingerprints and whitespace pass.
  Full hosted typing and combined CI remain required.
- Accepted startup #1368 is the actual branch base. The retraction-owned source
  has no overlap with its startup/Google changes; no pending reporting branch was
  absorbed. The SDK's optional replacement-context hook is retained.

## Independent findings and correction

The full independent review of exact `490d724b2570c03a454126d2290486a6593e61f3`
inspected the entire source delta and owning consumers, retained the 313-check
baseline plus 196 distinct owning-consumer checks, and found THREE blockers:
missed-live-receipt REST recovery retained old output; a missing wire fragment
did not invalidate aggregate coverage; and the conflict branch bypassed the
quarantine bound. Passing old fixtures were not treated as acceptance of these
findings. Independent defect probes and the original full report remain retained.

The correction reproduces all three as four failing regressions before repair:
two actual canonical-reader/API/store foreground cases, incomplete aggregate and
1024-conflict memory bound. A further negative reproduces forgotten-UUID rebinding
after bounded eviction. The correction preserves unknown identity instead of
inventing a target. Final coverage includes both foreground and bounded reconnect,
the exact prefix before/after a receipt, newer live blocks/running state, stale
HTTP after live receipt, a conversation switch, malformed/attributed receipt
rejection and command-result reset. The transport alone is mocked for history
recovery; actual EventStore, transcript reader, API client and store owners run.

Current correction verification is recorded in the PR and retained JSON under
`/private/tmp/claude-1373-correction-*`. A preliminary newer-live assertion tried
to JSON-serialize a Map; its failure is retained, and the corrected assertion
inspects the actual streaming block values and identity. No production defect
or fence change is inferred from that fixture mistake. Scoped lint, standalone
new-module typing, formatting and source fingerprints remain required and checked.
Retain the complete independent baseline; only bounded correction verification
is pending, alongside exact-current-head CI and trusted final review.

Final combined correction qualification passes 250 checks across nine suites,
zero failures/skips. Two additional replay regressions first fail on the draft
correction: sequenced projection receipts incorrectly rebuilt a whole turn and
dropped known tool activity, and receipt-induced block changes preserved an old
streaming copy after canonical message completion. Projection-only suffix actions
now remain edits to their original row, and current-owner comparisons are made
before applying canonical projections. Both original RED witnesses are retained;
the final combined run includes these cases, complete native-identity overflow
handling and the original SDK/live/cold consumers. Earlier baseline counts overlap
and are not summed. No browser or broad hosted build result follows from this run.

## UI design and remaining gates

The later trusted report on `99db` (`5915008332`, recommendation
`human_decision`) also identified CEN-ABB1191CF7D3: registered inline output
pins still carried withdrawn text in `artifacts.contentBase64`. Earlier message
and material-reference checks did not qualify this separate output-owner path.
The other finding, CEN-AB4EF1DC1546, is the metadata/incremental recovery path
covered by the later corrections below. Neither is a current trusted approval.

The output-pin defect reproduces on `8a4`: four real EventStore/source/compiler
cases fail for automatic inclusion, inclusion from an earlier page, and explicit
artifact selection in both context modes. The baseline retains 41 passing cases;
these four failures remain in `/private/tmp/claude-1373-output-pins-complete-red.json`.
The corrected bounded SQL pin projection excludes only ordinary whole-message
receipts within the full selected prefix, even when reading an earlier page.
Explicit pins pass the same original-source projection before reading output
bytes and again at existing revalidation/save fences. Narrow artifact selection
does not require a full-prefix witness or consume its 500-message allowance.

The actual compiler now omits those artifacts from current context and refuses
an explicit withdrawn selection before `readSessionOutput`. Positive controls
preserve original output registration/bytes, explicitly older frozen prefixes,
tool-result-only receipts, unrelated visible material and narrow selections over
long histories. SessionOutputReferenceStore remains the retained audit owner;
there is no global deletion or change to original effect/registration receipts.
The corrected affected run passes 312 checks across eight test files, zero
failures/skips, including source/compiler, forwarding/review consumers, durable
prefixes and output references. These overlap prior coverage and are not summed.
The scoped lint passes. Current-head source pins, hosted CI and bounded
independent/trusted correction verification remain required; the old
`human_decision` report is not treated as resolved by a push alone.

The prior `8a4` hosted native job `133097518639` failed its subscription
repository workflow: `PublishPreparedRepository` timed out with a SIGKILL child
and an unknown effect outcome, followed by the required post-result deadline
refusal. The separate API account workflow passed. The complete log and artifact
`14198123121` remain retained; the inner publication slowdown cause is not yet
established. This is not a passing native gate and the uncertain operation must
not be replayed. The output-pin correction changes neither that helper nor its
deadline; fresh current-head native qualification remains mandatory.

Bounded independent verification of `99db` cleared the original three findings
and context correction but reproduced one further P1: a sequenced retraction
followed by command-state metadata during held foreground recovery dropped known
tool activity from a stale streaming copy. The actual EventStore/reader/API/store
case failed with zero retained tool rows and no visible history error. The fix
records whether each captured ordinary output action changed current content;
metadata and projection receipts cannot establish a newer streaming owner. It
also tracks genuine unsequenced output changes so legacy live output survives
while sequenced metadata replays. Neither receipt nor metadata grants execution
authority. A shared action set avoids allocating the classification on each token.

The exact reported case first failed independently and locally, then passed;
a positive control retains a genuinely newer unsequenced reply through the same
metadata overlap. Final affected qualification passes 204 checks across five
suites, zero failures/skips; these overlap the retained 566-check baseline.
An intermediate reference-only change detector still failed because retraction
projection allocates new block maps on metadata; that failed receipt remains and
is not counted as acceptance. Final classification requires actual output actions
and reducer content change. Bounded independent correction verification and new
current-head CI/trusted final approval remain required.

The next bounded pass at `b52` verified that metadata-only correction and the
newer unsequenced-owner control, but retained the same P1 when a valid correlated
tool result or ignored stale text delta follows the receipt. The canonical tool
row was still filtered out as a changed current, and a delta cannot reconstruct
its parent. Both actual-store cases fail locally before the additional correction.
The final rule treats a completed canonical row as the seed for later incremental
events, even if the view retains its old streaming copy. Only a full-row
constructor (start, snapshot or user row) can discard its prior row before replay;
block/tool/end deltas update known activity. The original identity, selected-chat,
cursor, attribution and newer-output fences remain.

Both incremental witnesses now pass alongside the metadata-only and newer-owner
controls. Final affected qualification is 206 checks across five suites, zero
failures/skips, overlapping the previous baselines. This is source correction;
independent verification and exact-current-head hosted/trusted approval remain
pending, and no prior failed pass is relabelled as acceptance.

The exact-head trusted review of the original `490d` candidate additionally
identified CEN-4207B76DD69C (sequenced receipt drops known tool activity, covered
by the local recovery correction above) and CEN-7557F1774253 (shared visible
context still contains withdrawn text). Neither is called verified by that
original FIX report.

The context correction updates both existing read-only source owners. The
EventStore durable visible-text reader checks original ordinary identities using
bounded SQL scalar projections, excludes whole-message receipts only within the
selected prefix, and retains user rows and tool-result-only text. No private
payload hydration is introduced. The Telos conversation source removes only
ordinary assistant text and its material references, including a receipt before
message completion; its existing authorization, attribution, byte/page limits and
source witness checks remain. These are source reads, not live Telos mutations.
Current finalized/streaming reply delivery also refuses withdrawn output; explicit
earlier frozen sources preserve their original bytes and identities.

Five actual source-reader/identity cases first failed before correction. The
corrected combined context/retraction run passes 174 checks across eight suites;
an additional compiler/current-reply run passes 65 checks across two suites, with
overlap. The real EventStore, source adapters and ConversationPromptContext
compiler qualify omission from current context and retention of earlier snapshots.
Original events remain unchanged. These are offline source/consumer tests, not
two-process restart or account/runtime acceptance. Final composed-head testing,
bounded independent verification and trusted finding resolution remain required.

Accepted persistence integration: the composed tree includes accepted main
`6d320beb1ba543773db7ca16e5825fd25c29cb6d`. All eight incoming non-composed
paths are byte-identical to that commit. The query-loop merge retains both the
reviewed retraction handling and accepted bounded persistence diagnostics; only
the manifest label, parent-key union and composed query hash needed manual
resolution. The exact 2,528-key source registry union verifies without replacing
either parent's unrelated hashes.

Final composed-source qualification passes 566 checks across 17 distinct suites
in two batches (378/13 and 188/4), zero failures/skips. These cover the actual
SDK/query/EventStore retraction and persistence consumers, both context source
owners, the context compiler, canonical transcript/API/real client refresh,
sequenced replay, coalescing, metadata and stale/live restoration. The initial
combined command included three nonexistent client test paths; those files were
not counted, and the four actual client/coalescing suites ran separately.
Scoped lint, new-module strict typing, formatting, whitespace and the complete
source fingerprint verifier pass. Full hosted compile/CI and independent bounded
correction verification remain separate gates.

The change reuses existing transcript rows, tool-result text and shared semantic
tokens. It adds no layout, control, palette or motion pattern. The intercepted
`chat-claude-retractions` fixture renders the actual ChatArea/store/parser,
replacement text, preserved tool row, original user request and unsent draft,
including stale restoration. It defines six phone/desktop browser cases across
light/dark and alternate accents/fonts. Test discovery and fixture bundling pass;
browser execution/screenshots remain pending hosted qualification because this
native Seatbelt runtime cannot register browser processes. No browser guard was
disabled and no visual pass is claimed. Design guards are included above.

Independent correction verification, exact-head trusted Centaur final
LGTM/merge/zero blockers and combined CI remain gates. Broader S02 retry/quota
truth, child retirement, actionable process-restart decisions, full installed
tool/account acceptance and the original iOS/recovery incidents retain their own
evidence. This candidate does not establish full Claude/Codex parity.
