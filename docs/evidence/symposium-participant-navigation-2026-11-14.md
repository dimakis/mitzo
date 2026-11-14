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
