# Symposium participant navigation contract

Base: accepted main `9af764899302cbcc55c60ed0d2e7f159b266a045`.

An ordinary source conversation remains the Chats identity and title. Fresh
participant execution sessions retain their own IDs, provider histories, accounts,
permissions, commands, Stop owners and recovery receipts. A presentation relation
grants none of those capabilities. Existing `/chat/:sessionId` links remain valid.

Derive grouping from the first, fingerprint-verified `begin` receipt and a unique
retained linked join, with uninterrupted source/participant membership. Membership
alone, ordering, titles, creation/lead provenance and provider IDs prove no such
relation. No new persisted identity or lifecycle flag is necessary. Missing source,
multiple associations, legacy membership, malformed origin, allocated-but-unlinked
and removed/rejoined records remain independent and discoverable. Removal restores
the participant's standalone navigation; it never deletes or reallocates work.

Group before ordering and pagination. Source title/settings remain its own; latest
participant activity advances conversation recency. Live activity carries only an
optional presentation destination beside its original session ID. Chats projects
that evidence into one row with any participant approval/review taking priority;
ordinary activity, permission and Stop consumers keep exact execution identity.
Search groups before its result limit while retaining the exact matching session
for inspection. Agents exposes ordinary participant history navigation; opening it
uses the existing authorized history/recovery route.

## Current owners

- `server/chat.ts:getSessionsCached`: visibility, recency, pagination; full listing
  delegates here after timestamp reconciliation.
- `server/app.ts:/api/sessions`: runtime/model/work annotations after pagination.
- `SessionMetadataStore.searchSessionsAsync` → `SessionSearchIndex` → worker:
  title/text matching and limit; synchronous search is the older adapter.
- `SessionMetadataStore.listSessionSummaries` → `server/session-history-tools.ts`:
  bounded execution-session inventory for authorized source selection, intentionally
  independent of Chats grouping.
- `server/session-overview.ts`: actual live/persistent activity and approval state.
- `useSessionList`, `mergeSessionActivities`, `SessionList`, `SessionPanel`,
  `ActiveSessionsList`: cached list/activity merge, filters and conversation counts.
- `useAttentionFeed`: Today attention projects the same conversation destination;
  the raw SSE store and ordinary composer still consume exact participant IDs.
- `SharedConversationAgents`/`ConversationAgents`: participant inspection.
- Chat routes retain direct session IDs; grouping changes no transcript/composer.

## Test-first delivery

Use actual EventStore, begin/snapshot/preparation/allocation/link owners and reopened
SQLite databases. Regress silent join, first reply, restart, pagination, bounded
search, pending/failed allocation, membership removal/rejoin, hidden/missing source,
legacy/ambiguous provenance and independent standalone records. Exercise the real
cached list adapter and frontend activity merge, including simultaneous working and
approval participants. External execution remains synthetic; no model call,
production/device acceptance or assignment-system changes are authorized here.

## Delivered source and interface evidence

- `CollaborationConversationStore.navigation()` returns only
  `{sessionId, sourceConversationId, collaborationId}` from retained begin/join
  provenance. No database migration or allocation is performed. Corrupt join
  records retain standalone navigation and produce a sanitized diagnostic once
  per affected identity until a successful read.
- `server/session-conversation-list.ts:sessionConversationPage` is the actual
  cached/full listing adapter. It groups before pagination, keeps source title
  and settings, and advances recency from participants. Naming history is loaded
  only for the resulting page. `Session.participantSessionIds` is presentation
  metadata for active dots; it confers no session control.
- `SessionActivity.presentationConversation` accompanies the original `sessionId`.
  `useSessionOverview(true)` projects it for navigation only; the default hook and
  underlying SSE store retain exact execution identities. `participantActivities`
  retains all raw activity evidence. Permission/review attention wins over other
  activity; flags, pending replies, worktree state and recency are retained.
- `SessionSearchResult.matchedSessionId` preserves exact history navigation while
  `sessionId` identifies the source conversation row. Both SQLite search adapters
  group before their limit. Async delivery rechecks both source and match visibility
  and current presentation membership after the worker yields.
- `SharedConversationAgents` gains raw participant status and history destinations;
  only that wrapper changed in `SharedConversation.tsx`. Transcript, shared sending,
  composer, reader policy, command admission and Stop owners are untouched.
- Successful join/recovery and membership API mutations invalidate Chats caches
  and schedule activity observation. Removal returns the participant to independent
  navigation and preserves every ordinary history/recovery route.

## Verification and remaining boundaries

Test-first failures were observed for the missing navigation/list/activity ports,
ungrouped bounded search, missing participant history destination, stale source
search recency and malformed older joins. The final focused regression run passed
654 tests across 21 files, using one worker and a 1 GiB Node heap. It includes
actual EventStore/store adapters, reopened persisted SQLite fixtures, real
permission registration through `SessionOverviewEmitter` into the Chats projection,
and the existing application route, shared-conversation and metadata regressions.

Package compilation (`tsc -b packages/protocol packages/harness packages/client`),
focused ESLint, formatting and diff checks pass. The design suite passed 109 tests
with one existing skip; the approved ledger/references/protected tests are unchanged.
The reused UI patterns are conversation rows, `ConversationAgents`, `header-action`,
`UiIcon`, `SessionActivityStatus` and the existing shared control/appearance tokens.
No design exception, palette, container or new motion pattern was introduced.

The offline shared-conversation browser fixture now asserts the ordinary participant
history destination and 44px touch target in its existing mobile/desktop, light/dark
coverage. Local Playwright stopped at browser startup because its browser binary
was absent; the bounded browser install then failed when the download CDN closed
connections. No rendered screenshot or phone acceptance is claimed. The full server
typecheck exceeded the required 1 GiB heap; hosted compilation/browser CI remains
necessary. No staging, live provider call, deployment or merge occurred.

Slice 1 must preserve the Agents-wrapper additions when integrating its independent
transcript/composer changes. Slice 3 should consume this branch's commits and repeat
the real ordinary composition checks. PR #1347 remains separate (open/draft,
conflicting, head `4f5dd94981c9c4bd4b9b31e639a3fae7f560772f` when inspected).
The Claude parity stack has merge priority. This repair is prepare-only; any later
merge needs fresh accepted-main integration, combined CI, exact-head Centaur LGTM
and separate merge authorization.

## CI source-preflight follow-up

The first hosted preflight exposed stale source fingerprints and server-test imports
crossing the server TypeScript root. The persisted fixture now lives under
`server/__tests__/fixtures/collaboration-navigation.ts`; protocol tests reuse it.
The pure `conversationActivities` projection lives in the protocol package and is
re-exported by the existing frontend module, so the real emitter/consumer test uses
the same production projection without importing frontend source into the server
compiler. The test's dependency callbacks have explicit parameter types.

The runtime registration advances to
`v1.0.1150-symposium-participant-navigation`, refreshes changed source fingerprints
and registers the new owner/projection/test modules. The source-only artifact check
passes against the actual final bytes. This is a candidate registration, not trusted
review, source acceptance or runtime activation. Slice 3 must regenerate again from
its final combined sources rather than adopt this branch's differing fingerprints.

## Centaur review corrections

Review `5904134966` at `e5b59fc4f` identified two blocking regressions. Both were
reproduced with failing tests before correction. `CEN-0F21B679E671` is covered by
the real desktop SessionList/SessionInspector history fetch and Open action:
`matchedSessionId` now survives preview selection and controls the history/open
destination while the row ID and its actions retain the source identity. Mobile
saved-history previews use the same destination. The intercepted session-library
fixture asserts the matching history and exact opened route on phone/desktop.

`CEN-B2B70D0BCD99` is covered by actual persisted-store title-only searches for
both source and participant titles at one/two-result limits. Async metadata now
retains execution `updated_at` for title-match ranking and carries aggregate
`conversation_updated_at` separately for display. Sync/async results, match clocks,
exact matching sessions and conversation recency agree despite newer unrelated
participant activity.

Accepted main `0ad803cda` was integrated without changing either branch's source
owners. The registration conflict retains all entries from both parents and renews
fingerprints under `v1.0.1160-symposium-search-review`. Exact-head Centaur follow-up,
hosted CI and combined slice 3 verification remain separate delivery gates.

## Accepted parity main integration (15 November)

The retained baseline is `7bdb364c0711746d0c9e3eec21c870b44111a772`, with
full CI `43607355855` successful and Centaur final review `5905334732` reporting
LGTM, recommendation `merge`, zero blockers and both earlier findings verified
resolved. Both corresponding review threads were closed with the exact fix,
regression and review evidence. This baseline does not approve a successor SHA.

Accepted main `8676db5788f24e818f2c997da2011029ae11c68d` is integrated in the
same isolated branch. Only protocol exports and source registrations conflicted.
Both `conversationActivities` and parity's `OrdinarySkillContext` export are
retained. The registration is the exact union of both parents (2,487 entries),
with final-byte fingerprints under `v1.0.1181-symposium-parity-integration`.
No additional production behavior or permission policy was changed during
resolution. The automatically merged EventStore, application and chat owners
retain the accepted parity skill parsing, execution identity, targeted controls,
SDK retry proof, service helpers and sanitized failure reporting alongside the
existing navigation projection. The diff against main remains slice 2's scoped
navigation behavior; transcript/composer changes remain with slice 1.

Combined local validation passes: 769 tests across 29 files using one worker and
a 1 GiB Node heap, including all 24 retained navigation suites plus session access,
control support, frozen SDK skill boundaries, restricted-skill enforcement and
failure diagnostics. Protocol/harness/client compilation, approved-design guards,
focused lint, source-only registration and whitespace checks pass. Full server,
browser/layout and native validation remain hosted CI work for the successor.

The agreed source order is navigation #1354, transcript/composer #1356, then the
remaining independent harness/evidence in #1355 after accepted-source diff and
final-tree reconciliation. #1347's setup/phone joining scope remains separate.
No source is intentionally landed twice. Actual landing turns remain serialized
by the global coordinator; this integration commit and publication do not merge
or deploy anything. Reuse the baseline review and verify this integration delta
before any exact-head final qualification.

## Shared SDK fixture correction

CI `43656741510` at integration head `5d586ccb35746aaa70062736a8faece5f490a8ce`
failed unit shard 2/4, job `132637763568`, on three repository-transfer variants
in `tests/integration/ordinary-local-vertex-chat.test.ts`. At line 1583 the 10s
terminal wait observed `RUNNING` instead of `TERMINAL`: Vertex explicit profile,
personal default and personal explicit. The shard reports 516 other files passed
and seven skipped. This failure is retained; no unexplained retry was used.

The existing shared-test owner (conversation `2208b5d4-686e-8b94-82bc-8d46e0611614`)
provided the narrowly reusable test delta from
`7c8c84b9cf14c713fe0a29feccebf0cf3c2e1bdd`. Our pre-correction test blob exactly
matches its preimage `abba9b62246aa4f1037ce371e7a4babcb249883f`; the selected patch
SHA256 is `3d986166288a46a66df7997c93fff1c3cc61c0f78c03ad21e705333f2c2ad7bb`.
Only that test file's delta is adopted, with final blob
`2898fb8c1c372a7efc57de9114dd1b0c66e2a7cd`. No Telos branch, composer correction
or foreign source manifest is imported. Source review and fault-probe evidence
remain with the originating owner; this branch independently inspects the delta.

The fixture records each command's information/repository work outcome, preserves
and rethrows its original failure, and waits for queued MCP/Git fixture work before
the existing 10s SDK terminal assertion. Each added phase has a 10s bound. The
total observation allowance is therefore longer; it is not the original 10s
end-to-end budget from SDK input. Production runtime, permission, repository and
control assertions are unchanged. Matching source/error location and this
correction do not prove the original hosted cause.

Own validation passes all six transfer variants (Vertex/personal, each with
default, explicit and excluded profiles), one worker/1 GiB, in three bounded
two-case runs: 56.18s, 56.28s and 38.06s. These are six distinct checks, with the
other cases explicitly unselected in each run. The test's fingerprint is renewed
locally under `v1.0.1182-symposium-provider-fixture-phases`, preserving all 2,487
registration entries and every other fingerprint. The preceding 769 checks
remain evidence for the unchanged production source; fresh full CI and a final
exact-head Centaur integration/fixture follow-up remain mandatory.

## Accepted conversation source composition (15 November)

The coordinator subsequently released #1356 first. Its accepted main commit is
`4bc83d18f24bb14f24b7c190a32c2a4fa0834963`, with reviewed tree
`4558e4b25231f58b816e311ed0f777bfc3a372cd`. This supersedes the earlier proposed
landing order: #1356 is accepted source, #1354 remains the navigation candidate,
and #1355 must retain only its residual harness/evidence after reconciliation.
#1347's separate setup/phone scope is still required and is not absorbed here.

Composition retains the accepted transcript/composer and source-name hook. The
Agents wrapper adds only raw participant activity and original history links.
The shared `collaborationOrigin` helper preserves earliest-request, revision-one
singleton and canonical begin-fingerprint proof. Source setup retains its
transaction, zero-association ordinary-history rule, current source and origin
membership, origin availability and linked-history qualification. The helper
grants no access or control authority. Slice 1 reviewed these exact working-file
resolutions in message `b15f4fa8-6ee2-409c-9d3d-3ebadf9dd8e3` and found no
blocker in this narrow identity/Agents composition; that is not final-head review.

Own combined validation passes 814 tests in 36 suites, including actual persisted
navigation/search adapters, canonical/corrupt/legacy/multiple/hidden/unlinked and
removed-member source cases, ordinary/shared application composition and SDK
recovery, access controls and skill boundaries. Approved-design guards pass
109 tests with one existing skip. Protocol/harness/client compilation, focused
lint, formatting and whitespace checks pass. The registry preserves the exact
2,503-entry parent union under `v1.0.1184-symposium-source-composition` with
final-byte fingerprints. No device or live-provider acceptance is claimed.

CI `43659122643` at prior head `43d924ba6277b50b78bbdab7eeb8cb933cba3ca8`
has a distinct unit-shard failure, job `132645589855`: retained-tail pause at
line 1709 in Vertex default and personal default/explicit, and first pause at
line 1299 in Vertex explicit. These waits observed an undefined release function;
the prior queued line-1583 terminal failure is absent. The shard reports 516
other files and 7,352 tests passed, seven files and 50 tests skipped. Its artifact
`14139534455` has SHA256
`9dd241c027fa0acbe2fb6d9241b8edbb9b1e46ef20e87b08efd07e68a3924820`.
The exact source/errors were handed to the existing shared-fixture owner for a
minimal attributable successor; matching locations do not prove hosted cause.
No duplicate fixture implementation or unchanged-head CI retry was performed.
