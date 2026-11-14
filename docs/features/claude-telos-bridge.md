# Canonical Telos in ordinary Local Mac Claude

Verified against main `f801f8df6cac9c1305727b85a7235928eef2e175` and Claude Agent SDK
`0.3.322` on 14 November 2026. This is source and disposable-fixture evidence,
not production activation or a live provider run.

Ordinary personal-subscription and Vertex chats use the same owned SDK query.
Its MCP servers are rebuilt for the first turn, queued successor and cold
continuation. The new `telos` server projects existing definitions and schemas,
including the discriminated `TelosManageItem` contract, through the SDK's
public MCP request handlers. Explicit profile eligibility and the actual
`mcp__telos__` skill namespace are checked at invocation as well as registration.

The older Vertex MCP path already provided many Telos operations. It remains
unchanged. This adapter supplies the canonical handlers to the ordinary query's
restricted server set; it adds no work store, scheduler, delegation registry or
launcher. The existing signed operator, query lifetime, cancellation and review
checks remain in force.

| Operations                                                                         | Existing effect owner                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| List, search, full read, standalone feature, child, brief/lifecycle/progress edits | `executeTelosBacklogOperation` through the installed canonical runtime                                                   |
| Assigned-lead item read/progress                                                   | `executeNativeTelosItemOperation`, using its minimal caller interface and unchanged canonical assignment checks          |
| Outcome creation and source adoption                                               | Existing source-review permission handler and retained approval owner; provider execution retrieves the approved receipt |
| Artifact save                                                                      | Existing guarded artifact operation, bounded workspace reader and canonical commit owner                                 |
| Artifact find/read                                                                 | Existing artifact transport, HTTP routes and canonical artifact store; source-capture bodies remain excluded             |
| Reviewed session creation                                                          | Existing `mitzo-connections` SDK registration and `sessionLaunchTools` / session launch host                             |
| Slice start and work control                                                       | Existing shared transports, mounted work routes, role/delegation and command-admission owners                            |

Saving work, preserving sources, creating a conversation, assigning a role,
admitting a command, provider acknowledgement and completion remain distinct.
Backlog maintenance needs no lead assignment. `TelosGetItem`/`TelosUpdateItem`
keep their current assigned-lead scope; ordinary maintenance uses
`TelosManageItem`.

## Evidence

- Real SDK MCP client/server calls reach canonical SQLite owners for default
  and explicitly selected profiles. Tests cover features, slices, parent
  revision conflicts, progress and child-before-parent completion.
- The ordinary query consumer rebuilds a callable MCP server for first turn,
  successor and cold continuation. Retired query callbacks cannot execute.
  Existing personal-account verification and Vertex query tests remain separate.
- Excluded profiles, restricted skills, denied review, cancelled calls, expired
  or detached operator authority and retired runtime authority cannot grant an
  effect. Artifact read results are withheld if authority changes during I/O.
- Approval expiry retains the canonical known-not-started callback outcome.
  Real MCP calls for backlog mutations, assigned progress and artifact saves
  leave the ordinary query able to settle its terminal result, for default and
  explicit profiles, without saving an item, update or artifact.
- Internal artifact reads reuse the public document reader's current item
  eligibility and bounded byte checks. Latest and explicit-revision reads of an
  artifact retained before its item changes to LifeOps refuse before loading bytes.
- Workspace artifact saves reuse the existing guarded native operation through
  its minimal caller interface. Cancellation, operator/runtime/skill revocation
  and workspace replacement during file reading prevent a new artifact or receipt.
  Exact committed receipts are recovered before reading a changed workspace file.
- Lost responses after item creation, artifact save, reviewed source save,
  session assignment and command admission retain the original identities.
  Fixture recovery verifies no duplicate item, artifact revision, session or
  dispatch. Source retrieval failures retain the approval receipt and direct
  recovery through the original reviewed save; starting another review is not
  receipt recovery.
- The existing session-creation SDK tool reaches the actual canonical proposal
  host and reviewed assignment service. Creation admits no command.
- The SDK slice-start tool reaches the mounted work route and ordinary admission
  consumer with a synthetic dispatcher. Its receipt is `admitted`, not provider
  acknowledgement or completion. Scoped control inbox reads reach the canonical
  work store.
- Existing native item, backlog, MCP, session launch and delegation suites cover
  unchanged Codex behavior. All tests use disposable data and synthetic providers.

## Runtime limitations and integration

The reviewed child launcher and worker startup currently require **Local Mac
Codex**. A Claude caller does not enable Claude children or OpenShell Claude.
`prepareTelosSessionSettings` refuses unsupported child settings before
preparation/allocation; `telos-worker-start-runtime.ts` independently qualifies
the original child's runtime before dispatch. Supporting Claude children requires
that existing lifecycle/runtime owner to qualify creation and startup together.
No replacement launcher is introduced here.

Source preservation still requires the existing exact source review. This
adapter does not broaden transcript or artifact visibility. Any uncertain write
must use its original request and receipt. A queued command is not completed work.

The local full TypeScript check exceeded the repository's 1 GiB process budget;
full typecheck/build run in CI. No real model calls, real worker starts,
deployment or production acceptance are part of this change.

Separate existing follow-up: the legacy internal HTTP artifact-save route still
awaits its workspace reader before an unguarded save. Remaining callers of that
route need qualification through the existing guarded operation and commit owner.
The ordinary Claude bridge uses that guarded owner directly; no replacement
store, approval flow or launcher is needed.

Shared catalog and `chat.ts` additions must be retained alongside the parallel
history/Knowledge/Agent Library, Connections/Tool Library and coordination
changes. Regenerate the reviewed source fingerprints on the combined candidate.
PR #1342's TaskExecution approval work and Stop/Continue/reconnect remain with
their existing owners.
