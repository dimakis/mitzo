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

Result: **66 tests in 5 files passed**. The first broader attempt encountered a
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

Not qualified: real SDK CLI control execution, summary/full latency or cost,
model-specific context limits, ordinary OpenShell event transport, ordinary
Claude/OpenShell runtime, endpoint delivery, source drilldown authorization or
composer rendering. See the [matrix](context-measurement-matrix.md) and
[handoffs](../design/context-measurement-handoffs.md).
