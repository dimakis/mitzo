# Agent-driven Telos session creation

Delivery candidate, 12 November 2026. `TelosCreateSession` proposes a distinct
ordinary chat already assigned to selected work. Configuration and retained-work
context review occur in the originating chat with **Approve & create**. There is
no manual linking step. Creation admits no provider command. The prompt stays in
the downloadable proposal handoff; the child receives canonical role, brief and
reviewed-source context. A later command needs separate execution authority.

## Integration and custody

This change depends on PR [#1302](https://github.com/dimakis/mitzo/pull/1302),
published head `4c0ea58af6c5a4b7a96c9ac71e5a3649c2ce189b`. At inspection it was
open, non-draft and conflicting with main. Its combined #1291/#1262/#1287 owners
are reused. Prepare a dependent draft, preserving its branch and owner. Live
Telos evidence reports eleven unpublished continuations through `8f5ed6d73`;
those changes were not inspected here. #1239 remains a separate storage delivery.

The isolated branch is `feat/telos-agent-create-assign-20261112`; the old dirty
checkout remains untouched. This implementation chat has no verified Telos role.
No production Telos item, assignment or session was created by these tests.
Preserve capability chat `4ea07afc-8d61-8ca2-8805-47af80435ad6` and uncertain child
request `capability-baseline-first-slice-20261112`. Their cause and assignment
remain unverified. This change does not adopt that chat.

## Delivery 1 contract

- Canonical current parent assignment and exact direct-child relationship select
  the role: semantic outcome → feature creates a lead; feature → slice creates a
  worker. Runtime kinds remain `coordinator` → `outcome` → `work_item`. Titles and
  provenance confer no authority. Existing target assignments cannot be replaced.
- `SessionLaunchStore` retains immutable work scope, source/artifact selection,
  reviewed context and authenticated review owner. Work scope participates in the
  request fingerprint even when original agent input is stored separately.
- `TelosSessionLaunchPort` composes the operator-only reviewed role host. Proposal
  ID is the canonical role setup request ID. Settings and context are retained
  before allocation. There is no private metadata attachment or second allocator.
- A canonical create-only reservation prevents competing agent or manual setup.
  Duplicate approvals, restart and lost delivery recover the retained allocation
  identity. Ordinary prepared/running transitions reject work-bound requests.
- `assigned` is a historical creation receipt. Readiness, current assignment,
  execution admission and completion remain separate facts. Starting work needs
  its explicit authority and receipt. Creation generates no command ID.
- Existing transcript review, settings editor, linked context and related-chat
  navigation are reused. Missing/mismatched context disables approval. Child
  runtime/account/model/profile/permissions are separately reviewed. Credentials,
  grants and arbitrary transcript history are not inherited. Never substitute
  plain `StartSession` for a work-bound request.

### Support and qualification

| Caller                                 | Child route                 | Evidence boundary                                  |
| -------------------------------------- | --------------------------- | -------------------------------------------------- |
| Owned Codex, Local Mac                 | Independent Local Mac Codex | Native adapter/shared host tests                   |
| Owned Codex, OpenShell                 | Independent Local Mac Codex | Host tool bridge; mixed-location contract          |
| Claude, Local Mac                      | Independent Local Mac Codex | Authenticated host MCP proposal bridge             |
| Claude, OpenShell                      | Unsupported caller          | Existing host-tool/runtime dependency              |
| Any caller → Claude or OpenShell child | Unsupported child           | Existing ordinary qualifier rejects before effects |

Child account, model, profile, workspace and permissions must also pass the existing
qualifier. Repository reuse and unsupported context/tool selectors are refused.
This matrix is source/offline evidence, not live runtime qualification.
Legacy OpenShell callers without host ownership do not advertise this operation.

### Recovery limitation

Unfinished reservations remain retained when allocation cannot be disproved. A
missing receipt alone does not prove no child exists. If authority or context
changes during an unfinished operation, the original immutable request can become
ineligible for retry and block replacement setup. Diagnostics identify its original
operation; this delivery does not add a safe operator release action. Do not erase
journals or invent a new request ID. Release must reconcile workspace and EventStore
allocation owners first. Automatic recovery from every cancellation/crash state is
not claimed; this remains a delivery gap requiring the bounded follow-up below.

## Verification and release gates

Observed red/green tests use one worker and a 1 GiB heap. Focused service, work-store,
canonical role-setup, runtime, adapter and frontend tests cover exact ownership,
duplicates/concurrency, reservations, retained context and lost delivery. Real
canonical allocator fixtures admit no live model command. A read-only host fence
avoids a second schema writer inside the role transaction.

Final focused run: 28 test files passed, 462 tests passed and one existing
conditional design test skipped. This includes the complete 185-test Codex chat
adapter suite and 49 composed role/runtime cases.

Protocol/harness/client TypeScript builds and selected changed-source diagnostics
passed. Full imported-server diagnostics exhausted the required heap and remain
CI work. Final source pins, lint and formatting must match the committed head.
Local commits are unsigned because the signing key is outside the permitted
filesystem; no signing configuration changed. Installation skipped scripts;
lint was run explicitly rather than claiming installed commit hooks.

The intercepted desktop/mobile browser fixture covers ordinary and Telos review.
Rendered verification could not execute: the approved host executor's Chromium
process failed macOS Mach-port registration with permission denied. No browser
policy bypass or binary retry followed that failure. No screenshots or rendered
pass are claimed; hosted browser checks remain required.

Keep the PR draft pending combined-result CI, rendered checks and review. Preserve
exact-head Centaur LGTM/merge recommendation and zero-blocker gates before a
separately authorized merge. No merge, deployment, staging, production mutation
or live model calls are authorized here.

## Delivery 2: reviewed adoption and recovery

Reconcile #1302's unpublished context-epoch/quiescence work first. Select the exact
existing ordinary chat, work/role/revisions and account/runtime/history custody.
Review bounded context and replacement eligibility at a safe point; preserve prior
assignments, sources, attempts and provenance. Busy chats and incompatible retained
roles remain blocked. Do not interrupt to adopt, rewrite private metadata, copy
arbitrary history or allocate a replacement chat as an adoption fallback.

Use durable receipts and crash/retry tests through canonical assignment, context,
workspace and execution owners. Include separately reviewed release of unfinished
create-only reservations only after reconciling allocation and admission. The
capability chat is preserved evidence, not authorization to adopt it now.
Acceptance: one supported review journey, no orphan, dual lead or history loss.

## Delivery 3: runtime parity and qualification

Depend on delivery 1's shared request/receipt contract, native harness owner
`477c9d52d200c0f6` and readiness owner `65129503d34b4bc3`. Extend routes through
canonical ordinary runtime, admission and permission owners. Separate caller and
child engine/location/account. Record configured, approved, attached, process-ready,
operation-verified and execution-admitted facts separately for each combination.
Unsupported cells need actionable reasons/dependencies, not permissive fallback.

Offline parity precedes live qualification. Live runs require a selected target
and separate explicit authorization, including the repository's supported Luna
model and named charged account. Preserve create-only and mixed engine/location
tests on supported routes. Do not automatically create more sessions.

## Existing Telos dependencies

Reuse parent `85e8444019a4ae4a`, S4 `4cd96f8d0f5a5f3f`, S5
`cf8dc85a4b6afaad`, S5b `df0d5bb2ec46416b` and S9 `b896d14d79d52682`.
Their live contracts and the native harness/readiness contracts were read.
Capability outcome `8e186fdf-9058-4ad6-af18-8fd6797bf935` and baseline feature
`1a3ad6c5-36b0-4744-9ea1-7bd8c18f253b` depend on this according to the user's
reproduction; they were not reread. This document creates no replacement work or
assignment for the implementation chat.
