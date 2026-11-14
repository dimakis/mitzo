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

The expanded transfer baseline also exercises correlated `session_id` followed by
the exact `user_message` acceptance: all four assignment/fork variants fail, while
unrelated navigation, late assignment and return to the original saved draft pass.
`centaur-b939-assignment-expanded-red.log` preserves that run separately.

## Separate terminal combined-CI failure

Current published b939 full CI43604334027 is **FAILED**, job132476431194
(`Native repository and authorization workflows`); focused43604334018 is successful.
Both `native-local-repository-read-registration{,-api}.test.ts` fail at the real
workflow fixture:679 on `PrepareLocalRepository`. Source qualification succeeds,
then `repository_object_capture` fails. Sanitized diagnostics report
`stage=repository_preparation`, `reason=unknown`, `effectStatus=unknown`:
0578028f-913a-4d5a-9d29-82d0b087b95a and4fe31338-1986-465f-b5fc-e18cd87ac77f.
`hosted-b939-native-ci-failure.log` is the original full job log, SHA256
`a915c6b4226fed79c7ba41e75f4e43a22fbe5e0e8fb95fe8412451972af03ca9`.
No root cause, safe retry or successful outcome is inferred. The parity coordinator
confirms no verified current native-capture owner or accepted fix; the origin has
that coordination gap. Slice3 has not changed this production surface. This is
separate from the two confirmed Symposium regressions and original phone incident.
