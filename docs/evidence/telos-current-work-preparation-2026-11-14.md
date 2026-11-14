# Telos current-work preparation, 14 November 2026

Work contract: `335551581dbf1e93`. This draft is distinct preparation on accepted
`0ad803cdae56ed6e22c89273ae800d3e7aeb9706`, not completion of the full slice.
Existing Telos assignments and operational team membership were not changed.

## Delivered changes

`readTelosCurrentWork` in `server/telos-current-work.ts` consumes the canonical
team owner's operator-authorized `readTeam(itemId, actor)` port. It projects named
current/former members, roles, responsibility, transition operation IDs and current
reporting targets. Default reads return ten current members. Explicit former reads
retain transition identity and replacement provenance. Subsequent pages require
the same canonical team revision; a change requires restarting the read.

Former or missing reporting targets have no conversation route. Replacement
provenance does not silently redirect reports. Recorded display names are labels,
not observations that a runtime is live, reachable or authorized. Text is bounded
with explicit truncation; the source revision and operation IDs remain intact.
The adapter reads no brief, update-note bodies, transcript, formal assignment or
historical allocation. It grants no control, execution or messaging authority.

Dependencies, blockers, next action/owner and PR/review evidence are explicitly
unknown because no canonical source for those facts is connected. Empty arrays
would incorrectly claim an absence of blockers. No new endpoint, tool, messaging
manager, scheduler or runtime registration is introduced. The adapter is not yet
connected to an operational tool.

The existing host hold boundary also now retains its original refusal when
recipient attribution or application-evidence storage fails. The previous inbox
failure disappeared into an empty catch; a later persistence failure replaced the
original refusal. Sanitized diagnostics retain item/session/control identity and
both original causes in the existing bounded diagnostic owner. A failed write
produces no applied evidence and does not release the hold.

## Validation

- Projection tests first failed on the missing module, then all four passed.
- Two injected control-evidence failures reproduced silent attribution loss and
  replacement of the original refusal; both pass after the fix. Restart proves
  evidence remains requested, the original hold persists and unrelated Job work
  stays unaffected.
- All 61 focused offline tests pass across current-work projection, control owner,
  control tools, command scope, runtime observations, session coordination and
  backlog tools. Existing CT10 covers queued revised-brief fencing versus immutable
  running context; CT11 covers replacement and original attribution; CT12 covers
  exact hold/release, late/duplicate acknowledgements and restart. These are existing
  canonical owners with synthetic data, not live model qualification.
- Changed-file ESLint, Prettier and whitespace checks pass. Shared package
  TypeScript compilation passes. The broad server no-emit check exhausted the
  repository's 1 GiB heap limit; hosted typecheck/build remain required.
- Source-artifact checking initially found exactly the two changed Telos helper
  fingerprints. Their pins and runtime implementation revision are updated without
  changing the rest of the registry. Preserve priority branches' additions and
  regenerate the combined revision during integration.

Dependency setup request `becf9490-801a-40f7-8a06-e08a1b849b14` timed out/SIGKILL
while registry DNS returned `ENOTFOUND`; it was not replayed. Offline recovery
copied installed dependencies into the isolated task, with an identical lockfile
SHA256 `ccca6e1e72ab39971aced83fc12bb81252dd3a298fa15fb77c6d722ab03ac8ca`.
SQLite and the native file-owner binding were smoke-tested there. TaskExecution
ran the tests under grant `9b3ee742-b79e-4617-90f2-322cfbfabe32`. Its commit service
refused an unregistered repository task; HEAD and index inspection showed no
commit before separately authorized native Git committed selected files. No host
credentials/configuration were copied. No production/service or live-model test
writes were performed.

## Ownership and composition checkpoint

The coordinator was verified as ordinary session
`f32b7063-2092-8c66-96a3-e84ca36b1a55`. Formal assignment was not inferred.

| Boundary                                       | Current owner and next action                                                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit membership store/protocol             | `45ed33e2-b07e-8be4-a1c3-16aff7ff39b2`: deliver canonical GREEN `readTeam` candidate. Contract agreed; implementation was not yet committed when this preparation was written. Offline dependency recovery was supplied to its owner.                                |
| Existing draft #1345 overview and peer replies | `1428dc32-6bd9-8974-949a-a60fd1eced22`: sole custody acknowledged and composition boundary agreed. Deliver reconciled exact candidate; connect this adapter only after membership source is ready.                                                                   |
| This projection and hold-evidence fix          | `2208b5d4-686e-8b94-82bc-8d46e0611614`: retain the separate draft; test against actual membership and composed #1345 owners when available. Define the canonical source for dependency/blocker/next-action/review facts before claiming full current-work discovery. |
| Priority shared boundaries                     | Compose accepted Claude parity, then Symposium, before shared registration/permission/runtime changes. Neither this draft nor its metadata revision authorizes a takeover of those branches.                                                                         |

The collision refresh read current heads, original scopes and complete file pages
for #1342, #1350, #1353–#1358 and #1345. There was no overlap in the five semantic
files changed here. Source-registry pins are the necessary shared metadata overlap.
Refreshed priority heads: #1350 `ce53717b`, #1353 `bf75c2f9`, #1342 `9879cf7d`;
Symposium #1356 `4ba082d5`, #1354 `7bdb364c`, integrated #1355 `b93961fb`;
separate #1357 `7fbee608`, #1358 `68acf676`; #1345 `a7cb0ac5`.
#1355's 281-file composed inventory is not independent ownership of its carried
branches. These are a dated checkpoint, not a claim that the heads cannot change.

An early suspicion about allocation fallback was not adopted as a fix: allocation
intentionally creates a durable worker link before an explicit assignment. Its
presence alone does not prove retired-worker routing. No assignment/startup
fallback was deleted without a legitimate failing case.

Full acceptance remains pending canonical membership integration, #1345 peer-reply
composition, shared priority fixes, CI/Centaur and final workflow verification.
Publication remains a draft. No ready, auto-merge, merge or deployment is authorized.

## Canonical membership qualification

A later independent offline check qualified the actual `readTeam` seam against
membership draft #1361 at `e094d629fe2778500319b8cd2498ab8211cedba6`, based on
`0ad803cdae56ed6e22c89273ae800d3e7aeb9706`. The owner's canonical foundation is
now available; this supersedes the earlier uncommitted-source checkpoint above.
It remains unmerged and its full review/CI acceptance is separate.

The retained fixture is
`tests/fixtures/telos-current-work-team.contract.mjs`. It requires the canonical
membership source and is copied to
`server/__tests__/telos-current-work-team.test.mjs` only in a disposable composition.
There is no conditional skip or fabricated roster owner. The fixture uses the
accepted fresh/upgraded canonical SQLite schemas and actual `TelosWorkStore` ports.

All six new cases first failed on the unchanged #1359 source because `readTeam`
did not exist. In a snapshot of exact #1361 source with only #1359's adapter and
four projection tests added, all 17 tests passed: six cross-owner checks, seven
membership checks and four projection checks. This is not a test of full branch
composition or of #1345's messaging/overview changes. The new checks verify:

- Formal roles do not seed the operational roster; explicit Symposium membership
  does not grant item or operator roster-read authority or dispatch any command.
- Replacement retains exact transition identity across restart, while existing
  reports to a former owner have no current route.
- Unlink replay returns the original receipt after later changes/unavailability;
  fresh discovery uses the current canonical revision rather than that old receipt.
- Revision-bound pages survive restart and reject a changed roster; former
  participants do not reappear as current owners.

The exact dependency source-artifact check passes in the disposable snapshot.
No adapter, control, schema, registry or source branch needed a compatibility fix.
Neither source PR was merged into the other. Preserve the fixture as a dependency
qualification artifact until accepted source composition permits promoting it
to an ordinary test. The broader 61-test #1359 result and these 17 checks overlap
in their four projection tests; they are not 78 distinct checks.

To reproduce inside an admitted isolated task with existing offline dependencies:

1. Materialize a disposable snapshot of exact #1361 source under `.mitzo-devtools`.
2. Overlay `server/telos-current-work.ts` and
   `server/__tests__/telos-current-work.test.ts` from #1359 `adbd93954`.
3. Copy the retained contract fixture to the test path above; provide that
   snapshot's isolated dependency/native bindings without changing another checkout.
4. Run with one worker and `NODE_OPTIONS=--max-old-space-size=1024`:
   `node node_modules/vitest/vitest.mjs run server/__tests__/telos-current-work-team.test.mjs server/__tests__/telos-current-work.test.ts server/__tests__/telos-work-team.test.ts --maxWorkers=1`.
5. Run `node scripts/check-reviewed-handler-artifacts.mjs --source` there.

#1345's owner subsequently supplied draft head
`0d65a690799ba18d7d8843c2e3672bb40e79d738`, superseding `28b658c5`; it adds explicit
lifecycle-control truncation evidence. Its overlap with #1361 in
`telos-work-store.ts` and priority #1342/#1350 integration still require their
owners' source composition. Tool/runtime/UI wiring remains blocked behind
accepted parity, then Symposium. Canonical dependency/blocker/next-action/review
facts and the operational consumer remain unresolved in this slice.
