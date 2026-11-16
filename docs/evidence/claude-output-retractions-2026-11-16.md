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
512; a receipt batch is bounded at 256.

Verified retractions append a durable `message_retracted` projection event.
The live parser validates identity and rejects attributed or cross-session frames.
Shared live/cold projection removes replaced ordinary response text/thinking,
retains known tool and child activity, and replaces an explicitly retracted tool
result with fixed text while clearing its old image/error presentation. User
inputs, attributed seats, host agent messages, original EventStore bytes and tool
effects remain intact. Receipts survive stale REST restoration and late output;
clearing the conversation clears its projection receipts. Reconnect snapshots
cannot reintroduce a verified removed response.

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

## UI design and remaining gates

The change reuses existing transcript rows, tool-result text and shared semantic
tokens. It adds no layout, control, palette or motion pattern. The intercepted
`chat-claude-retractions` fixture renders the actual ChatArea/store/parser,
replacement text, preserved tool row, original user request and unsent draft,
including stale restoration. It defines six phone/desktop browser cases across
light/dark and alternate accents/fonts. Test discovery and fixture bundling pass;
browser execution/screenshots remain pending hosted qualification because this
native Seatbelt runtime cannot register browser processes. No browser guard was
disabled and no visual pass is claimed. Design guards are included above.

Independent full source/consumer review, exact-head trusted Centaur final
LGTM/merge/zero blockers and combined CI remain gates. Broader S02 retry/quota
truth, child retirement, actionable process-restart decisions, full installed
tool/account acceptance and the original iOS/recovery incidents retain their own
evidence. This candidate does not establish full Claude/Codex parity.
