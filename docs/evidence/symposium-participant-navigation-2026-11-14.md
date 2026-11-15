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

## Reviewed shared-fixture successor

The sole fixture owner published the corrected contribution in
`0b93b77f6f5f8f43b02f611b66684c97fd3cd2f3`, tree
`b2aad32acd127abf2e5b7c12b7d0fafe96006544`. Its independent published-byte
review resolves the superseded unconditional-cleanup blocker. Our current
preimage is exactly `2898fb8c1c372a7efc57de9114dd1b0c66e2a7cd`; only the
SDK fixture delta is adopted, producing exact published blob
`47610a58827f5d700c3a5f023ac7d7549be23f84`. The owner supplied incremental
patch SHA256 `719292f134b6c56265757f406f6e5a62c4463ec297478faa12359f7809bf7b37`.
The accepted-main-to-published patch was separately checked against SHA256
`98c09a893d56b92bbd6917d1ba2d43720e77b614eae343fdadb22393672dd8a4` and
reconstructed to the same postimage before applying the equivalent current-file
delta. No composer fixture, Telos source or foreign registry is imported.

Information/repository phase observation now covers first, queued, retained-tail
and cold commands before their pause or terminal assertions. Each phase and
lifecycle wait remains 10s and each scenario remains 60s; total observation
allowance increases. A later active-input readiness wait explicitly changes
from the implicit 1s to 10s. These are deterministic fixture timing changes,
not permission, runtime or lifecycle deadline changes.

Cleanup attempts all registered callbacks and resets SDK fixture state before
rethrowing original errors. Retirement and guarded detach retain both original
causes in an AggregateError when both fail, and close the store only after both
succeed. The real active-owner guard remains intact. The actual-path guard and
two cleanup-isolation controls are retained in the adopted test. The earlier
unconditional-finally proposal was not adopted. Published-owner qualification
and independent review support this narrow reuse; they do not establish our
hosted cause, our CI success or exact-head final approval.

Own successor qualification passes all nine selected checks: three actual-guard
and cleanup controls plus six transfer variants, using one worker/1 GiB in three
bounded runs. The default-profile pair plus cleanup controls pass in 52.61s;
explicit-profile and excluded-profile pairs pass in 56.70s and 36.95s. Other
scenarios are explicitly unselected, so this is not a complete-file pass or an
additive claim about the owner's earlier overlapping runs. The unchanged
production composition retains its preceding 814-check qualification. Only the
adopted fixture fingerprint changes under
`v1.0.1185-symposium-provider-fixture-recovery`; all 2,503 entries and every other
fingerprint are preserved. Normal successor CI and exact-head trusted Centaur
follow-up remain required before readiness.

The ensuing hosted run `43663571520` at
`7aa6609802cedcd5f8099f958a977c8c4fe1aaa5` failed unit shard 2/4, job
`132658740174`, on one new actual-guard control: `retains failed retirement and
actual guarded detach causes without closing an active store`, line 225:1,
exceeded its unchanged default 5,000ms whole-test budget. The final tail reports
no first/queued/retained/cold lifecycle assertion failure. It reports 517 other
files and 7,359 tests passed, seven files and 50 tests skipped. The artifact is
`14142046601`, SHA256
`dc43ebefaabcbf05561a61d1a0a01e0f637c5798a0bf9cb69b05c6274bd291a9`.
This exact error and fixture preimage were sent to the existing owner for the
reviewed setup-only successor. The timeout identifies the whole test, not the
specific asynchronous phase; no deadline increase or unexplained rerun is used.

The setup-only correction is reused from the same owner's published
`d43ea9ba51f95ce291b81ea1d628ec0e367c6246`, tree
`d3afdef87ff48faf734884ef23fca38636977a63`, after independent published-byte
binding. Our exact prior fixture blob `47610a58827f5d700c3a5f023ac7d7549be23f84`
matches the incremental handoff preimage; its patch SHA256 is
`274936e58b186f0fe4a55dfc08be946ba477dc16e2d4f15695fa11e48e33886a`.
The adopted final blob is `6fe3d2b5f93dcfe00783b38fe792f7b996365eee`.
Only the guard control's setup changes: a private temporary REPO_PATH and real
chat EventStore/registry replace unrelated prepared Git/account/task setup.
The synthetic session is explicitly persisted. All actual setter, registry,
store-liveness and original-cause assertions remain. Default whole-test 5s,
phase/lifecycle 10s and scenario 60s limits are unchanged. No production code,
helper/transfer logic, composer fixture or foreign manifest is imported. The
matching whole-test error still does not identify its original asynchronous phase.

Own affected-path qualification passes five selected checks in 52.67s, one
worker/1 GiB: the actual guard (3.740s), both cleanup controls, and the two
following Vertex/personal default-transfer scenarios. The other 52 scenarios
are explicitly unselected. This overlaps the prior nine-check qualification and
is not added to it as a new total. All unrelated source and fingerprints remain
unchanged; the 2,503-entry union is preserved under
`v1.0.1186-symposium-guard-fixture-setup`, with only the adopted test pin renewed.
Hosted timeout resolution and exact-head final qualification remain pending.

The actual successor CI `43665321683` at
`518059076bf4eda2d8db9a3f5784582499731850` is blocked by two failed unit
shards. Unit 2 job `132664992091` again reports only the real guarded-detach
control at line 225:1 exceeding default 5,000ms, with the corrected exact blob
`6fe3d2b5f93dcfe00783b38fe792f7b996365eee`. The final tail reports no lifecycle
assertion failure; 517 files and 7,359 tests pass. Artifact `14142523183` has
SHA256 `9e700fa3b9e8fcb8e584f8356a944aa56352e2913875dc25996961c8fa12171e`.
Thus the local five-check pass and source review did not establish hosted timeout
resolution. Its specific asynchronous phase remains unproved.

Unit 1 job `132664992067` reports one different failure in
`claude-multi-device.test.ts`: the Anthropic Messages API signed-client case,
line 449:22, observes two inputs instead of the expected original, queued and
raced three inputs after queue continue in an implicit `vi.waitFor`. Its unchanged
fixture blob is `ee158d5f099a1037044cd70ba2c5cea84f1fc101`; no device/composer
patch has been adopted. The shard reports 517 other files and 6,879 tests passed.
Artifact `14142901432` has SHA256
`a759bffe5b50a9e7b717afcd99d275f681405ce8be2ad59d884d3a1f05ecd9bc`.
No cause equivalence is inferred from earlier device-fixture failures.

Both exact errors, current preimages and artifacts were handed to the existing
sole shared-fixture owner. The bounded observation timer is paused after six of
twelve checks on this concrete source blocker. There is no unexplained rerun,
competing correction, deadline increase, final-review claim or merge readiness.

## Published SDK fixture lifetime correction

The existing fixture owner provided only the SDK delta from published
`900ef419c4e3ac823b9e185a4e224ea05da021de`, tree
`64791304f975b609ab8cc2f539bcb287f42babec`, parent `d43ea9ba`, with independent
published-byte review `8fb5fa96`. Our actual repeated guard timeout and current
SHA256 `b7ad0de82642a4117572af3c2bc49e174ddb2f57a3cfcb213897273f8f94881b`
match its required error/preimage. The one-file incremental patch is verified
against SHA256
`0b561d71384b4d1bac4765961e8463d8d7d4682b6350f5b889aaf660b96186e9`.
No native tests, Telos source or foreign registry is imported.

Guard initialization moves into a normal setup hook with an explicit fixture
lifetime. One synchronous cleanup registration owns asynchronous acquisitions;
abort/closing fences reject late publication, teardown joins pending acquisition
before resetting its private environment, and later environment reset waits for
that retirement. Original causes, the actual active-owner guard, store/root
retention and all runtime assertions remain. A real delayed-import/abort control
checks original cause identity, retained/restored environment, rejected following
admission, empty real registry, detached connection, closed store, removed root
and no late cleanup/SDK input. The superseded unpublished late-import variant
was not adopted.

The timing change is explicit: the normal setup hook allows 10s before the
unchanged 5s control body, increasing total setup/control allowance. Lifecycle
10s and scenario 60s limits remain. It is not an unchanged whole-test budget or
proof of the original hosted asynchronous timeout cause. The separate Messages
API device line-449 failure is not addressed by this SDK-only contribution.

Own local qualification passes six selected SDK checks in 51.01s, one worker/
1 GiB: actual guard, delayed-import/abort lifetime, both cleanup-cause controls
and both following default-transfer variants. The other 52 scenarios are
deliberately unselected. The final file SHA256 exactly matches the reviewed
published result
`360841b6c6de8609e275732c226740d986a4a3b69ccbde961b8bdb1e53fecf18`.
No native qualification is claimed from the owner's combined 18-check run, and
prior overlapping local runs are not added to this count. Source registration
`v1.0.1187-symposium-sdk-fixture-lifetime` preserves all 2,503 entries and renews
only this test's hash. Fresh CI and exact-head final review are still required;
the device queue-continuation failure remains independently open.
