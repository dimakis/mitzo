# Exact-head hosted acceptance checkpoint

Source `24e27b812fd1217513f39b58d61d44b10498c5ed`, accepted base
`4bc83d18f24bb14f24b7c190a32c2a4fa0834963`, hosted merge build
`9a70360d45815696fe0925878bf28cd3440e60fa`.

Focused run [43671152723](https://github.com/dimakis/mitzo/actions/runs/43671152723)
FAILED: application job132681261810 passed18/19; render job132681261675 passed62.
The intended application composition remains14 authenticated application checks
and5 client/portal controls; one authenticated journey failed. No visual result
substitutes for that application failure.

| Case                                                       | Observed result and exact evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First explicit reviewer reply following silent fresh setup | FAIL at `tests/integration/symposium-ordinary-acceptance.test.tsx:423`: expected2 native turns, observed1 at the existing default1s wait. Original request `129cee90-5c03-48ab-94a6-566289e7e275`, collaboration `5efb0f4a-25d3-448c-9fb4-49d177d08da3`, delivery `5451e99e-b843-4fda-9089-f7baf339013f`, exact command `collaboration:5451e99e-b843-4fda-9089-f7baf339013f` remained queued. One POST selected only reviewer `14928710-68b0-8bed-a8c3-5d34739176aa`. A queued claim is not provider acceptance. See original `hosted-application.log`. |
| Unchanged local diagnostic probe                           | PASS31-turn journey in31.946s, total38.31s,1 selected/4 unselected. `local-first-reply-probe.log` retains the unchanged assertion/deadlines. This does not establish the hosted cause or qualify the failed hosted result.                                                                                                                                                                                                                                                                                                                              |
| Responsive browser matrix                                  | PASS62. Original `hosted-render.log`,6 raw manifests/18 checkpoints under `render/`,213-file archive index and42 available-control observations/84 bounds checks. Route/build/viewport/theme and source bundle hashes are retained in the manifests.                                                                                                                                                                                                                                                                                                    |
| Required full CI / final review                            | Full43671152841 and exact-head Centaur7586 were pending at this checkpoint. A successful gate workflow/accepted request is not an attributed final LGTM.                                                                                                                                                                                                                                                                                                                                                                                                |

Original application artifact14143779669 SHA256
`8acb2be22ba461df8993dd613d457c813bb9353d46de882bea0cee3c7340ec06`;
render artifact14144089049 SHA256
`880b49551580dfb2d54ea72307159bba1e9ce43afd8c5358183c6122d5e52654`.
Both original ZIPs remain in `.cache`; archive indices preserve every entry/hash.
Raw manifest/checkpoint bytes are unmodified. Browser bundles remain JS
`554e589db7c1df15081e22587b0caa7903532110fca45e585bae1c1148ef830b` and CSS
`bfc25fe0b848d28adbc4cf3ed3fb8da9510e2a45b01fe4a756d79b9b607dd985`.

The original hosted failure lacks the exact admission/current-command observation
and filtered out the existing `collaboration_delivery_uncertain` owner record.
A harness-only diagnostic follow-up retains those allowlisted observations,
independent getter failures and native method names. It changes no production
code, acceptance assertion, timeout or retry behavior and does not claim a fix.
Existing delivery-owner guidance confirmed these current store/log observations
are sufficient; no new production interface is needed. Every ledger read and log
record parse is isolated so unavailable observations cannot replace the original
assertion failure. No receipt payload, raw error/cause, account or path is emitted
by the new projection.

The follow-up's local combined command passed21 tests in91.61s: the same14
authenticated application checks,5 client/portal checks and2 new diagnostic
privacy/getter-failure controls. The latter use the actual EventStore with controlled
getter faults and private sentinel fields; they are distinct from application
acceptance. Log: `local-owner-diagnostics.log`. The focused workflow includes these
two controls for subsequent exact-head CI. This local result neither reclassifies
the original hosted failure nor establishes its cause.

The b80 object-capture operation and19f private-publication-helper operation remain
two distinct unknown-effect histories. Their retained evidence does not prove a
new tagged-error loss or justify native scope expansion. A fresh passing source
run would not reconcile those original operations.

Original phone chat/request/build/operation identifiers are still missing. Hard
browser reload, reference icon/pixel parity, physical phone/audio, live provider,
runtime/production, rich shared dispatch and simultaneous SDK Stop during reviewer
uncertainty remain unqualified. No merge turn or deployment is implied.
