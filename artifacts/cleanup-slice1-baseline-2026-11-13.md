# Mitzo cleanup Slice 1 — source baseline and diagnostic evidence

Observed 13 November 2026. Scope: resources launched by Mitzo on Local Mac and
OpenShell, including native Codex through Mitzo. Standalone Codex launched outside
Mitzo is excluded. This report is inventory evidence, never deletion authority.

## Provenance and delivery boundary

- Fresh `origin/main` acquisition at session start:
  `cfa324ca72d72acee34dab816631b0c6e26df673`. All source references below use that
  revision unless explicitly described as the fix. Main may advance independently.
- Isolated native clone in this conversation's admitted ordinary task workspace;
  branch `fix/cleanup-storage-diagnostics`. The managed checkout tool was not
  exposed. Historical release and unrelated September checkout were preserved.
- Diagnostic implementation commit:
  `24d9bab04ce4396a7711dc2169fc40b64e990d1a`.
- Live slice `6dab90241a7cd9db` was read at revision
  `232ea715a217fdb32a995c686fea243722fad4f66e27df63ed3be404e2db16c9`.
  This is an ordinary user-requested working session. Formal Telos role setup is
  **pending**; no worker binding or delegated authority is claimed. Feature
  `29e922e8763dc6ff` and outcome `769f3f8d8e9be028` have additional work.
- Source landing, runtime adoption and sustained-use acceptance are separate.
  No deployment, live cleanup, prune, removal, retention-policy change, live
  runtime test or model call was performed.

## Resource and owner coverage

| Resource / placement                                                   | Existing owner and observation                                                                                                                                                                                                                                                                                            | Protection and limits                                                                                                                                                                                                                                                                                                                                                                      | Byte evidence here                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local native Codex launched through Mitzo, subscription or API routes  | `ordinary-local-codex-owned-runtime.ts`, conversation store and event-store runtime/account/workspace binding. Owner `close()` aborts, releases the transition barrier/operator, disposes thread ownership and closes its native lease.                                                                                   | Queue, durable command uncertainty, current authority, exact workspace and native stopped proof protect release. A missing process after restart does not settle a lease.                                                                                                                                                                                                                  | No current process, FD, RSS, provider-history or workspace-byte measurement.                                                                              |
| Local Claude SDK, host login/API/Vertex                                | `ordinary-local-vertex-owned-runtime.ts`, `chat.ts`, session registry and ordinary command/event records. `stopChat()` closes input/query and aborts the registry owner.                                                                                                                                                  | Current operator/target authority and queued Vertex work are retained. Coordinated removal explicitly supports `claude-sdk`; shared/external/Symposium custody blocks ordinary removal.                                                                                                                                                                                                    | Workspace inventory has no byte totals; process/FD stability unmeasured.                                                                                  |
| Local Gemini / retained Responses harness                              | `ordinary-local-responses-owned-runtime.ts`, `gemini-session.ts`, `responses-chat-session.ts`, command/event records. Owner closes its controller/command map/operator authority.                                                                                                                                         | `session-harness-routing.ts` selects Codex for new OpenAI work, Gemini for Google Vertex, Claude SDK for Anthropic. Retained Responses histories remain distinct. `session-removal-runtime.ts` rejects non-Codex/non-Claude coordinated shutdown with its original-owner requirement; do not infer universal removal coverage.                                                             | No live bytes/process proof. Inspect original runtime owners before extending removal support.                                                            |
| Local worktrees, independent repository tasks and ordinary directories | `workspace-lifecycle.ts`, `repository-workspaces.ts`, ordinary workspace owners; startup join in `index.ts:1538`. Explicit roots include configured `.claude/worktrees`, `.cursor/worktrees`, `.claude/repository-tasks`, ordinary task root, repository source state and archives.                                       | Local join reads at most 2,000 sessions, with a 2,001st sentinel setting `truncated`; filesystem inventory also bounds entries (default 2,000). Unknown/conflicting/external owners, active/queued work, resume references, unsettled leases and missing physical identity remain protected. Truncation/diagnostics must survive downstream decisions.                                     | Inventory reports dispositions and reasons, not bytes or safe reclaimable space.                                                                          |
| Local archives and retained inode trees                                | `workspace-preservation.ts`, `repository-workspaces.ts` and preservation helper retain operation/workspace/root identity and verified archive digest/file/logical-byte proof.                                                                                                                                             | Independently owned task retirement verifies archive and current source, then preserves the original inode tree as `retained-source`. Linked worktrees, nonrepository directories and older workspaces retain existing custody. Archive restore verification is distinct from expiry authority.                                                                                            | Logical `archive.bytes` is evidence of content, not exclusive APFS blocks, net savings or reclaimed bytes. Private archive/checkpoint state was not read. |
| OpenShell Codex, API or brokered ChatGPT                               | `openshell-lifecycle-controller.ts`, `openshell-lifecycle.ts`, `openshell-lifecycle-service.ts`, production adapter and runtime manager retain conversation, account route, gateway/workspace, physical sandbox ID, generation and checkpoint references.                                                                 | Lifecycle reader failures block mutation. Active registry/queued/recovery/Task Board/delegated-task/Symposium custody and ambiguous identity protect resources. Checkpoint verification, physical/version identity and current authority precede stop/delete. Ordinary selection currently supports Codex on OpenShell; do not infer Claude/Gemini placement from a generic gateway count. | No live sandbox count, checkpoint bytes or per-sandbox writable-layer usage observed.                                                                     |
| OpenShell physical sandboxes, warm spares and unassigned objects       | `readOpenShellSandboxInventory()` queries all workspace sandboxes independently of ledger length. `summarizeSandboxInventory()` deduplicates physical IDs and classifies exact conversation/spare ID+name matches; others need review. Warm pool has separate persisted settings, runtime authority and uncertain states. | Authorized `GET /api/sandboxes` supplies a physical inventory alongside conversation/spare projections. Pool availability gates this route; observation grants no adoption/removal rights. Provider-scoped lifecycle phase counts can be partial. Unknown objects remain review work.                                                                                                      | Physical count is not disk consumption. Podman usage can include images, containers, volumes and unrelated users of the selected engine.                  |
| Runtime helpers, transports, terminals and retained process effects    | Native lifecycle leases/bridge, SDK queries, `terminal-owner-store.ts`, queues, timers and session-removal records provide existing owner boundaries.                                                                                                                                                                     | `session-resource-removal.ts` fences admissions, cancels/settles original prompt delivery and invokes original shutdown owners. Settled source records do not prove host processes/FDs plateau under repeated use.                                                                                                                                                                         | No authorized live process/FD stability sample or complete cross-runtime resource ledger.                                                                 |

## Policy evidence versus effective configuration

`worktree.ts:712` hardcodes a report summary and `removed: 0`, even when another
cleanup policy is requested. Its counts do not prove reclamation. The historical
CLAUDE.md description of stale cleanup is not effective-policy evidence; code and
`docs/features/session-resource-removal.md` explicitly preserve broader custody.

`openShellLifecycleEnabled()` is independently opt-in. Source defaults are
30-minute idle, five-minute reconciliation and seven-day retention. Configured
retention has a minimum of five days. Retention eligibility alone is insufficient:
the service also requires persisted operator consent plus ownership, checkpoint,
stop and current-authority checks. Warm-pool settings/expiry are a separate owner.
Observability thresholds are optional positive integers; unset thresholds disable
alerts. These are source contracts, **not the host's effective settings**.

No approved Mitzo application diagnostics connection is attached to this chat.
The connection list exposed unrelated services only. No credentials, private
configuration, account state, lifecycle database or production endpoint were read.
Consequently current deployed SHA, selected Podman machine/engine, effective
runtime/lifecycle/pool policy, inventory completeness and actual consent are
unknown. A later authorized application diagnostic should expose these safe
projections and observation timestamps without private payloads.

## Byte evidence and its limits

No new filesystem-size sample was taken. The supplied investigation handoff
reported a read-only **13 November sample**, not a current measurement here:
MGMT worktrees 314 directories / 143,391,580 KiB; old Mitzo checkout worktrees
28 directories / 2,587,728 KiB; combined 342 directories / about 139.22 GiB.
The handoff compared this with 163 directories / 33.18 GiB on 5 November.
Those figures include active work. They neither attribute a leak nor estimate safe
reclamation or exclusive APFS physical use; this session did not independently
remeasure or validate them. Supplementary investigation provenance was MGMT
`ac53a894`, `artifacts/mitzo-cleanup-followup-2026-11-13.md` (handoff evidence only).

Podman `system df --format json` reports aggregate **usage and estimated
reclaimability**, not free capacity, exact Mitzo ownership, net filesystem savings
or deletion permission. No Podman command was run against a live engine here.
Private checkpoint/archive bytes and reference graphs remain unknown.

## Bounded correction and verification

The original collector caught every error and returned only `{available:false}`;
the existing `observe()` consumer logged a generic warning. The fix preserves a
sanitized cause projection (allowlisted exception name, errno, bounded exit code
and signal), stable failing stage/code, fixed operation `podman_system_df`, unique
collection ID and safe next action. It never logs exception messages, command
output, nested causes, paths or credentials. Existing Pino adapters in `index.ts`
carry this structure and existing trace correlation without a new UI or endpoint.

Command errors, invalid JSON, non-row/empty responses, missing/invalid/unsafe byte
fields and unsafe sums remain unavailable without usage/reclaimable counters.
Legitimate zeros and existing unit conversion remain successful. The ten-second
deadline aborts the owning subprocess signal. Caller cancellation skips launch
when already aborted, discards late success, and records `telemetry_cancelled`
without warning or changing the last availability state. The default adapter
honors abort; injected test runners must do so too. Deadline and caller abort are
distinct. Identical consecutive stage/code/cause warnings are suppressed; a
changed cause warns again, successful sampling logs recovery, and a later failure
warns afresh.

Test-first evidence:

- Tests were authored before implementation. A package-free Node assertion run
  against original source failed 13 checks and passed the successful-unit control.
- The 22 Vitest cases, replayed against a temporary copy of the pinned original
  source, produced **17 failures / 5 passes**. Failures include absent diagnostic
  propagation, false success for empty/overflowed data and cancellation/deadline
  behavior. Temporary fixtures/logs remain task-local under `.mitzo-devtools`.
- Fixed source: **135/135 tests pass across six suites**: observability, command
  adapter, lifecycle production adapter, service, controller and policy/store.
  Production subprocess tests mock only `execFile`; they exercise the actual
  `collect()` → `observe()` → structured logger path without a live child.
- Targeted strict TypeScript, ESLint, Prettier and `git diff --check` pass. Tests
  used one worker and a 1 GiB Node heap. Full-project tests/builds remain CI work
  under repository resource guidance.

Setup/execution receipts: grant `0d261fed-6bfb-4a78-b637-30bb1e473f10` covers the
admitted root and repository reads/checks. Its networked bootstrap failed DNS and
hit the executor timeout; receipt and partial artifacts were inspected. The
permitted native project setup completed with task-local Node 24.22.3/npm 11.18.0
and dependencies. Offline routine checks used the grant. The managed commit route
reported a missing verified repository-task record, with no commit/staging effect
on inspection. Native Git committed only the selected files in the admitted clone.
Host SSH signing material is outside the readable profile; the local commit was
made unsigned with a per-command option, without changing signing configuration.

## Exact remaining work

1. Publish/review this focused draft; record final head, PR and CI separately in
   the live slice. No merge is authorized. Any later merge needs current-head
   Centaur final LGTM, `merge` recommendation, zero blockers and CI, without bypass.
2. Obtain an approved application diagnostics target and capture safe deployed
   revision, effective policies, full local owner joins, gateway inventory and
   pool coverage. Incomplete inventory never authorizes deletion.
3. In a later slice, repair inventory error delivery: `index.ts:364–375` and
   `openShellLifecyclePhaseCounts():67–93` retain raw provider error strings;
   partial phase counts lack an explicit completeness type and the generic
   inventory-failure branch discards stage/cause. Warm-pool router fallbacks also
   conceal underlying inventory causes. These remain separate from fixed storage
   telemetry; add real adapter-to-route regressions before changing them.
4. Reconcile linked-worktree custody, exact native/SDK/helper process ownership,
   retained Responses/Gemini shutdown coverage, filesystem objects, interrupted
   operations and shared/Symposium owners. Do not infer eligibility from age,
   absent processes or a missing inventory row.
5. Design reference-aware checkpoint/archive expiry and byte budgets with explicit
   authority and restore proofs. Measure logical versus physical bytes without
   double counting retained originals, archives, APFS clones and shared images.
6. Repeated authorized lifecycle/restore and process/FD/storage plateau acceptance
   remains open. There is no staging environment; source PR/CI is not production
   adoption or sustained-use acceptance. Formal Telos role setup is still pending.
