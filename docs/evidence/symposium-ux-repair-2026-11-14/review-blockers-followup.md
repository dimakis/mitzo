# Independent review blocker follow-up

Centaur [review5905022505](https://github.com/dimakis/mitzo/pull/1355#pullrequestreview-5905022505)
at source b93961fb79790b38a62395920c084fb0e018598f reports `human_decision`:
two unresolved blockers, no approval. The prior11-application/56-browser checkpoint
did not cover these paths strongly enough. Slice1 owns production fixes; slice3 owns
the independent tests here. No merge, deployment or device qualification follows.

| Blocker          | Independent baseline observation                                                                                                                                                                                                                                                                                    | Source and original evidence                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CEN-A5B18F62570B | FAIL live rollover, frontend reopen and persisted application-owner restart. Exact native user command remains in authenticated ordinary history after its operator prompt leaves the shared50-message page, then incorrectly renders as a user row. Existing31-turn/zero-after-restart dispatch counts still pass. | `tests/integration/symposium-ordinary-acceptance.test.tsx`, helper `assertRolledSourceDelivery`; `centaur-b939-rollover-red.log`. Actual ResponsiveChatView and authenticated application/router/SQLite/native owner with deterministic external RPC. Soft assertions collect all three failures without skipping recovery/restart.                                     |
| CEN-6CFB95D6132C | FAIL both new-chat assignment and ordinary fork after exact correlated `_send_accepted`: input remounts, later edit/focus/selection disappear and remaining queue is absent. Unrelated navigation/late assignment control passes, preserving the independent destination draft.                                     | `tests/integration/symposium-composer-transfer.test.tsx`; `centaur-b939-assignment-red.log`. Actual client protocol parser, exact assignment/receipt observers, ChatInputHost, ChatInput, draft and queue hooks. Deterministic wire transport and a controlled running edge; component/client integration, not authenticated backend or actual responsive-screen proof. |

Both baseline runs use Node24.10.0, one Vitest worker,1GiB heap and JSDOM;
no browser geometry, live account/provider or phone inference is claimed. The
assignment fixture preserves one send and exact original command identity. Further
acceptance requires owner fixes integrated in the isolated verification branch,
red-to-green checks without weakening either control, combined CI and a terminal
exact-head Centaur verdict. Slice3 now owns review requests/shepherding for #1355,
per the user's corrected ownership instruction relayed by the origin; no duplicate
dispatch and no inherited merge authority.
