# Agent session-history retrieval

`SearchPastSessions` searches authorized visible conversation titles and public
user/assistant text. `ReadPastSession` returns assembled visible messages by
default. Both use the existing signed native owner; neither opens provider files,
recovers a runtime or grants authority from historical text.

## Usage and continuation

- Search: `{query: "release decision"}`. Transcript matches return `snippet`,
  `matchedSeq` and `throughSeq`. Read around a match using `afterSeq: matchedSeq - 1`
  and the returned `throughSeq`. `scope: "summaries"` retains metadata-only search.
- Read forward: `{conversationId, limit: 20}`. `limit` counts message entries;
  streaming fragments sharing a message ID are assembled. Separate text blocks
  use paragraph separators. Long answers can split at durable event boundaries.
- Search one conversation: `{conversationId, query: "release decision"}`. Results
  are matching excerpts; `excerpt: true` identifies shortened text.
- Read recent messages: `{conversationId, recent: true, limit: 10}`. Results stay
  chronological. Follow `nextBeforeSeq` as `beforeSeq` to move backwards.
- Forward reads use `nextAfterSeq` as `afterSeq`. Preserve the first `throughSeq`
  on every continuation. Entries expose `seq` and an optional assembled `endSeq`.
- Search continuations use `nextCursor` when present, otherwise `nextOffset`.
  Preserve the query and scope. A cursor binds its conversation and query and
  captures that conversation's highwater. Title/metadata reordering can invalidate
  an offset cursor; restart rather than treating an error as an empty result.
- `view: "events"` preserves the previous 100-event read contract, including its
  explicit oversized-event reporting. It cannot combine with query/recent reads.

No continuation means the selected scan is finished; an empty page with a cursor
is incomplete. Search reports unsupported formats and oversized-event sessions
in coverage; these exclusions prevent a claim of exhaustive transcript coverage.
Unknown native delta types and Symposium audiences remain unsupported for text
retrieval. A title match does not require opening an unsupported transcript.

## First- through fifth-order effects

1. **Useful work per call.** A tool-heavy chat can cross 2,000 excluded events in
   one call, and a 2,000-fragment answer becomes one entry. Regression fixtures
   reproduce the previous 21- and 20-call cases using the actual SQLite owner.
2. **Output and cursor integrity.** Fewer round trips reduce tool overhead and
   context noise, while a 32 KiB output ceiling remains. Message assembly retains
   source anchors; continuation consumes the last delivered source event. Tests
   concatenate all pages of a large answer and check for loss or duplication.
3. **Search correctness and audience boundaries.** Matching follows assembly and
   the owner's public projection, so fragments and redacted terms cannot bypass
   normal matching. A bounded lookup through the existing message-identity index
   supplies query overlap across scan boundaries. The same projection serves
   forward, reverse and overlap reads; reasoning/tool/configuration fields never
   leave SQLite through that projection. Unknown formats fail closed.
4. **Resource and concurrency effects.** A tool call consumes at most 8,192
   transcript events in total, including query overlap, plus one continuation
   probe per database page; each database page returns
   at most 128 KiB of text plus bounded metadata. Search shares its event budget
   across conversations and exposes an intra-conversation cursor. Large excluded
   payloads do not multiply JavaScript memory. Authority is refreshed at admission
   and delivery, and target identity remains checked at each highwater read.
   Synchronous projection does not repeat the full native custody fence per row
   or rescan all earlier targets per candidate.
5. **Compatibility and adoption.** Existing event/summary behavior retains explicit
   modes and regression coverage. Public tool definitions describe the defaults,
   limits and cursors. New runtime source modules are registered in the reviewed
   source manifest and its revision advances. CI and exact-head Centaur approval
   still gate merge; merging this source does not deploy it or prove that an
   already running agent adopted the new tool contract.

## Scope

This change uses existing indexed event storage without a new persistent index,
schema migration or background worker. Cross-conversation search remains bounded
and paginated, rather than an exhaustive one-call full-text index. Unknown format
coverage, metadata cursor invalidation and single-event output overflow are
reported explicitly. Production activation requires its separate release action.
