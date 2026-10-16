# Approved Telos workspaces: S1 contract baseline

Parent: `85e8444019a4ae4a`. Slice: `accd3d6f834c164d` (S1).
Accepted source inspected: `405b0192149847df177357e8786e26587b2dd3b7`.

This baseline implements wire contracts and offline fixture data for the approved
16 October 2026 UX. It does not activate a work store, allocator, model turn or
new UI. The frozen mock controls appearance and navigation; its sample people,
settings and dates are illustrative. Do not replace it with this fixture data.
Any visible or behavioral difference needs Dimitri's explicit prior approval.

## Frozen references

All references below are retained Telos artifacts at **revision 1**. Retrieve
that exact revision and verify SHA-256 before inspecting or comparing it. Do not
rewrite the baseline or use historical mocks as alternate designs.

| Reference                            | Artifact ID                        | SHA-256                                                            |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------ |
| Interactive mock, Desktop and Mobile | `9d0559132154b92d0bbb427a982a0002` | `97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab` |
| Standalone preview                   | `ff847891190287af7dc8fae53e527a15` | `a2163fd6a6646e20e585a7f7c4cac7c9bf1d5c7cce1686376b1ea7dd89f7f20b` |
| Implementation plan                  | `5957850821c8afa3fd3b8e19e01fa34b` | `28d94dd9c633e9bf2f0753d63a905f0abaaf923b3ef810d853d399f30a0fa8d5` |
| Acceptance contract                  | `c54d6f2479aab619b163187829b6bdff` | `dc048d578f23934af1ce0ddc97f4189cc51f19f15890c17098357cf56c91f255` |
| Existing slices and dependencies     | `c99be8d519c5218a55640af3059c166b` | `1cb0ad70fc1135b81841b64b2b1a0aca4cdf305084affb1c63cafb30ff5f0a3e` |
| Approved decisions                   | `ec3ff6f95811538c163be3602b6196e5` | `70ab0271886f681380f67a2157547c2d29fec474798ae605f46804539ea3d374` |
| Mock identity manifest               | `5707a8f5b093463065dfa663e1b6ff6f` | `f8582db37eccfa0478b90616f7589d9f0f9b35fa8ef6f908031a2267dbd13b07` |
| Original persistence receipt         | `49b5030c7f34f0b2594df7162a696ab8` | `dc2ad9e0eb37a3179a58a99d4c988a72efdf6f626901db9bc3e2e23c1ace97aa` |

Source discussion: external Codex thread
`01a143b4-ed3e-78b2-b382-4ceab60f3baf` (“Reassess Agent Taskboard Strategy”).
It is an external source reference and does not establish a Mitzo session or lead.

## Contract and fixture ownership

- [Protocol](../../../packages/protocol/src/telos-work.ts): explicit work kinds,
  ordinary/external conversation references, retained role links, separate current
  assignments, source selections, exact artifact revisions, allocation attempts
  and per-recipient control evidence. Validation supplies no role, timestamp,
  authority or execution. `kind: null` preserves unknown legacy classification.
- [Fixtures](../../../frontend/src/test-utils/telos-work-fixtures.ts): fresh,
  independent fixture state for Home studio with no lead; a configured lead with
  an unstarted slice; one leaf with five chats; six coordinated outcomes and
  unrelated Job work; nested coordinators; unknown legacy provenance; and
  uncertain allocation followed by an explicit retry. All settings are fake.
- [Source map](source-owners.json): existing owner IDs and repository-relative
  modules, proposed additions and concrete integration gaps. Resolve Mitzo paths
  from the isolated Mitzo worktree and MGMT paths from its separate repository.
  Canonical checkout paths are read references, not editing destinations.
- [Coverage ledger](acceptance-coverage.json): every UX01–UX24 row has its
  contract slices, integration owner, intended test file/case and frozen mock
  identity. These test cases are **planned downstream coverage**, not passing
  application assertions. Screenshot, runtime, retained evidence and PR/commit
  cells remain empty until those checks actually run. S9 owns final qualification.

Runtime settings reuse `SessionRuntimeBindingSchema` and
`OrdinaryLocalCommandSelectionSchema`. These capture selection and never prove
admission. A role link cannot alter an existing account, workspace or target.
Source selection is explicit; unknown selections, authors and dates stay unknown.
External URLs, original source snippets and retained artifact bytes are separate.

`TelosWorkAttempt` describes allocation readiness. It cannot claim work running
or completed. Existing SessionService, queues and execution ledger own those
facts. S2 owns composition/dependency cycles, current-assignment uniqueness,
authorization, cross-store recovery and backup integration. S3 owns source capture
and legacy migration. S4–S6 own scoped role, delegation and coordination wiring.

## Test-first evidence

The first implementation artifact was
`server/__tests__/telos-work-contract.test.ts`. Before contracts or fixtures were
created, this command failed with exit 1:

```sh
NODE_OPTIONS=--max-old-space-size=1024 npm test -- server/__tests__/telos-work-contract.test.ts --maxWorkers=1
```

Vitest reported `Cannot find module '../../packages/protocol/src/telos-work.js'`.
That is the intended missing-contract failure: one failed suite, no collected
tests. The same command passed after implementation (initially 12 contract tests). It
checks wire rejection and fixture invariants; it does not prove live persistence,
ordinary-session allocation or application behavior.

CI then exposed the required reviewed runtime manifest update for the new protocol
export. Its two existing artifact guards were reproduced red locally. An additional
test first failed on the missing `telos-work.ts` fingerprint. The fix pins both the
new wire contract and changed index, advancing the existing Connections runtime
revision to `v1.0.170`. There are now 13 passing S1 contract tests; the guards remain
enabled. No provider policy or runtime activation changes.

Local checks also passed: 84 existing runtime-binding, orchestration,
SessionService and collaboration regressions; all 107 shared design checks;
protocol/harness/client builds; frontend type-check; focused server contract
type-check; changed-file lint and formatting. The full server type-check exceeded
the bounded 1 GiB local heap and remains a CI check. The shared fixture helper
lives under server test ownership with a frontend facade so the server TypeScript
project does not import frontend source outside its root.

The parent, S1, eleven integration-owner records and all eight pinned revisions
were retrieved from canonical Telos using a read-only SQLite connection because
named Telos tools were not exposed to this external Codex chat. Stored byte
counts and hashes were verified; retrieved bytes match the frozen local mirrors.
No Mitzo session or production credentials were borrowed for retrieval.

Interactive Desktop/Mobile click-through remains **outstanding**: Browser policy
rejected `file://` and explicitly prohibited workarounds. Both source variants were
inspected; there are no screenshots or traces establishing visual conformance.
This is an evidence gap, not an approved UX amendment. S1 must remain active until
its required inspection, review and CI evidence is complete. No product UI change
is included in this contract-only slice.

Canonical staging and its pipeline remain stood down. Use offline tests, review
and CI. A live target and any production deployment need separate authorization.
Actual model tests must explicitly select a supported Luna model and announce
the exact model/account beforehand; these contract tests make no model calls.
