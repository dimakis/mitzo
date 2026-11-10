# Telos delivery recovery — 9 November 2026

Comparison base: accepted `main` at `279e6703dede` (#1275), including #1266
(`1d58b6aeb`) and #1272 (`3f5941893`). Recovery uses a new isolated clone;
the original owner's checkout, unpublished work and private recovery records
were not modified.

## Remaining source and dependency

| Candidate                                             | Evidence                                                                                                                                                                                                                                                       | Disposition                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| #1242, `87ce1fc468a586c5f449f2b03e87a22e9471d491`     | Its operator selection is superseded by main's shared `sessionToolOperatorConnection`; its settlement fixes are already present in `executeTaskOperation`. The adapter, native executor and `TurnCallbacks` consumer are unchanged from main in this recovery. | Recommend retirement as superseded after preserving the stronger callback regression below. No closure or manufactured merge. |
| #1257, `a5d7764def48e05e3ddcf29f2e91da680b9a4775`     | Private storage, preserving source import, native creation and offline transfer remain unique. Integrate main, preserving its path-identity checks and all source registrations.                                                                               | Continue normal review and CI.                                                                                                |
| #1239, `5b820b75d05a37bba59e2cb16033c6b281528a34`     | Its exact head is an ancestor of #1257. Consolidation retains its migration/import protections; no second migration implementation is added.                                                                                                                   | Earlier migration candidate; retain historical evidence.                                                                      |
| MGMT #363, `20177fa4b3d23107d568fccd557ad67676e9612a` | Still an open draft importer companion. It sends source batches to the preserving endpoint.                                                                                                                                                                    | Separate delivery/activation; this recovery does not change its scheduler or legacy service.                                  |

The actual CEN-9281EF105D42 report is #1239 issue comment 6693447355.
Main's `executeTaskOperation` copies the executor's private receipt onto fresh
results and reconstructs settlement only for durably completed exact retries.
Unknown results remain fenced. #1242's stronger native-executor test is retained
in #1257: it seals the real `TurnCallbacks` consumer during the callback, checks
normal nonzero completion and exact replay, and checks unknown outcomes with
both success/error executor flags without a second dispatch.

Against main's production source, these checks plus messaging, timers and task
authorization passed **176 tests, 11 existing skips** across five files. This
verifies the owning adapter/consumer dependency; it does not reconcile missing
historical process results or manufacture a current-head Centaur approval.
Preserve #1242 baseline reviews 5803011565, 5804001954 and 5805621744 at their
recorded SHAs; retirement does not dismiss them.

## Review repairs and validation

#1257 review 5820163914 recommends `fix`, not approval. Its two blockers were
reproduced before repair:

- CEN-47784F8F20F6: native creation now trims link URLs consistently with the
  reviewed source journal. A real source capture and exact retry verify the
  portable normalized URL. Portability validation also checks the trimmed value
  before insertion, refusing blank or whitespace-padded absolute paths.
- CEN-581423E45DD0: the 5,000-item bound applies after profile, lifecycle and
  status selection, including completed descendants. Historical rows do not
  consume the requested result bound. Evidence is hydrated only for selected
  rows; the four-query regression remains intact. More than 5,000 selected
  items still fails closed.

Focused integration passed **188 tests in 10 files**, covering these regressions,
native callback settlement, source creation/revocation, import preservation,
storage admission, offline migration, HTTP routes and collection semantics.
Source fingerprints, focused lint/format and workspace package compilation pass.
The full server/test typecheck exhausted the required 1 GiB local heap;
combined-result compilation and broad coverage remain CI requirements.

Two focused local read-only reviews identified the normalized portability gap;
it was reproduced and repaired. Centaur's exact-current-head final LGTM, merge
recommendation, zero blockers, resolved threads and App-owned status remain
separate required evidence. No new manual model review has been requested.

## Operation custody and activation

The historical failed checkout's numeric exit/result was discarded. Current
Git state is not a substitute for that receipt. This replacement does not edit
private records, replay the uncertain original command or clear its fence.
New command receipts and logs remain in the replacement task root, including
the output-bounded test attempt and heap-aborted typecheck; their uncertainty
must not be represented as successful execution.

The new clone successfully checked out #1257 and integrated the accepted base.
No database transfer, live subscription/model test, deployment, production
restart, updater change or cutover was performed. Source acceptance, historical
recovery acceptance, live adoption and Telos progress are distinct outcomes.
