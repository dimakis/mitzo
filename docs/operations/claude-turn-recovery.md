# Claude retained-turn inspection

Use the original signed-in operator and the conversation's selected account. The
read-only `GET /api/sessions/:id/codex-queue/recovery` endpoint reuses the existing
SDK queue custody, account, expiry and revocation checks. It neither starts a
model nor modifies a command, execution, receipt, queue or provider history.

After separately authorized activation, verify `/api/version` first and open the
diagnostic URL within the original authenticated app session. Do not extract or
copy authentication into another agent or shell. The diagnostic contains the
original retained command ID, SDK session ID, admission state, execution terminal
reason and validated SDK input/result evidence. It excludes prompt text, tool
payloads, account credentials and operator identifiers.

| Diagnostic                         | Meaning                                                                                                        | Next action                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `unconfirmed`                      | The retained evidence does not establish a terminal SDK outcome. An absent echo is not proof that nothing ran. | Retain the original operation and inspect its original owner. Do not replay it.                 |
| `cancelled_before_dispatch`        | The existing owner recorded exact positive cancellation evidence before provider input.                        | Inspect that same receipt and use existing guarded continuation controls.                       |
| `settled`                          | Validated matching SDK input and terminal provenance is retained.                                              | Inspect the original execution receipt; this read does not settle it or grant another dispatch. |
| HTTP 403                           | Original operator custody is unavailable, expired or revoked.                                                  | Return to the original authorized operator.                                                     |
| HTTP 503 with diagnostic reference | The original retained evidence cannot be validated or read.                                                    | Preserve the conversation and correlate the sanitized server diagnostic.                        |

Every successful inspection returns `mayReplay: false`. It is diagnostic evidence,
not replay consent. Native completion text, a transport close, a Ready label,
missing history and generic cleanup cannot manufacture original result evidence.
Malformed or mismatched thread provenance fails visibly. No reset or reconciliation
mutation is exposed by this endpoint.

Unexpected recovery or steering failures retain the original exception under the
returned diagnostic ID in the process-local runtime diagnostic owner. Internal
`retainedRuntimeFailure(id)` inspection preserves exception identity and any
secondary logging failure. The buffer retains the latest 32 failures and expires
on process restart; it is not a durable recovery receipt. Raw causes are never
included in HTTP responses or logs, and a failed logger does not replace the safe
failure response. This adds no public exception-inspection endpoint.

## Qualification and remaining acceptance

PR #1348 was accepted as `19aa8a19b274ae1fee416f0f187c772111251366`; its
retained source qualification covers Stop during preparation/input/callbacks,
Continue and FIFO races, guarded cold-history recovery and reconnect journeys.
PR #1362 was accepted as `8676db5788f24e818f2c997da2011029ae11c68d`; it retains
the reviewed same-operator cross-login ownership and input-diagnostic baselines.
PR #1363 was accepted as `bb9b6218c0515fb9dc63a471b4a013667e5ee3d5`; it repairs
synthetic SDK notification/input-echo result correlation. These are accepted source
baselines, not proof of personal-account or physical-device acceptance.

The current increment reproduces the result-before-correction-stdin race and
qualifies rejection, exact ACK acceptance, submitted uncertainty, original-result
FIFO isolation, original-identity retries and HTTP/composer failure delivery. Its
recovery tests use the real custody owner and HTTP router to refuse foreign,
expired and revoked operators and malformed evidence without changing receipts.

Chat `f2c4cd7b-0fbb-855d-b26b-55f3cdb172e7` remains unreconciled. Historical
release `main-30308c49d319` recorded `ordinary_sdk_result_unavailable` at
`provider_terminal` on 15 November 2026. The later running `b7762c11818d` service
includes #1363/#1364; recent sends instead fail before admission at
`capability_revision` or `command_dispatch`, and Stop finds no live session.
Those logs lack the original command/input provenance needed to settle the old
operation. This diagnostic remedy must be accepted, activated and read through
the original authorized account before claiming further recovery evidence.

Live acceptance still needs an explicitly selected target, exact supported Luna
model and charged account, and separate authority. Qualify actual Stop then
Continue, queue/steering, refresh/reconnect, cold resume/full restart and desktop
plus iPhone ownership/draft preservation. Preserve source, runtime activation and
live acceptance as separate evidence. Deployment and model calls are not implied
by this procedure.
