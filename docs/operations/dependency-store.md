# Verified development dependency store

`npm run setup:dev -- --install` checks the host's verified store before
bootstrapping Node/npm or installing dependencies. A hit gives the task private
copies of the toolchain, `node_modules`, nested workspace dependencies and the
`sqlite-file-owner` native build. Setup still checks the selected versions,
installed lockfile identity and native probes before reporting readiness.

On macOS, `/bin/cp -cR -P` uses APFS `clonefile` and preserves relative workspace
links. Initial file blocks are shared; changed files consume additional disk.
These are separate files, not hard links or a shared `node_modules` symlink.
`@mitzo/*` links resolve into each task's own packages. An unsupported clone
filesystem produces an explicit error. Other platforms use Node's reflink-or-copy
operation; the measured APFS latency is not a claim about those platforms.

## Trusted host setup

From reviewed, committed Mitzo sources in a trusted host terminal, run:

```sh
npm run setup:dev:host
```

The script archives `HEAD` into a fresh protected build, runs the existing isolated
setup, verifies readiness again, and atomically publishes an immutable snapshot.
It never promotes a task's mutable dependencies or accepts its readiness receipt
as authority. Dirty checkout files are not included in the archive. Run the script
from the reviewed implementation of this command as well as a reviewed `HEAD`.

The fixed store is `<OS user home>/.local/share/mitzo-dependency-store/v1`.
It has no command-line or environment override. The whole namespace is a
read-only runtime authority path for task shell, SDK and file-write policies,
including before the directory exists. Read-only file modes are additional
protection; the task sandbox is the trusted-writer boundary, since a host process
running as the owner could change mode bits. This requires the new policy to be
adopted by the host runtime before activation.

The identity hashes the lockfile, Node ABI, platform and architecture, workspace
manifests, `sqlite-file-owner` native source, lifecycle scripts and vendored source.
Generated native output and dependency directories are excluded from source
hashing. A full content inventory verifies the cloned payload before installing
it into a task. External/absolute symlinks, hard-linked files and special files
are rejected.

A miss follows the existing isolated network install. To make that identity
available to later sessions, run the trusted host setup above; this deliberately
builds and verifies a fresh host-owned result instead of adopting a session's
installation. There is no automatic session-to-host promotion or background
installer. Existing host `node_modules`, npm caches and credential-bearing
configuration remain excluded. Setup preserves only a supplied, structurally
validated loopback HTTP(S) proxy needed by the task executor; it does not print
proxy values or inherit other credential environment variables.

## Retention and failures

Each host setup prunes to at most **eight entries**, removing entries unused for
**30 days**. These bounds are enforced when host setup runs, not by a background
timer. This is an entry/age bound, not a byte quota. Session hits write an advisory
usage receipt inside their own `.mitzo-devtools`; the host records those times in
its private LRU ledger. APFS access times are not used.

The host discovers immediate physical `repo-*` and `ordinary-*` task roots under
its ordinary-tasks directory, with a 10,000-child scan bound. It reads only bounded,
regular, non-symlink usage receipts belonging to the OS user. Such receipts affect
retention only; they cannot authorize publication, select deletion paths or change
payloads. Programmatic host callers can supply `usageRoots` for other managed
locations. Cleanup selects only validated store entries; it never removes tasks,
source workspaces, historical releases or another invocation's retained build.

A damaged or concurrently removed entry is reported as an invalid cache result
and falls back to isolated setup. A failed native probe is reported as a rejected
hit and also falls back. Redirected destinations and unexpected filesystem errors
fail explicitly with a sanitized phase/reason and honest effect status. Internal
causes are retained; cleanup failures cannot replace the primary cause.

Host `.setup`/`.writer` locks serialize writers. A busy or abandoned lock requires
inspection of the original operation before recovery; setup never deletes an
uncertain owner's lock or replays it automatically. Host seeding can publish an
entry before later cleanup fails: inspect the existing entry/receipt before a
retry. Task readiness does not imply host publication.

## Qualification and delivery boundary

On 21 November 2026, a full Mitzo dependency set reached development readiness in
**35.192 seconds** from an APFS clone, with Node 24.22.3, npm 11.18.0 and ABI 137.
The instrumented run invoked only version/ABI/dependency/native verification,
with no install or `npm ci` subprocess. Two actual clones retained independent
file contents after a write, and all four `@mitzo/*` links resolved to the second
task's own packages. The actual task executor refused writes to the fixed host
store namespace.

That full-size measurement used a committed source snapshot at `7289eae` and the
reader including the LRU change at `e7fd648`; subsequent failure-reporting and
cleanup changes have focused offline regression coverage. It is not an
exact-final-head performance measurement. See the
[retained qualification record](../evidence/dependency-store-2026-11-21.json).

The dependency-free Node contract tests cover cache hits, miss/install/promotion,
failed verification, corruption, redirected paths, private writes, workspace
links, cleanup and bounded LRU. Run the actual sandbox refusal separately through
the task executor:

```sh
MITZO_TEST_TASK_SANDBOX=1 node --test scripts/__tests__/dependency-store-sandbox.node-test.mjs
```

The Vitest wrapper runs the portable contract tests in CI. The sandbox probe
skips unless explicitly selected in a real task executor; a generic CI process is
not the host task sandbox. Runtime policy tests cover the shared write guards.

This change prepares source for review. It does not seed the canonical host
store, activate a runtime, merge or deploy. Current-head CI and Centaur's final
LGTM/merge recommendation remain required for landing; host adoption and trusted
seeding are separate operational steps.
