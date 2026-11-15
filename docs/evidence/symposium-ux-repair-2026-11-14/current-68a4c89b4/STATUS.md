# Current integrated acceptance matrix

PR1355 / branch `test/symposium-integrated-acceptance`.
Exact source `68a4c89b4e8608bcee980da1f6a550474a3aa71a`, accepted base
`4bc83d18f24bb14f24b7c190a32c2a4fa0834963`, hosted merge
`05323e31b3e7972c38c904b048f1da889b790405`. Both merge parents were verified.

[Focused CI43672960377](https://github.com/dimakis/mitzo/actions/runs/43672960377)
SUCCEEDED: application job132686835860 passed21 checks in127.37s; render
job132686836093 passed62 browser checks. The21 are14 authenticated application
checks,5 client/portal controls and2 diagnostic controls, not21 end-to-end cases.
External account/provider execution alone is deterministic in the authenticated
journeys; browser presentation transports are separately bounded fixtures.

`A` below is `tests/integration/symposium-ordinary-acceptance.test.tsx`, SHA256
`dac763944ed487f167727dd4400964d71ec3ba68bee28c03e96b8b8f1efa3fb0`.
`hosted-application.log` records the exact source/build, Node24.22.1 and each test.
JSDOM/Vitest source transpilation proves behavior, not visual geometry.

| Case                                                                  | Observed result                             | Exact source/test/render evidence and limit                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary history and unsent draft into fresh setup/review             | PASS                                        | A main journey; actual ResponsiveChatView/shared host/composer and authenticated preparation/admission owners. Same qualified textarea/draft retained.                                                                                                                                                   |
| Silent join and reviewed context                                      | PASS, zero inference before explicit prompt | A; exact edited brief reaches deterministic native input, excluded context marker absent.                                                                                                                                                                                                                |
| First explicit reviewer reply and attributed stream                   | PASS on current head                        | A:467 onward; exact selected reviewer, one canonical operator body/reply, streaming attribution. Previous24e queued/count2vs1 failure remains in `../current-24e27b812/hosted-application.log`; unchanged assertion/deadline, cause unproved. Current pass is not a diagnosis of that failure.           |
| Exact successful retry and deduplication                              | PASS                                        | A `exact_success_retry`; original successful recipients are not dispatched again.                                                                                                                                                                                                                        |
| Responsive recipient/draft/focus/selection/context retention          | PASS behavior                               | A `responsive_owner_transition`, widths320/390/1280. Actual browser geometry is separately retained below.                                                                                                                                                                                               |
| Concurrent source and reviewer activity                               | PASS                                        | A `concurrent_source_fanout`; independent original owner remains usable, one transcript/composer.                                                                                                                                                                                                        |
| Partial failure and selected failed-recipient recovery                | PASS                                        | A `selected_failed_recipient_retry`; successful recipient not replayed.                                                                                                                                                                                                                                  |
| Long history, native-packet suppression and page rollover             | PASS                                        | A `long_history` and `source_delivery_after_page_rollover`; canonical operator text/IDs retained once, exact encoded native command absent through live view/reopen/restart.                                                                                                                             |
| Lost committed send/Stop response and visible original-request Check  | PASS                                        | A `lost_committed_send_and_stop_response`; original request/receipt retained, no replacement dispatch. Independent simultaneous SDK Stop during reviewer uncertainty remains unqualified.                                                                                                                |
| SSE reconnect, component remount and SQLite/application-owner restart | PASS                                        | A `transport_reconnect_and_remount`/`application_restart`;31 native turns before restart and0 additional native requests after restart. This is not browser hard reload, OS/device restart or live runtime qualification.                                                                                |
| Single Chats conversation with inspectable participants               | PASS                                        | A after first reply/restart, actual SessionList/Agents. Raw participant identity/history remains available without a separate Chats row.                                                                                                                                                                 |
| Authenticated grouped desktop search and exact participant Open       | PASS                                        | A `desktop_grouped_search_exact_participant_history` and explicit shared reply route. Qualified participant-only history, no raw native packet, source-only reply absent, no new inference. Source1354 remains a separate unlanded source dependency.                                                    |
| Required owner omission controls                                      | PASS5 authenticated checks                  | `tests/integration/symposium-required-owners.test.ts`; review/joining/messaging/admission/reply omission prevents acceptance.                                                                                                                                                                            |
| Assignment/fork transfer versus unrelated navigation                  | PASS5 client/portal controls                | `tests/integration/symposium-composer-transfer.test.tsx`; exact receipt/callback proof, same textarea/draft/remaining queue, unrelated owner retired. Not authenticated application assignment or browser geometry proof.                                                                                |
| Imported SDK history and responsive draft                             | PASS                                        | A imported-history case; enabled qualified input retained, no collaboration or additional execution. Initial disabled-placeholder mutation was a corrected fixture error, not production draft loss.                                                                                                     |
| SDK pre-input Stop, visible Check, retry and owner restart            | PASS authenticated responsive journey       | `tests/integration/symposium-sdk-responsive-recovery.test.tsx`;390/320/1280, terminal original receipt, same textarea/later draft,0 additional SDK inputs/interrupts and no fabricated provider acceptance/terminal. Owner SDK recovery and2 older application journeys also pass; counts overlap the14. |
| Diagnostic privacy and independent getter failures                    | PASS2 controls                              | `tests/integration/symposium-acceptance-diagnostics.test.ts` uses actual EventStore with controlled faults/private sentinels. Existing admission/current-command fields and delivery log are projected without payload/cause/account/path. Not application acceptance or a production fix.               |
| Single scroll/composer, keyboard/focus, history and200% text          | PASS tested browser cases                   | 62 checks, Chromium/WebKit, light/dark,320/390/1280×844. `render/artifact-index.json` binds6 raw manifests/18 checkpoints/213 artifact files to exact route/build/bundles.                                                                                                                               |
| Available wheel/microphone control retention/actionability            | PASS bounded presentation checks            | `render/available-control-targets.json`:42 observations/84 bounds checks and trial clicks. Narrow fixture deterministic token/voice props; no audio or per-agent usage qualification.                                                                                                                    |
| Approved HTML comparison                                              | PARTIAL                                     | Exact approved SHA `175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc` retained. Both surfaces captured; reference icon loader is unavailable and typography/content depend on ordinary settings. No reference icon/pixel-parity approval.                                                |
| Full combined CI and final exact-head review                          | PENDING                                     | Full43672960437 and own forced Centaur7589. AcceptedHTTP202/queued or successful gate workflow is not final attributed LGTM/merge0. No actual merge turn released.                                                                                                                                       |

Application artifact14145272419 SHA256
`e51dac65ed1493c7ca33e850a29efd37a7adf1111a2b4956eb0052dbfb173abc`;
render artifact14144578803 SHA256
`7f11a5962fa63f497e0c2797d548bb4c8c30dc2fd211eaf97aad5bc04e03e930`.
Original ZIPs are retained in `.cache`; archive indices and original job logs are
here. Raw manifests/checkpoints are byte-preserved. JS bundle SHA
`554e589db7c1df15081e22587b0caa7903532110fca45e585bae1c1148ef830b`, CSS
`bfc25fe0b848d28adbc4cf3ed3fb8da9510e2a45b01fe4a756d79b9b607dd985`.
Actual responsive route `/chat/architect`; narrow available-control route `/`.

The five native diagnostic production files remain exact reviewed patch SHA
`5cee44eb1766ff7005ace7aaa0eefd797666900f9cd9339fe48710f79d81b45b`.
No new tagged-error loss or source defect was proved at the closed checkpoint.
Old b80 object-capture operation1268218f and19f private-publication-helper
operation48d02f39 remain distinct unknown-effect histories requiring their original
reconciliation. Neither this passing focused run nor a future passing full run
reconciles them. They do not establish a generic failure of independently verified
source behavior. Current full CI and final review remain mandatory landing gates.

Physical-phone freeze still lacks exact original chat/request, client build and
operation/receipt. Hard browser reload, original-device keyboard/freeze, physical
audio, live provider, runtime/production, rich shared dispatch and simultaneous SDK
Stop during reviewer uncertainty remain unobserved. No blanket feature, incident,
device or production completion follows. PR1347 readiness/permission/dialog repair
is distinct and still has its own current-head gates. No deployment is authorized.

This is locally retained receipt evidence; no new code head is created merely to
store post-publication CI receipts.

Subsequent accepted main2ec453f02 (#1359) requires a genuine source integration.
This 68a checkpoint remains the baseline on4bc. Its raw receipts are included
with that integration, rather than creating a separate receipt-only code head.
See `../accepted-main-2ec-integration.md`; the new composed head needs its own
normal CI and trusted review. No old pending/cancelled run is promoted to green.
