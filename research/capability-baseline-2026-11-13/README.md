# Capability, approval and notification baseline — 13 November 2026

The immediate Claude gap is admission to the existing bounded task executor.
Approval delivery already has a shared owner. Reducing duplicate alerts therefore
requires both reuse of an existing task decision and correct notification routing.
Suppressing another distinct pending decision would violate the target behavior.

This supplement belongs to [Capability baseline and visibility](/todos/1a3ad6c5-36b0-4744-9ea1-7bd8c18f253b),
under feature [Consistent capabilities across Claude and Codex](/todos/8e186fdf-9058-4ad6-af18-8fd6797bf935).
It extends the existing inventory; it is an evidence document, not another runtime,
account, capability or notification registry.

## Evidence boundaries

| Evidence                            | Version and state on 13 November                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted product baseline           | `9e47c4ab81d836673bacb461d2b03d46d8de390f`; Claude Agent SDK `0.3.322`, sandbox runtime `0.0.75`, Codex `0.160.0`                                                                                                                                         |
| Existing full surface audit         | MGMT commit `12ccbbe92663a4b5c5d3fd24e12f66022f300f11`; `research/mitzo-agent-surface-audit-2026-11-13/README.md`, SHA-256 `dbc2a0395143406001ccf16e20f1d21b3183fc4426f649d5b63d403c2f281207`; 62 overlapping catalog entries, not 62 tools in every chat |
| Existing CC report cross-reference  | MGMT commit `533e53b`; `docs/mitzo-tools-prompts-audit-2026-11-13.md`; CC socket/search failures are attributed reports, not independently reproduced failures                                                                                            |
| Visibility candidate                | [PR #1322](https://github.com/dimakis/mitzo/pull/1322), head `6d8a4f2b45e626ab2c69ea5c16e5bca26610b62a`, open on read; readiness `dec417f605a93232` remains its owner                                                                                     |
| Claude task candidate               | `76ee005ae9629a20fc0cc6fdbc6c9f8cc0c9ab85`, retained locally as `handoff/claude-task-execution`; no remote branch or PR reported by outgoing owner                                                                                                        |
| This chat's actual selected surface | [current-surface.json](current-surface.json), catalog revision `9a7023b9732d8e5b2e0fc7e86141796e9a412e434ca79a13420c9e82793f9244`; 51 nested tool implementations; invocation is distinct from successful execution                                       |
| Fresh source inspection             | Approval handler, notification owner/center, SDK completion path, task contracts and PR visibility documentation inspected here; immutable file hashes in [source-manifest.json](source-manifest.json)                                                    |

The outgoing audit owner reports 356 existing checks and two audit probes passing.
Its mixed-engine application probe failed before the SDK query at a protected-host-root
`EPERM`. The task owner reports 110 focused checks passing, using synthetic commands
and push transports. These are retained, attributed results; this supplement does not
claim to have rerun them. Neither report establishes live Claude execution or delivery
to an iPhone/Watch. The audit's failed publication and the earlier failing test attempts
remain part of their original records.

The 12 November baseline used SDK `0.2.141`. Its upstream conclusions must not be
silently promoted to proof about SDK `0.3.322` or the deployed runtime. A registered
tool, callable callback, approved request, executed effect and provider-acknowledged
result are separate evidence states.

## Current Codex surface and remaining tool matrix

All rows below were checked against the dated audit and this turn's selected tool
metadata. “Exposed” does not assert a grant, configured account or tested operation.
The source-linked catalog remains the owner of eligibility.

| Capability / operation                                | This Local Mac Codex chat                                                                       | Ordinary Local Mac Claude at accepted baseline                                                                | Gap class and next action                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace shell, file access, search                  | Native shell/search exercised; bounded TaskExecution runs exercised                             | SDK native tools exist; personal Claude requires Bash sandbox and denies native Grep/Glob                     | Runtime: qualify the reported `srt-mux` failure through the selected SDK/sandbox owner; no proven restart remedy                                 |
| TaskExecution status/authorize/run/commit/github_read | Exposed; status, authorization, commands and repository read exercised here                     | Default registration advertises it but ordinary callback fence refuses it; explicit profile rejects its route | Adapter: candidate `76ee005` qualifies guarded task admission, personal/Vertex synthetic consumer coverage; review and qualification remain open |
| Timers and queued messages                            | SchedulePrompt, SessionTimers, SendSessionMessage exposed, unexercised here                     | Same default registration/fence mismatch                                                                      | Adapter: candidate removes unsupported advertisement for these three; actual qualified delivery remains separate work                            |
| Live peer messages                                    | AgentCommunication list/send/wait exercised; two safe-stop handoffs received                    | Existing guarded SDK peer route                                                                               | Adapter/runtime: unavailable recipients must keep a bounded reason; accepted delivery alone does not prove a stop                                |
| Read-only connection discovery                        | ListConnections exposed; not exercised here                                                     | Accepted metadata-only ListConnections, PR #1319 / `8175174b`                                                 | Configuration/adapter: metadata discovery is not service execution                                                                               |
| Service setup and execution                           | ConnectionRequest/WebSocket, setup/access/guide and HomeAssistantDashboard exposed, unexercised | Excluded from restricted ordinary helper surface                                                              | Adapter: deliver through existing connection/account owner; list, attach, authorize and execute need separate evidence                           |
| Google Workspace                                      | GoogleWorkspaceRead exposed, unexercised                                                        | No equivalent controller helper                                                                               | Adapter: qualify shared Google account route; CLI discovery guidance is not equivalence to the credential-injected controller                    |
| GitHub reads and local commits                        | GitHubRead public PR reads exercised; GitCommit exposed; task operations retain separate scope  | No broad ordinary controller-helper equivalent; guarded task candidate reuses existing executor               | Adapter/configuration: public/authenticated repository reads, network consent, commit and publication remain distinct                            |
| Repository discovery/inspection/preparation           | All exposed; discovery and inspection invoked; an isolated native checkout was created here     | Repository helpers absent from ordinary helper route                                                          | Adapter: reuse any-repository owner `150e2b22b098fe16` and native harness `477c9d52d200c0f6`; no duplicate checkout owner                        |
| Public history                                        | SearchPastSessions/ReadPastSession exposed; exact public history read exercised                 | No equivalent ordinary helper                                                                                 | Adapter: preserve source authorization and bounded public-message projection                                                                     |
| Knowledge Library                                     | ReadKnowledge/SaveKnowledgeDraft exposed, unexercised                                           | Absent from restricted helper set                                                                             | Adapter/configuration: accepted document selection, draft review and per-turn published knowledge are distinct owners                            |
| Profiles, tasks and learning                          | Profile read/proposal, AgentReadTasks/ProposeTask, CaptureMemoryCandidate exposed, unexercised  | Some profile/learning helpers registered by default but catalog profile eligibility differs                   | Adapter: fix catalog/registration/callback agreement without granting authority from selection                                                   |
| Telos browse/create/edit                              | List/search/manage/create tools exposed; item reads and evidence update exercised               | No equivalent ordinary backlog helpers; TelosCreateSession is separately supported                            | Adapter: reuse canonical Telos host authority; creation is not assignment, start or completion                                                   |
| Telos artifacts                                       | Find/read/save absent here as well as ordinary Claude                                           | Absent from ordinary helper set                                                                               | Adapter: report missing controls; a local report or progress-note link is not a canonical artifact attachment                                    |
| Telos start and work control                          | TelosStartSlice absent; **TelosWorkControl is exposed here**, unexercised                       | No equivalent demonstrated ordinary controls                                                                  | Adapter: correct the older chat's blanket work-control absence claim for this selected surface; no hold/start receipt claimed                    |
| Work-bound child session proposal                     | TelosCreateSession exposed, unexercised                                                         | Caller route supported under current lead and exact-child checks                                              | Runtime/adapter: supported child is independently reviewed Local Mac Codex; creation receipt is not start authority                              |
| Native child-agent inspection/Message/Stop            | Depends on actual owned Local Mac native child; not exercised here                              | SDK inline task results/recovery differ from native child panel                                               | Engine/adapter: keep native children, ordinary peers and Telos workers distinct; OpenShell native children remain restricted                     |
| Attachments and saved text forwarding                 | Engine images and guarded exact text-forwarding contracts differ; no transfer exercised here    | Local personal/Vertex ordinary Symposium participation exists at this source                                  | Adapter/configuration: exact reviewed UTF-8 source, media/hash/size, account and retained selection required; no general cross-chat import claim |
| Restricted skills                                     | No restricted-skill execution attempted                                                         | Ordinary owned routes reject unsupported restricted skills                                                    | Engine/adapter: preserve visible fail-closed behavior under existing restricted-skills slice                                                     |
| Hooks/extensions                                      | Source contains SDK hook bridge and mandatory permission hooks; no hook exercised here          | Upstream SDK support is broader than qualified Mitzo admission                                                | Engine/adapter/runtime: qualify each extension and account/target combination through existing hook slice                                        |
| Branching, context inspection, scoped rewind          | No new control or execution evidence here                                                       | Upstream APIs do not establish a supported ordinary consumer                                                  | Engine/adapter: keep three explicit support decisions and acceptance evidence under existing session-control slice                               |

The actual selected surface now includes TelosWorkControl. That is a concrete
correction to the outgoing chat's inventory, not evidence that any coordination
hold was requested or applied. Outer tool transport and collaboration namespaces
are outside the nested-tool count in the JSON snapshot.

## Account and execution-target matrix

| Selection                                        | Source support                                                        | Unverified or refused boundaries                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Mac Codex, selected original owner/account | Broad controller/native route                                         | Each helper still needs profile/mode/skill admission and its own operation authority; automatic escalation reviewer remains unqualified           |
| Local Mac personal Claude subscription           | Ordinary SDK route                                                    | Mandatory personal Bash sandbox; native Grep/Glob denial; socket failure reported; candidate task tests are offline                               |
| Local Mac Claude Vertex                          | Ordinary SDK route and candidate task fixtures                        | Distinct account and SDK ownership; no live model or process qualification in this supplement                                                     |
| Local Mac direct Anthropic API                   | Ordinary runtime compatibility exists                                 | Do not infer personal/Vertex Symposium or task-consumer qualification from generic SDK compatibility                                              |
| Local Mac custom Responses account               | Separately configured Responses route                                 | Not a custom Claude/Messages account; account/runtime/model qualification remains separate                                                        |
| OpenShell Codex                                  | Dedicated mapped ordinary target with separately composed host bridge | Explicit portable profile selection and native child controls have separate restrictions; host TaskExecution does not synchronize container files |
| OpenShell Claude                                 | Unsupported ordinary tuple                                            | Refuse before allocation; another engine's support does not qualify this selection                                                                |

The existing runtime binding, executable catalog and readiness projector own these
facts. The PR #1322 UI shows configured support and bounded unsupported, excluded,
blocked, unknown and stale reasons. Production adapters still supply no capability
measurements in that candidate: the view must retain **operation verification unknown**.
It does not inventory all native or configured MCP tools and must not imply that it does.

A fresh [visibility acceptance snapshot](visibility-acceptance.json) contains all
33 returned checks for head `6d8a4f2b`: 31 succeeded, macOS joined acceptance 1/3
was queued, and Native Swift tests/builds were running. The native repository and
authorization workflow succeeded. `Centaur final LGTM` remained pending; the latest
LGTM/merge report is for earlier head `e8bc5a8b`, so it cannot be claimed as final
approval of the current candidate. This is a dated read, not a polling or landing
request. Current combined CI and trusted current-head review still gate acceptance.

## Equivalent approval and notification sequences

| Stage / trigger                                              | Native Codex owner                                                  | Ordinary SDK owner                                                                 | Required evidence and expected result                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First bounded task request                                   | Controller task tool → task scope/store → common permission handler | Qualified candidate MCP tool → same task scope/store → common handler              | One reviewed task decision and one eligible central alert; grant tied to operator/account/member/root/network/expiry                                               |
| Second routine command/test/build variant                    | TaskExecution rechecks and consumes retained grant                  | Candidate dispatch uses same existing task owner                                   | No second task decision within scope; no second approval alert because no new decision exists                                                                      |
| Different CI job/filter                                      | Repository-scoped task github_read                                  | Same guarded task operation when admitted                                          | Same repository grant; public never retries with credentials; bounded log query/page changes do not require new consent                                            |
| Provider-native Bash/shell invocation                        | Native approval adapter and policy                                  | canUseTool + mandatory PreToolUse + personal policy                                | Task grant is not native permission. Routing guidance must choose TaskExecution; neither callback may secretly execute then return an inconsistent native decision |
| New distinct approval, including concurrent requests         | Native adapter feeds common permission handler                      | SDK feeds common handler                                                           | Each request remains eligible for its own alert; chat-wide unread suppression is forbidden                                                                         |
| Changed account/root/operator/selection, Ask, broader action | Current authority and scope fences                                  | Same task fences plus SDK admission                                                | No inherited task execution authority. Profile selection is availability, not consent; denied, revoked or expired grants do not execute                            |
| Permission expiry/cancellation                               | Native decision returns refusal/uncertainty under original RPC      | Common pending request resolves with original cancellation/expiry                  | Preserve original request/receipt; wait for user/reconcile, never automatically recreate unchanged expired request                                                 |
| User resolves decision                                       | Pending permission owner applies exact current decision             | Same common pending owner                                                          | Resolution updates notification state; delivery itself never grants or resolves permission                                                                         |
| Notification enqueue and delivery                            | Shared NotificationStore/NotificationCenter                         | Same shared center; harness legacy alert guarded by hasPermissionNotificationOwner | Approval preferences, quiet hours, preview privacy and durable request ID apply to both                                                                            |
| No native device configured                                  | Central owner selects Pushover then ntfy for permission notices     | Same central permission route                                                      | Review-only legacy alert; no blind approval of redacted/truncated details                                                                                          |
| Native partial delivery, restart, repeated ingestion         | Store retains accepted-device receipts                              | Same store and center                                                              | Retry only remaining native devices; never switch channel after partial native acceptance or replay accepted request                                               |
| HTTP/transport failure                                       | Bounded retry plus correlated diagnostic                            | Same center; legacy HTTP failure returns false                                     | Failure stays visible; sanitized cause retained; no delivery success fabricated                                                                                    |

Mode, profile and skill effects compose with these operations. Ask does not receive
an execution route. Agent/Auto retain their existing native permissions outside the
task; Auto does not qualify an automatic reviewer. Explicit profiles can exclude a
tool, and a skill ceiling cannot expand its authority. A role description or a grant
ID in a peer message does not add membership or an execution root.

Existing synthetic evidence exercises the actual native approval adapter for Local
Mac/OpenShell and the actual common handler/center for shared-provider requests:
[notification-approval-lifecycle.test.ts](../../server/__tests__/notification-approval-lifecycle.test.ts).
The task candidate's ordinary-Claude suite exercises real MCP composition, task
store, common permission handler and notification center for personal/Vertex, with
the native effect and push substituted. Existing
[task-execution-log-consumer.test.ts](../../server/__tests__/task-execution-log-consumer.test.ts)
also composes task authorization, native executor and log transport with external
GitHub substituted. These layers do not prove physical process termination under a
live Claude provider or automatic native-to-task delegation.

## Newly confirmed notification boundary

Accepted `server/query-loop.ts:1132-1159` records the SDK turn completion in the
central owner and then directly calls both legacy completion senders for a detached
successful turn. Both direct calls have empty rejection handlers. The approval
handler already guards its independent fallback using
`hasPermissionNotificationOwner`; this completion block lacks that guard.

This is a source-confirmed route to duplicate completion delivery and bypass of the
central completion preferences/quiet-hours/privacy policy. Actual device delivery
has not been reproduced. The center's legacy fallback currently applies only to
permission notices (`permId`); it is inaccurate to claim universal central legacy
completion support. Before changing the SDK completion path, add a red test through
the real query-loop consumer with a central owner and synthetic legacy transports.
Preserve standalone behavior under an explicit bounded policy and surface transport
failure. Do not disable distinct approval alerts to compensate for this separate bug.

Two other review leads remain open on candidate `76ee005`: unconditional task
instructions when an explicit profile omits TaskExecution, and the difference
between mocked native effects and actual runtime qualification. Neither is a
completed review or a claimed authorization bypass.

## Delivery dependencies and ownership

1. **Finish this baseline and visibility slice** (`1a3ad6c5-36b0-4744-9ea1-7bd8c18f253b`).
   Reuse PR #1322/readiness `dec417f605a93232`; integrate changes to the shared SDK
   helper list without reviving removed unsupported helpers. Keep configured support
   distinct from verification, acquire exact-current-head CI/review and source
   acceptance, and preserve outstanding adapter/live qualification.
2. **Complete the guarded task integration** (`20560449-8f72-41ea-9ebe-5f8c30d07d7f`).
   Start from `76ee005`; complete independent review, tool/profile/prompt agreement
   and the completion-notification red test/fix. Reuse existing task and central
   notification owners. Keep timers/queued messages explicitly unsupported until
   their own qualified routes exist. Gate live testing separately.
3. **Qualify shell/search and the task executor** under the existing hook/runtime
   slice (`0dd9bb6a-c919-4c07-9599-7b5c594f2168`), personal-account owner
   `2d7dffd56c905e1e`, native harness `477c9d52d200c0f6` and tool library
   `a27aa207cce82024`. Reproduce exact sandbox/socket startup, cancellation,
   revocation and failure delivery through selected account/target fixtures.
   Tool registration alone cannot clear this dependency.
4. **Deliver remaining shared helpers in bounded increments** through the integration
   slice and existing context/catalog owners: Telos browse/read and truthful prompt
   guidance first, repository preparation next, then scoped history/knowledge/service
   operations. Preserve canonical account and source authorization at each step.
   Prompt consistency reuses context work `1dbe4a6983f68cc7`.
5. **Keep existing independent contracts** for restricted skills
   (`93d58df4-9ded-46ce-8a70-a4bd4f0c9cff`), branching/context/rewind
   (`8eb4f6b6-f247-41fa-9444-4367beddbaa9`) and hooks/runtime qualification.
   No child feature, replacement registry or new hierarchy is created here.

The user requested takeover in chat `51c948ea-707d-8684-ae5a-b123209c63ad`.
Audit owner `35dc341b` and task owner `8d6b0f74` acknowledged settled safe stops;
their clean commits and original workspaces are preserved. Visibility owner
`d0d644ba` returned `recipient_unavailable`; no stop acknowledgment is claimed.
These execution handoffs do not rewrite formal Telos assignment records. The
baseline remains active until the unfinished visibility and qualification criteria
have actual acceptance evidence. Publication, merge and deployment remain separate.
