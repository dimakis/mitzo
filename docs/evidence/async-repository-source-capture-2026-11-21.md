# Cancellable local repository source capture

Slice `a111e7e6658c460d`, retained under `0e7adf5e27292950` and cross-referenced
to efficiency feature `3379c5330bdc1b02`. Baseline: accepted main
`9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`.

## Selected path and behavior

`RepositoryWorkspaces.selectLocalRepository(binding, repositoryId, selection,
signal, requestId, startPoint)` → `selectLocalRepositorySource` →
`captureLocalRepository` → source identity, explicit commit and optional HEAD
branch `git rev-parse` reads in `local-repository-worktree.ts`.

The selected capture phase uses asynchronous `execFile`, a 16 KiB output bound
and a five-second deadline per probe. It retains the existing Git arguments and
isolated environment. It avoids the synchronous macOS executable resolver on
this path. These fixed metadata reads do not invoke hooks, fsmonitor, filters or
lazy-fetch helpers. No arbitrary subprocess or Git mutation is added.

Stop and deadline expiration kill the child with SIGKILL and await `close`
before settling. Cancellation returns the exact signal reason. Nonzero failures
retain the original subprocess error, code and stderr. The timer is cleared on
every settlement. There is no retry or fallback after an uncertain/failed read.

The existing controller still joins source capture with runtime qualification,
aborts the sibling with the original failure and awaits both before returning.
Its source/runtime authority checks and signal check still precede the reservation
INSERT. Tests verify that cancellation publishes no reservation and launches only
one probe. Git mutation ordering and existing operation owners are unchanged.

## Measured regression

Offline Mac fixture, Node 24.22.3, one Vitest worker, 1 GiB heap. Each selected
Git subprocess deliberately waits 1,000 ms before executing real Git. The
HTTP fixture mounts the real repository controller behind synthetic select,
status and Stop handlers; it does not run the production server.

| Observation                                       |                      Original source | Changed source | Budget |
| ------------------------------------------------- | -----------------------------------: | -------------: | -----: |
| Event-loop status dispatch                        |                          4,354.82 ms |       19.38 ms | 250 ms |
| HTTP status response from selection entry         |                          4,410.31 ms |        4.07 ms | 250 ms |
| Stop through child collection, event-loop fixture | Too late: selection already finished |        1.58 ms | 250 ms |
| HTTP Stop through child collection                | Too late: selection already finished |        3.07 ms | 250 ms |

The baseline failed the declared responsiveness assertion. The HTTP baseline was
rerun with the original `local-repository-worktree.ts` from the accepted base and
the same new HTTP fixture. These are single-run regression observations, not
production percentiles or a claim about all selection stages. PR #1429 is not
evidence for this optimization.

All 40 tests passed across `local-repository-capture-responsive`,
`local-repository-workspaces`, `local-repository-worktree-performance`, and
`existing-local-repository-workspaces`. They cover pre-launch cancellation,
in-flight Stop, sibling failure, caller timeout, the built-in five-second timeout,
child PID collection, no duplicate probe/publication, nonzero failure, explicit
HEAD semantics, source/proof changes, pinned skills and preserved dirty work.
The process-count fixture now counts asynchronous source probes and excludes the
optional executable resolver. The hook-security fixture explicitly creates its
hooks directory because the bounded executor supplies an empty Git template.

## Custody, adjacent work and limits

The current slice brief, ARCHQ-12 `fb026133d2bcab9f`, latency slice
`facabd5d29f01bc9`, and its accepted #1409 evidence were read. #1409 reduced
repeated authority proofs; it did not make these source probes asynchronous.

Original canonical owner `22b07039-6db2-8d38-88f4-773b3bb9334b` remains assigned
and not live, with unknown execution. Its supported public transcript read
scanned three events and returned no messages. The 81-entry open-PR list and
source-repository branch/worktree metadata yielded no matching candidate. This
is bounded search evidence, not proof of no original effects. No original task,
stopped chat, source checkout, ownership or private state was changed.

Implementation uses an independent admitted checkout and its own execution grant.
Task-local dependencies were installed using the corrected #1428 scripts at
`8ad9db0c5d2fac0f3f9ba1ef266bc945ed2dcaa0`, with `dependencyStore:false`.
Those installer files are local tooling, not part of this PR.

Residual synchronous work: `assertLocalRepository` in later authorization,
`inspectLocalRepositoryWorktree`, default-branch resolution and parts of
`fetchWorktreeBase`, legacy `createWorktree`/multi-repository creation, and bounded
filesystem identity probes. This PR does not claim the entire successful
selection endpoint is nonblocking. Their owners can select a subsequent bounded
path with separate regression evidence; none is silently migrated here.

Astra consultation `a49a7076-e7ac-4703-9489-c54d87919c12` failed during preparation;
one supported recovery remained uncertain, then its original receipt was stopped.
It produced no contribution or review approval. Exact-head CI (including broad
typecheck/build) and Centaur final LGTM with merge recommendation remain landing
gates. No merge, deployment or production benchmark was performed.
