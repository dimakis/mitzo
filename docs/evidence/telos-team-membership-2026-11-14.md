# Telos membership foundation evidence — 14 November 2026

Scope: explicit canonical roster, link/unlink/replacement commands, authenticated
HTTP/client consumer and retained failure delivery. This is preparation for
`4cd96f8d0f5a5f3f`, not full slice acceptance or source merge.

Base: accepted `0ad803cdae56ed6e22c89273ae800d3e7aeb9706`. Isolated assigned task
branch retained. Existing parity/Symposium branches and formal assignments were
not changed. #1354/#1356 file lists were refreshed before implementation; their
shared ordinary/runtime/navigation owners remain outside this candidate.

## Test-first evidence

- Store tests were the first source artifact. Initial run: six failures on the
  absent readTeam port. All six passed with the canonical implementation.
- API/client tests initially failed on absent routes and client methods. Forty
  tests passed after implementation, including the real loopback HTTP/client
  integration, owner replacement/unlink, exact lost-reply replay, stale conflict,
  forged actor refusal, safe storage failure and diagnostic-sink fallback.
- Symposium participation first failed at the ordinary-only compatibility check,
  then passed through the existing source-visibility policy. All seven store
  tests pass, retaining denied ordinary runtime/item-read authority.
- Final combined owner run passed **136 tests in seven files**: canonical work
  store, lifecycle, role setup, team, authenticated routes and both client suites.
  Earlier 134-test and seven-test runs overlap this result, not additional checks.
- A real canonical writer holding uncommitted item work reproduced a 503 on team
  reads. A warm read-only opener now returns the committed team without acquiring
  a schema writer. Cold missing team layouts still initialize through the existing
  canonical owner; busy/corrupt/incompatible reads never retry as writers. The
  regression failed before the fix and passes on the final combined source.
- Protocol/client package compilation passed. Scoped ESLint, formatting and
  source-artifact verification passed. A selected server semantic check exceeded
  the prescribed 1 GiB heap and aborted; it is not a passing check, and the heap
  was not raised. Full server compilation remains a normal CI requirement.

There are no browser/visual or live-runtime acceptance claims. No model calls,
production/service writes, deployment, ready/auto-merge or merge occurred.

## Dependency recovery and uncertainty

TaskExecution setup request `f744a09d-fb9c-47b1-af30-6b93e670a362` timed out with
SIGKILL and remains uncertain. Its npm log records registry.npmjs.org ENOTFOUND
before toolchain/project installation. It was not replayed and its partial
`.mitzo-devtools` state remains intact. The network's underlying cause and the
original setup's full effect reconciliation remain unverified.

An independent offline dependency copy was then qualified in this task. The
release and task package-lock SHA-256 both equal
`ccca6e1e72ab39971aced83fc12bb81252dd3a298fa15fb77c6d722ab03ac8ca`.
Node 24.10.0, SQLite and the copied native file-owner module passed local smoke
checks. Clone-copy denied a few dependency editor metadata files; no retry of
those denials occurred. Required runtime modules passed the actual owner tests.
The source release was only read; this task uses copied bytes, not a shared
writable module tree. This recovery neither qualifies the normal setup receipt
nor settles its retained uncertain outcome.

## Remaining acceptance

The agreed readTeam port is ready for the discovery worker's independent
owner-bound integration test with #1359. Current/former and stale reporting
semantics are explicit; no formal assignments seed the operational roster.
Canonical/schema/API work is independent of the priority shared repairs. Approved
team controls, reviewed agent mutations and new-chat selection/integration wait
for accepted parity then Symposium composition. All five current brief criteria
remain part of the slice; this foundation alone does not close them. Normal CI,
Centaur review and exact combined-source acceptance remain pending.

#1345's owner confirmed the narrow store composition boundary: retain its
readLifecycleOverview/lifecycle.readCurrent behavior and SQL history count beside
the separate team read/command/openForTeamRead ports. No item/lifecycle/formal-role
revision or authority derives from a team membership. Registry composition must
retain both branches' sources and rehash changed owners; no branch transfer was
requested. The shared runtime/UI work remains gated on accepted priority fixes.

The discovery worker independently qualified six new actual-owner seam cases
against exact #1361 e094d629fe2778500319b8cd2498ab8211cedba6 plus its #1359
adapter in a disposable snapshot. Its first run failed on the missing canonical
port; all 17 composed tests then passed (six new integration, seven overlapping
membership, four existing projection). This covers empty explicit roster despite
formal assignment, Symposium without grants, replacement/stale route, unlink
replay after later changes/unavailability, reopen and revision-bound pages.
Fixture/evidence source: #1359 successor53017ec92d79eba8e77927fca0677b5ef1c6ae86.
That exact-source qualification does not include this PR's later HTTP read-only
opener correction, full UI or workflow acceptance.
