# Offline context measurement validation

Source baseline: `805fbd9c9e4ce4fed60da643bf73e6a48f5c3772`, 21 November 2026.

The test-first red run failed because `context-measurement.js` did not exist.
After implementation, all 22 new schema/adapter/control cases passed. Subsequent
probes cover actual `adaptSdkQuery` and `createSdkTurnQuery` wrappers using fake
native query methods. No OS model process, generation or token-count API is
invoked by these probes; installed SDK declarations/forwarding were inspected
separately and are not misrepresented as live compatibility tests.

Focused regression command (one worker, 1 GiB heap):

```sh
NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vitest/vitest.mjs run \
  server/__tests__/context-measurement.test.ts \
  server/__tests__/chat-sdk-query-adapter.test.ts \
  server/__tests__/sdk-turn-query.test.ts \
  server/__tests__/codex-turn-usage.test.ts \
  server/__tests__/session-control-support.test.ts --maxWorkers=1
```

Result before the review follow-up: **67 tests in 5 files passed**, including a test-first follow-up ensuring
malformed owner identity cannot break failure reporting. The first broader attempt encountered a
missing local SQLite native artifact and a denied Supertest listener. Copying the
matching release's existing SQLite build and using a bounded loopback test grant
resolved those setup prerequisites; no assertions or product behavior were changed
to make the suite pass. The dependency snapshot is a local convenience, not a
claim of a clean dependency installation; CI must validate the lockfile install.

Formatting and focused ESLint passed. The complete protocol package typecheck
passed with `tsc -p packages/protocol/tsconfig.json --noEmit`. A focused strict
TypeScript check of new adapters/control/tests also passed using the new protocol
module directly as its `@mitzo/protocol` path. Full server/build checks are left to
CI under the repository's local resource limit. `git diff --check` passed.

Initial CI on `99f0c179` passed server/test-mock and frontend TypeScript checks,
but the compile/source-artifact steps refused stale registered fingerprints for
the protocol export and SDK wrapper probe. The follow-up intentionally advances
the runtime contract revision and refreshes those fingerprints, also registering
the new measurement modules/probes. The source artifact check passes locally;
this is source identity maintenance, not a Centaur review approval.

Focused local review found two additional defects: the optional SDK `skills`
breakdown is an object containing `skillFrontmatter`, and awaiting authorization
left a cancellation/retirement gap before control dispatch. Three regression
cases failed before the fixes and passed afterward. The skills fixture is typed
against installed SDK 0.3.322; its source metadata remains private and its tokens
are not added to occupancy again. Owner/cancellation checks now run immediately
after authorization awaits, including before returning a normalized snapshot.
The focused regression rerun passed **70 tests in 5 files**, together with focused
strict TypeScript, ESLint, formatting and refreshed source-artifact verification.
Centaur baseline review `6007096666` independently identified the lifecycle race
as `CEN-C9E8F4BBD574`. Two further full-mode microtask regressions cover retirement
after each authorization returns; the updated 28-case contract suite passes.

At published head `d88b662f20bd77cf9f06e6f2b04c6ee72886bf63`, CI run
`44932688769` passed and Centaur final review `6007185036` recommended merge with
zero new or unresolved blocking findings. The App-bound final LGTM status passed.
These are retained baseline results, not approval of later integration commits.

Local integration of accepted main `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`
(#1425) resolves the shared registry revision conflict while retaining both sets
of fingerprints. The upstream change projects admitted command/account/model
identity onto trace spans; it does not supply occupancy or replace the snapshot's
owner binding. Its `chat.ts`/`query-loop.ts` changes and attribution fixtures were
inspected alongside the wrapper/control probes. Publication of this integration
is held for the coordinator's selected landing slot; the final combined candidate
still requires CI and targeted Centaur integration verification.
The integrated six-suite offline run passed **82 tests**; focused strict
TypeScript, source fingerprints, registry formatting and whitespace checks passed.

Not qualified: real SDK CLI control execution, summary/full latency or cost,
model-specific context limits, ordinary OpenShell event transport, ordinary
Claude/OpenShell runtime, endpoint delivery, source drilldown authorization or
composer rendering. See the [matrix](context-measurement-matrix.md) and
[handoffs](../design/context-measurement-handoffs.md).
