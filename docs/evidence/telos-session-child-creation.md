# Telos child creation from ordinary sessions

Verified offline on 2026-10-30, starting from Mitzo `bf6bc428786617feac601834e4f340254d44bd8f`.
This records source implementation and offline validation, not deployment or live Telos changes.

## Behavior

`TelosCreateChild` extends the existing authenticated backlog tools. Default native
Mac and ordinary OpenShell Codex chats receive it without a Telos lead assignment.
Explicit agent profiles must select `mitzo:TelosCreateChild` version 1; their
existing tool selection and skill ceilings are preserved. Other runtime enrollment
is outside this change.

The caller supplies an existing parent, its fresh item revision, a complete child
brief, acceptance criteria, audit note and request ID. Exact request approval and
current operator/session authority precede the canonical write. The item owner
creates the manual child, session backlink, initial status history and receipt in
one immediate transaction. A saved receipt is recovered by the original session,
request ID and input, even after restart or later parent changes. Creation neither
captures source materials nor assigns or starts execution.

Completed parents and archived/trashed subtrees reject new children. Parent changes
invalidate new requests; creation changes the parent revision. A known committed
receipt remains recoverable, but expired session authority cannot retrieve it.

## Validation

Test-first evidence: the new child suite initially failed six creation/recovery
checks because the operation was absent. The ordinary OpenShell tests failed eight
tool-exposure checks. The initial native fixture encountered a denied host private
directory; selecting a synthetic task-local `MITZO_CODEX_PRIVATE_DIR` fixed the
fixture environment without accessing host credentials or weakening the sandbox.

The initial implementation checks used one Vitest worker and a 1 GiB Node heap, with the
repository's task-local setup (Node 24.22.2, npm 11.18.0):

- **83 passed** across `telos-create-child`, `telos-backlog-tools`, `telos-backlog`,
  `telos-item-store`, `native-telos-item-operations` and `agent-tool-catalog` tests.
- **11 passed** in `codex-chat-session.test.ts`, filtered to `Telos backlog`.
  The other 151 tests in that file were not selected.
- Focused TypeScript checking passed for the new schema, item owner, tool executor
  and creation tests, resolving workspace packages to source.

Coverage includes fresh/upgraded canonical schemas; saved briefs and parent links;
initial history and audit/session attribution; exact retry after restart; stale
parent revisions; completed/missing/archived/trashed parents and inherited archive;
transaction rollback after a history-write failure; authority checks inside the
writer; malformed input; changed approval input; cancellation/revocation; session
tool exposure/discovery/dispatch; changed viewer and skill policy during approval;
and preservation of existing item progress operations.

Broad builds and the full suite remain for CI. No browser UI change, model call,
staging operation, production deployment or live Telos mutation was performed.

## Efficiency follow-up

After implementation commit `1b95758`, the creation, edit and progress paths share
one transaction/receipt implementation. Backlog mutations share their exact-input
approval procedure. Authorization and lifecycle checks retain their existing
ordering; only the update-table observation is reused within a single transaction.

Two new query-budget regressions failed first: creation checked update-table
availability four times, and editing checked three times. Both now check once.
The child-chain test also uses the returned `parentRevision` for the next child,
without an intervening parent read, while a stale concurrent request still fails.
Tool guidance documents this use of the receipt and rereading after conflicts.

Follow-up validation: **85 tests passed** across the same six focused suites,
plus **11 session tests passed** (96 total). Focused TypeScript, lint, formatting
and diff checks passed. No dependency setup, remote reads or publication attempts
were repeated; the earlier host publication failure remains unresolved.
