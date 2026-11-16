# Stop and host tool receipt recovery

Investigated and verified offline on 16 November 2026. The observed incident ran
release `b7762c118`; the implementation starts from accepted main `2b080e3db`.

## Incident evidence and remaining limit

The server received Stop at 11:50:44 UTC. Subsequent ordinary continuation attempts
returned 409 before admitting the new command. Their startup diagnostic identifies
the compiled `codex-conversation-store` guard that throws
`Native terminal host effects lack matching settled receipts`.

The two continuation traces each contain 488 successful `thread/items/list` reads;
account, workspace and runtime qualification succeeded. Three queue-continue
requests returned `recovery_unavailable` without a failed-check or call identity.
Those diagnostics cannot establish which individual receipt comparison failed.
No private session database was read or changed during this investigation. The
original production chat has not been recovered or verified with the candidate.

## Earlier fixes and the uncovered composition

| Accepted change     | Relevant coverage                                                          |
| ------------------- | -------------------------------------------------------------------------- |
| #1182 / `d53cfc00c` | Continuation after terminal tool results                                   |
| #1198 / `a4d2c511d` | Retained interrupted tool effects                                          |
| #1266 / `1d58b6aeb` | Native failures, retained outcomes and diagnostics                         |
| #1269 / `9096831fc` | Original task-run receipts, child effects and reviewed historical failures |
| #1283 / `21e157466` | Failed-turn reconciliation before continuation                             |
| #1308 / `3c14fbf1d` | Shared failed-tool reporting, read classification and cold recovery        |
| #1364 / `b7762c118` | Claude admission and rejected-send recovery                                |

The cold host-receipt guard still equated the native tool success flag with the
host execution outcome. Even an exact settled host result was rejected when reply
delivery had a different outcome. This also prevented an exact original task-run
receipt from qualifying an older callback whose settlement marker was lost.
Separately, the cold item reader rejected optional string namespaces that live
host dispatch already accepted. These are reproduced defects; the production
diagnostic does not distinguish them from other receipt mismatches.

The correction retains the host's original execution outcome independently of
native delivery. Identity checks, complete bounded history, original custody,
account/workspace authority and operation-specific settlement remain mandatory.
Unknown writes, missing results, changed requests, unfinished children and revoked
authority still refuse. The fix introduces no session reset, replacement chat,
operation replay, receipt rewriting or historical incident allowlist entry.

## Verification

The cold-recovery fixture reopens real isolated Git/SQLite custody and exercises
the owning bootstrap/reconciliation adapter. New cases first failed at the same
host-receipt guard for both success/failure delivery mismatches, and at the
namespace check. They now preserve the queued follow-up, original checkout,
command attempts, task results and host receipts without any provider turn or
tool execution during reconciliation. Existing negative cases still exercise
missing or altered results, request hashes, task-run identity, account changes,
held context and unknown writes.

Structured diagnostics now distinguish receipt count, missing receipt, turn,
tool, request, result and unsettled-effect checks. Their private detail survives
error wrappers into logs and the active trace; strict public history continues
to contain only the reviewed error code and reference. No tool payload is logged.

All 881 tests across the complete conversation, chat adapter, native store,
cold recovery, history budget and diagnostic suites passed locally with one
worker and a 1 GiB Node heap. Focused ESLint, formatting and reviewed source
artifact verification passed. Full server compilation exhausted the 1 GiB heap
without completing; broad compilation remains a required CI check.

Deployment and recovery of the original session remain separate verification.
Any remaining refusal must be investigated using its new failed-check/call
diagnostic, without clearing the fence or repeating the original operation.
