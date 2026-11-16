# Claude output retraction evidence

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
