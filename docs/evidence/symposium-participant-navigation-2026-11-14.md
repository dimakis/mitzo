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
