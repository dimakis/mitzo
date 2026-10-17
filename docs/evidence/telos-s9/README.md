# Telos S9 early offline acceptance evidence

Latest accepted-base refresh: [final offline merge validation](merge-validation.md).

Independent review extension: [consolidated diagnostics and owning slices](audit-followup.md).

Earlier landing refresh: [accepted-base integration and revalidation](landing.md).
The initial map snapshots and original results below remain pinned to their original run; the refresh
records the newer combined source and repeated offline checks separately.

S9 `b896d14d79d52682`, parent `85e8444019a4ae4a`: **active**. CT17/CT18 are
partially evidenced, CT19 and CT20 remain pending. This increment is an evidence PR,
not final acceptance. The [44-row map](requirements-evidence.md) and its
[structured ledger](requirements-evidence.json) belong to S9. Other slices retain
their implementation and evidence ownership. S1's planned fixture and all frozen
approval artifacts are unchanged.

## Exact sources and scope

- Mitzo accepted main: `189289da78d971497deaa9cc4ca29365ba9c6e56`.
  [Production owner hashes](accepted-source.json) identify the exercised bytes;
  they are evidence of this run, not a freeze on future owner changes.
- MGMT accepted main: `b4ad94541af3ed19e1a2c6fd1049fd98418016d0` (PR348).
  [Canonical schema provenance](../../../tests/integration/telos-s9/fixtures/canonical-schema-source.json)
  pins the actual `TodoStore`/model sources and exported schema hash. An isolated
  reference checkout was fetched because the shared MGMT working files were
  uncommitted and omitted the accepted priority change. Those working files and
  user database rows are not acceptance fixtures.
- Frozen mock `9d0559132154b92d0bbb427a982a0002@r1`, SHA-256
  `97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab`.
  Approved acceptance contract `c54d6f2479aab619b163187829b6bdff@r1`;
  corrective matrix `1411c5cd72dabca9c11205dd596cc5b6@r1` and amendment
  `728d7c4d2d5f3a2f65a530d787ec5a70@r1` remain the requirement sources.
- Symposium scope: current `docs/features/symposium.md` and existing parent
  `c0851ba23fcc5d04`, including its 16 October fresh-agent correction.
  Existing-chat import and old phase instructions are not exercised or revived.
  `OrdinaryCollaborationJoining` is accepted source with fake authority here;
  its production installation still requires actual native capacity authority.
- S5 PR1013 was OPEN/draft at `305a265ce106a45acdd75c3f4a11ec2afa4d1493`.
  Mitzo priority PR1009 was OPEN at
  `f1ea61f2641eb1fbbe5d273a9511a9c24d44b2f8`; MGMT348 is merged. Open
  candidates are not imported into this accepted-source run.

## What the tests establish

| Boundary                                                      | Evidence and limits                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical persistence → Express routers → typed client        | Actual MGMT-generated fresh schema with synthetic hierarchy, source capture/adoption, retained material revisions, source/lead separation, reviewed goal/parent context and silent ordinary role preparation. Stale review rejects before preparation.                                                                                           |
| Durable setup receipt → restart/client retry                  | Lose the successful response after commit, reopen stores and replay the original identity. Changed input conflicts; later brief/messages/material revisions cannot rewrite the receipt or selected context.                                                                                                                                      |
| Telos and fresh Symposium → shared ordinary preparation       | Independently prepared Git/task roots and account/settings/context bindings survive exact replay and restart. Joining alone and Telos setup create no model turn.                                                                                                                                                                                |
| Ordinary command ledger → collaboration delivery/reply/output | Prepared first-command admission, exact ACK, restart before ACK, forged cross-session command/receipt rejection, independent finalized reply mapping and output references. Same message/block/request labels deliberately collide across sessions. Conversation output registration remains a reference, not independent retained content.      |
| Two ordinary native queues → fake RPC                         | Actual `CodexConversation` and private command store; interrupt one conversation, reject a mismatched terminal callback, complete the other independently. Fake native callbacks are not runtime qualification.                                                                                                                                  |
| Retained Telos role → real task dispatcher/store              | Lead cannot execute a task. Unrelated Symposium task can dispatch through a fake outgoing chat port, report `pending_review`, survive restart and require explicit task approval. The native queue test is separate; this is not an end-to-end worker allocation/completion callback proof. Task approval leaves canonical Telos outcome active. |

Only external repository/account/authority effects, HTTP response loss, the outgoing
task-chat port and provider RPC are deterministic fakes. Canonical SQLite, retained
Telos bytes, Git directories, preparation, mounted routers, protocol/client parsing,
delivery/reply owners, native queue and task dispatcher/store run unchanged. No
application bootstrap, backend configuration, credential store or provider is started.

## Reproduce

From the isolated Mitzo checkout, with installed dependencies:

```sh
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run tests/integration/telos-s9 --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run server/__tests__/collaboration-joining-owner.test.ts server/__tests__/collaboration-ordinary-delivery.test.ts server/__tests__/collaboration-ordinary-replies.test.ts server/__tests__/ordinary-contributor-stop.test.ts --maxWorkers=1
```

On this Mac, Supertest's temporary HTTP sockets require execution outside Seatbelt.
No live backend is used. One worker and a 1 GiB Node heap were used throughout;
broad builds/tests belong to CI. Local dependencies were borrowed read-only from
the retained review installation (Vitest 4.1.11, Vite 6.4.3, better-sqlite3 13.0.3);
no production `.env`, runtime configuration or credentials were borrowed.

The canonical advisor required-behavior tests are **red evidence**, run explicitly:

```sh
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run --config tests/integration/telos-s9/red.vitest.config.ts
```

They assert successful canonical writes and currently fail; they do not assert
that broken behavior is correct. They are not skipped tests, and are not part of
the passing subset. [Defect reproduction and ownership](defects.md) belong to
S5a. Move them into normal regression discovery when that contract is repaired
and accepted; do not weaken their success assertions or add fixture-only columns.

To deliberately regenerate the empty schema from a clean accepted MGMT checkout:

```sh
python3 tests/integration/telos-s9/export-canonical-schema.py /path/to/accepted/mgmt-checkout
```

The exporter invokes actual fresh initialization and migrations on a temporary
empty database. The checked-in snapshot does **not** test upgrades from every
pre-change schema. CT01 upgrade/atomicity/history qualification remains S5a work.

## Results and open gates

- [New integration/ledger run](accepted-tests.json): **8 passed**, no skipped tests.
- [Selected existing owner regressions](reused-owner-tests.json): **41 passed**,
  no skipped tests. This reuses existing joining/concurrency, context ACK/recovery,
  reply and parsed WebSocket Stop coverage without editing owner unit-test files.
- [Canonical advisor contracts](canonical-advisor-red.json): **2 failed** on the
  missing canonical `categories` column. See the [failure log](canonical-advisor-red.log).
- [Exact test/config hashes and run metadata](results.json) identify this increment.
  The initial test-first harness failure is retained separately and is not a
  product defect. Local changed-file ESLint/Prettier checks passed.

Full repository-backed advisor → lead → exact child/worker/task → retained result
→ review → verified outcome still awaits accepted S5/S5a contracts. Independent
non-code workspaces and their full journey await S5b; no repository-backed fixture
is counted as non-code evidence. S6 brief-adoption/replacement/hold authority and
S7/S8 UI/priority/chooser/lifecycle contracts remain with their owners. Future
interfaces are pending in the map, not guessed implementations or permanent skips.

The initial run performed no visual work. Later diagnostic captures are recorded in [audit-followup.md](audit-followup.md); no visual acceptance is claimed. Final desktop/mobile, narrow widths, light/dark,
resources/settings/navigation and approved-design comparison remain CT20 pending.
The historical review's 80 passing checks and **three failing regressions** remain
historical failures, never corrective success. F2/F3 and required child timestamps
are not claimed fixed by this increment.

CT19 has **no selected or authorized runtime/window**. Sequential Telos/Symposium
live qualification, model calls, staging operations and production deployment were
not run. Any later real-model test must explicitly select supported Luna and
announce exact model/account under separate authorization. S9 and parent remain
open. Merge requires explicit authority, green exact-head CI and Centaur final
LGTM/`merge` with zero blockers; the user subsequently authorized gated merging of PR1018. Feature acceptance remains open.
