# Foundations preparation checkpoint

This checkpoint prepares S5a `9dab491c72f0494e` and S5b `df0d5bb2ec46416b`
under `85e8444019a4ae4a`. It changes fixtures, their generation and contracts;
runtime/UI implementation and CT01–CT09 acceptance remain outstanding.

The [shared contract](s5a-s5b-foundation-contract.md) is retained on the parent
as artifact `9b3661933b9e03fd2cd26af7105d9c14@1`, on S5a as
`509cae84ac35220f2a0a8245788cf268@1`, and on S5b as
`810bc114c7a8839210d98783c1f70f70@1`. All three have SHA-256
`8ee20cfac0d3ecb63b2dd2b8ff9f19722ba5b8a81ca191d80b32831fc254d9b5`.
These are proposals for S7/S9 to consume, not newly enabled wire capabilities.

## Reproduced before changes

Accepted Mitzo baseline: `189289da78d971497deaa9cc4ca29365ba9c6e56`.
The retained review's two schema tests and one hook test were ported into the
isolated checkout. All three failed for the reported reasons:

- Refinement: `SqliteError: no such column: categories`.
- Child creation after a diagnostic-only added category column:
  `SqliteError: NOT NULL constraint failed: items.first_seen`.
- Stale setup retry: context review called once instead of twice.

Five existing hook tests in that reproduction passed. The historical hook test
demonstrates the trap; its generic 409 is **not** sufficient proof to unlock a
submission. The replacement recovery tests must use the typed phase evidence in
the contract and retain exact replay for unqualified/late 409s.

Four additional prepared advisor tests use the real advisor preview/save owner,
EventStore, work/source/artifact owners and both canonical schema fixtures, with
synthetic rows and no repository or provider. They fail at the missing canonical
category column. Their downstream timestamp/history/field-preservation/replay
assertions cannot yet run; that is an evidence gap, not passing coverage.

Red test source/logs are retained separately in Telos for implementation after
the S5 dependency gate. This fixture checkpoint does not disable tests, change
runtime code or claim those regressions are repaired.

## Real canonical schemas

Accepted MGMT owner: `b4ad94541af3ed19e1a2c6fd1049fd98418016d0`, including
priority PR348. Its source files are read from a separate isolated checkout,
not the shared checkout's uncommitted changes. Run:

```sh
python3 scripts/prepare-telos-canonical-fixtures.py \
  --mgmt-root ../mgmt \
  --revision b4ad94541af3ed19e1a2c6fd1049fd98418016d0 \
  --legacy-revision 8d667f1cf9cddbd756d916bfcf50b2a936f7daff \
  --output server/__tests__/fixtures/telos-canonical
```

The generator invokes the accepted `TodoStore` with explicit temporary database
paths. Fresh means empty database through current schema/migrations. Upgraded
means actual predecessor `_SCHEMA`, synthetic starred item/history, then current
owner migrations and Python hydration. It verifies priority migration to 10 and
preservation of first-seen/creation dates and creation history. The emitted files
contain DDL only, with file/revision/schema hashes in `manifest.json`; no user or
seed rows are retained. Neither fixture invents a category column.

The fixture guard was written first and failed for missing files; after actual
owner generation, both checks pass. It verifies required timestamps, priority
constraints, history schema, foreign keys and fixture hashes. This proves fixture
preparation, not advisor persistence repair or whole-product acceptance.

```sh
NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vitest/vitest.mjs run \
  server/__tests__/telos-canonical-schema-fixtures.test.ts --maxWorkers=1
```

## Sequence and remaining acceptance

S5 remains with its current owner; PR1013 was still open/draft at
`305a265ce106a45acdd75c3f4a11ec2afa4d1493` on the dependency check. No unfinished
S5 code was copied or cherry-picked. The next implementation actions after its
acceptance are:

1. Rebase/reconcile accepted main and S5, finalize the canonical category owner
   migration in an isolated MGMT branch, and make real-schema advisor tests pass.
   Add route/client/Python round trips and CT02 fault/restart coverage.
2. Implement the typed safe-rejection fence and persisted recovery, preserving
   exact uncertain allocation/commit replay. Verify concurrency, storage failure,
   changed settings, remount and restart against actual HTTP/client/hook owners.
3. Restore readable linked context with authorized reviewed display metadata;
   compare actual mobile/desktop light/dark renders with the frozen approval and
   preserve the approved settings sheet. Complete CT06 on accepted S5 plus S5a.
4. After accepted S5a, implement the proposed repository-free capability through
   the existing ordinary workspace/allocation/dispatch owners. Prove CT07–CT09,
   including unsupported-before-allocation and no hidden repository fixtures.

CT01–CT09 remain open. Code merged, offline integrated, UX accepted and live
runtime qualified remain separate, all unclaimed by this preparation. S9 owns
combined accepted-source acceptance and the separately authorized live gate.
No other session was messaged, no S6/S8 work launched, and no model, staging,
production or deployment operation was performed.
