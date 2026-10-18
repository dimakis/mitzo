# Canonical advisor persistence: S5a-owned red evidence

Owner: S5a `9dab491c72f0494e` under Telos parent `85e8444019a4ae4a`.
This is a current reproduction of historical review F1, not a new competing slice.
S9 owns the reproduction/evidence files only; no production or owner unit-test
files were changed.

Tested production source: Mitzo `189289da78d971497deaa9cc4ca29365ba9c6e56`.
Canonical schema source: actual MGMT `TodoStore` initialization/migrations at
accepted `b4ad94541af3ed19e1a2c6fd1049fd98418016d0`, using an empty temporary
database, with exact hashes in the schema provenance file.

Reproduce both required behaviors:

```sh
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run --config tests/integration/telos-s9/red.vitest.config.ts
```

1. Create synthetic goal/outcome/child/sibling records with canonical required
   timestamps. Open the actual `TelosWorkStore` and explicitly classify the outcome.
2. Request advisor refinement or child creation through `saveAdvisorDraft` using
   the existing input contract and a deterministic source-retention callback.
3. Expected: canonical item/source/history/receipt invariants can be satisfied.
   Actual: refinement throws `SqliteError: no such column: categories`; child
   creation throws `SqliteError: table items has no column named categories`.

The callback is not reached: these tests localize the production persistence
mismatch. They do not claim full advisor route/context authorization coverage.
The full reviewed save remains required after repair. Both tests deliberately
assert success and remain red; see [retained log](canonical-advisor-red.log).

The historical missing `first_seen`/`last_seen` child failure after a fixture
category patch is **not rerun as passing evidence**. No category patch is added
here. S5a must verify actual fresh and upgrade schemas, timestamps/history,
atomicity and exact replay after an accepted repair. Historical F2 stale-draft UI
recovery and F3 linked-context UX also remain S5a obligations; backend stale
rejection and post-commit receipt replay do not resolve them. Repository-free
capability F4 remains with S5b `df0d5bb2ec46416b`.
