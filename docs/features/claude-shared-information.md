# Shared information in ordinary Local Mac Claude

Ordinary personal Claude and Vertex chats use the existing Mitzo handlers for
saved history, accepted Knowledge Library documents and Agent Library task
definitions. Both default and explicitly selected profiles can select these
capabilities. Profile selection and the active skill ceiling still restrict
invocation.

`AgentCommunication` with `operation: "list"` discovers owned ordinary chats and
their current delivery capabilities. `SearchPastSessions` and `ReadPastSession`
search and read authorized saved public history. These are different inventories:
a saved conversation need not have a live controllable runtime. There is no new
`ListSessions` tool or provider-filesystem history scan.

## Shared owners and the SDK adapter

The SDK registers the canonical schemas and delegates through the existing
guarded callback. `session-history-sdk.ts` adapts the verified SDK caller to the
small `SessionHistoryCaller` interface used by the existing history authorization
owner. It checks the original operator, account, session, profile, skill and query
authority before reading and before delivering results. Codex continues using its
native caller through the same authorization and history handlers.

Knowledge and task calls reuse `sessionCredentialTools` and their existing stores.
`ReadKnowledge` reads accepted revisions, including when the checkout is dirty.
`SaveKnowledgeDraft` retains its approval, source revision and idempotency checks;
it saves a reviewable draft without accepting or publishing it. `AgentProposeTask`
retains the proposed expected revision and published profile pin. The user review
and save flow remains responsible for applying revision checks to saved tasks.

Registration and guidance are rebuilt with the current ordinary query owner for
first, queued successor and cold-continuation queries. Unexpected history/task
storage failures use the shared sanitized diagnostic reporter. Failed reads are
settled observations; cancellation and uncertain proposals retain their existing
callback outcome rules.

Successful shared-handler results retain their canonical synchronous access check
in memory. The SDK invokes that same check after its final authority wait and guard
cleanup, before returning content. History visibility, Knowledge source ownership
and task operator access cannot change during those waits and expose stale bytes.
Authority failures keep their original cause internally and expose a safe runtime
message through MCP; cancellation, turn completion and timeout retirement remain
with their existing owners. A proposal persisted before delivery authority is lost
retains its durable receipt and uncertain callback outcome; it is not blindly replayed.

## Qualification evidence

Baseline inspected: main `f801f8df6cac9c1305727b85a7235928eef2e175`, SDK `0.3.322`.
The legacy SDK route already registered Knowledge helpers. Ordinary Claude's
narrow callback list excluded the six information helpers; history and task
profile eligibility also excluded the Claude SDK route. This change qualifies
ordinary Local Mac Claude without broadening the legacy route or Codex routes.

- `server/__tests__/ordinary-claude-information.test.ts` uses the real SDK MCP
  server and MCP client with disposable Git, SQLite and in-memory stores. It
  executes reads, saves actual draft/task proposals, and checks returned payloads.
  It covers selection, exact MCP skill names, hidden history, snapshot paging,
  accepted source bytes, approval/denial/expiry/cancellation/revocation, changed
  source revisions, idempotency and sanitized storage failures. Final-delivery race
  tests cover history search/read, Knowledge and task reads, persisted proposals,
  callback settlement, and the actual SDK serialization of authority errors.
- `tests/integration/ordinary-local-vertex-chat.test.ts` uses synthetic providers
  through the ordinary chat owner. Personal and Vertex first, queued successor
  and cold-continuation queries invoke discovery, history search/read and task
  reads through real MCP callbacks and inspect delivered results. All six helper
  registrations remain present on replacement queries.
- Existing catalog, selection, legacy SDK, native Codex history, shared history
  and task tests exercise the shared contracts alongside the new adapter tests.

Combined-base qualification includes accepted approval parity (#1351) and Telos
SDK tools (#1352), from main `9af764899302cbcc55c60ed0d2e7f159b266a045`.
Both SDK registration families and their existing authority checks remain present.
The ordinary fixture executes information calls and native approval checks on the
same first, queued and cold queries. It waits for the existing terminal boundary
before checking completed approvals, retaining the approval assertion and timeout.
Local qualification passed 208 checks across 11 affected suites, all 13 ordinary
personal/Vertex integration cases and five additional Codex selection checks.
The catalog fixture matches the executable
catalog, and all 2,447 registered source fingerprints were retained and verified.
Centaur review `5901795578` is the approved baseline; the integration candidate
requires its own CI and targeted Centaur verification before landing.

The combined review identified two Telos integration blockers, CEN-E8293D5E660F
and CEN-3616B6328BE8. Artifact reads now reuse the canonical response-eligibility
predicate after the final SDK authority await and guard cleanup. The synchronous
observation reopens the installed canonical owner read-only and verifies the exact
retained metadata, without rereading bytes or changing source-packet access.
Worker startup derives the exact skill name from the existing immutable session
tool route, retaining native Codex checks and SDK-prefixed skill restrictions.
Four actual MCP artifact races failed before the fix and pass afterward. The
mounted delegation tests now reach the production startup consumer for shared,
default SDK and explicit SDK routes, retaining lost-response recovery without a
duplicate dispatch and checking skill revocation on pending first-command authority.
All 75 tests in the four focused SDK/delegation/artifact-route/selection suites pass.
The wider information/source/effect and native artifact/runtime regression set
passes 135 tests across nine suites in total (one worker, 1 GiB Node heap).
The earlier combined candidate's full hosted CI (43585386466) passed; the correction
requires fresh exact-head CI and Centaur verification.

Final base integration includes the accepted lifecycle changes from #1348 at
`19aa8a19b274ae1fee416f0f187c772111251366`. The combined source retains information
callbacks alongside Stop/Continue, cold history recovery and settled Telos
pre-effect refusals. All 541 tests across 18 affected information, SDK, lifecycle,
artifact, worker-startup and queue-recovery suites pass with one worker and a
1 GiB Node heap. All 19 ordinary personal/Vertex integration cases also pass,
including information calls and public Stop/reconnect/Continue recovery.
Source fingerprints were regenerated from the combined files;
the accepted lifecycle tree and both Telos corrective checks remain present.
Final combined-head CI and Centaur review are separate landing requirements.

The subsequent Centaur follow-up verified both Telos fixes and identified
CEN-94AC0E9A6A47: control inbox/read results lacked the same final cleanup fence.
Six real MCP cleanup probes reproduced that gap across default/explicit profiles
and query, operator and skill revocation. Ten adjacent probes also reproduced it
in backlog/item reads and artifact discovery. These reads now retain the existing
caller authority check through guard settlement, while artifact bytes keep their
stronger canonical eligibility observation. Withheld reads retain settled callback
outcomes; mutation acknowledgements and uncertain effects retain their owners.
The control tests exercise the ordinary query's actual callback consumer through
terminal settlement, alongside preserved release acknowledgements.
All 192 tests across eight affected SDK, callback, artifact, backlog and startup
suites pass after this correction (one worker, 1 GiB Node heap).

No real model or production-service calls are required for these checks. This
does not qualify Claude on OpenShell, arbitrary provider transcript imports,
repository/bootstrap helpers, messaging/timers, Telos execution or changes to
conversation lifecycle. Merge, deployment and live user acceptance remain
separate from this offline qualification.
