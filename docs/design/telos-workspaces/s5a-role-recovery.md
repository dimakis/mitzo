# S5a role admission recovery

Role setup keeps its original request identity through uncertain allocation or
commit. A status code or error message does not establish that no allocation was
possible. Only the separate strict `recovery` metadata for the same request may
report `rejected_before_allocation`; `recover_original` remains conservative.

The existing WorkStore owns an immutable terminal admission journal. In its
immediate SQLite transaction it checks existing intents and request ownership,
then the item revision and complete reviewed context before creating an allocation
operation. Known stale review records terminal rejection. The host throws the
qualified error after commit. An enclosing transaction suppresses positive proof:
releasing a savepoint cannot establish that its caller will commit. Existing
allocation-capable intents and receipts never acquire positive rejection proof.
Exact rejected input stays rejected after reopening and restoring old work state.
Changed actor/input, unavailable/private material and failed journal writes cannot
borrow proof. This journal creates no workspace, conversation, task or command.

Only the role setup HTTP endpoint emits this metadata, and only for its actual
qualified conflict. The client validates strict schema, endpoint, status/code and
request identity; unknown metadata and generic conflicts retain exact replay.
Historical setup/context DTOs, retained guidance and fingerprints are unchanged.

Device storage retains original rejected submissions and validated proof in
append-only history before releasing the active submission and review. Failed
storage keeps replacement locked and the original request available after reload.
A late old response cannot clear a newer request or a newer explicit review
retained by another tab. Legacy
version-one drafts without history remain readable. Explicit Review updated brief
uses the existing primary control, then explicit confirmation creates a new UUID.
Reload never initiates fresh review/allocation. The component records that explicit
review's settings key to prevent an immediate automatic duplicate review.

## Qualification

All checks use synthetic databases/fake ports or intercepted browser traffic, one
worker and a 1 GiB Node heap. No staging, production configuration or real model
test is involved. The canonical parent is separately published as PR1027; this
follow-on is unpublished until its accepted parent is integrated.

The expanded unchanged-source baseline was 34 cases: 23 passed and 11 failed.
The component guard had an additional failing-before test. Focused recovery then
passed 39 cases and the existing owner suite passed 66, including S5 delegation
and execution authority. Package and scoped server/frontend TypeScript checks
passed using this checkout's workspace packages. Shared design checks passed
108 cases with one existing skip; approval/reference/protected tests are retained.

Actual small-component browser diagnostics exposed duplicate context review. The
nested outer-rollback probe separately failed before its proof suppression. Both
repairs pass 14 focused server/component cases, including all eleven HTTP cases.
The subsequent exact mobile browser rerun failed during initial navigation and
has no qualification result. Earlier full-shell and isolated browser diagnostics
retain all failures/traces. Browser/visual acceptance, full-shell combined behavior,
full type/build/CI, two approved reviews and exact-head final review remain open.
The isolated browser fixture renders actual TelosRoleSetup, client, hook and
ChatInput; it does not replace the full-shell/Quick sheet journey.

This increment does not complete human metadata pinning, CT06 or S5a acceptance.
S5b runtime implementation still requires accepted S5a. Publication, accepted
source, offline integration, UX acceptance and live runtime qualification remain
separate states.

A further before-confirmation tab-race probe failed when a delayed old rejection
erased a newer review. Release now also checks the original active submission (or
an identical already-terminal value) before writing. All fourteen hook cases pass,
including both tab races. The 41 current focused cases are covered by the earlier
39-case pass plus the eleven-server/three-component guard pass and the final
fourteen-hook pass; a single new aggregate run is not claimed.
