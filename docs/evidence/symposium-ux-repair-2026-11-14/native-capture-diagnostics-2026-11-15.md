# Bounded native capture diagnostics

The original native capture failure remains unexplained. This correction preserves
the failed check through the existing owners so a later independently admitted
operation can report useful evidence without replaying the original operation.

Source baseline: local merge `cc89d5effc76cfc814beb961141d887786d530f6`
integrates accepted main `4bc83d18f24bb14f24b7c190a32c2a4fa0834963`.
The five native preimages match published `4995de380817085c7405ab5b63c7754d5ba52040`.
The reviewed production patch SHA256 is
`5cee44eb1766ff7005ace7aaa0eefd797666900f9cd9339fe48710f79d81b45b`.

The pinned object-store program previously returned only `error:unavailable`,
including on exit zero. Its reader parsed only success. The real intermediate
preparation-objects owner and the object-data owner then discarded the original
failure; cleanup could replace it. The correction uses a strict finite refusal
label, private WeakMap error provenance, and existing primary/cleanup projections.
It preserves original error references and allowlisted errno classification.
No raw stdout/stderr, parser excerpt, path, request or private cause enters the
public diagnostic. Existing command/call/attempt/diagnostic IDs remain the
correlation contract. Effect stays unknown, recovery stays inspect_operation,
and retry stays after_reconciliation.

The original capture and any started final validation join before scratch
disposal. Final validation remains the guarded check → verify → check unit under
its original physical budgets. Only already settled validation failures enter
bounded aggregation. Independent reader/full/sync fences and owned disposal
retain their errors. Success schemas, source/identity/no-link/denied-root guards,
byte/file/deadline limits, authority, CAS and successful views remain intact.
The compatibility wrapper outside the native object-data path is unchanged.

| Case                                                                                                                        | Observed result                                                                                                                                                                          | Exact retained artifact                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Strict capture/verify refusals, malformed/mixed/extra/oversized transport, primary/cleanup check projection                 | Initial five failures retained; corrected tests included in the 75-check focused pass                                                                                                    | `native-capture-diagnostics/native-diagnostic-red.log`, `native-focused-final.log`                         |
| Original primary identity and independent reader/full/sync failures                                                         | Two baseline failures retained; corrected tests included in focused pass                                                                                                                 | `native-primary-red.log`, `native-focused-final.log`                                                       |
| Required real preparation-objects consumer                                                                                  | Four failures with the initial four-file correction; six pass after the fifth-owner correction                                                                                           | `native-required-consumer-red.log`, `native-required-consumer-guarded-green.log`                           |
| Cancellation and pending original validation                                                                                | Cancellation starts no physical verification; advancing beyond 10 seconds cannot settle or dispose a pending verification                                                                | Same six-control consumer log                                                                              |
| Real registered signed callback → real objects → object-data → native reader → parser → adapter → reopened durable consumer | Four registration/authority tests pass; controlled physical refusal and nested private-cause transport error retain exact identities, unknown recovery, and sanitized actual Pino output | `native-real-producer-adapter-final.log`                                                                   |
| Physical pinned program and reader controls                                                                                 | Five pinned-program checks and 22 reader checks passed within the earlier focused batch; six existing physical-integration gates skipped                                                 | `native-focused-final.log`                                                                                 |
| Three additional pinned hardlink/denied/size canaries and broader native-base composition                                   | Not yet qualified: broader command reached executor timeout before a summary; no pass count or automatic replay                                                                          | `native-pinned-and-adapter.log`, request `164aa2a3-b8e0-4538-a777-2ad76d44296a`, inspected state uncertain |
| Scoped independent code review                                                                                              | Existing reviewer 059e verified exact five-file patch; no bounded source blocker; no gate waiver                                                                                         | `independent-review.md.txt`; peer message `8b4d4a61-a541-4393-be85-9c6ae16d53c5`                           |
| Successful preparation view                                                                                                 | One actual required commit/tree/blob capture passes and preserves dirty source/index/untracked bytes; other cases filtered                                                               | `native-successful-view.log`                                                                               |

The 75-check batch, registered four and consumer six overlap earlier runs; counts
must not be summed as separate feature qualification. The first red diagnostic
run also contained a fixture assertion against the wrong result property; that
assertion was corrected before the green run. Original logs are retained.
The registered test explicitly controls the source qualifier/operation entry;
within it, the new failure path executes the actual five repaired owners. Its
external sandbox transport runs fixed read helpers on disposable fixture paths.
This is not live sandbox, permission acceptance, model or device qualification.

The original full CI `43657840941` native job `132641473501` failed at
repository_object_capture (6068/6186ms), with diagnostic IDs
`96fae7a3-b955-4092-965e-c7c232a75f29` and
`8a42f6ac-9349-41ee-9274-830c2a6adcd8`. Original logs/artifact hashes remain under
`current-4995de380/`. No current capture cause, safe replay, complete phone root
cause, production readiness or blanket incident closure follows from this repair.
Fresh exact-head combined CI and final Centaur review remain required.

The separately owned SDK fixture contribution is exactly blob
`47610a58827f5d700c3a5f023ac7d7549be23f84` from reviewed published #1359
`0b93b77f6f5f8f43b02f611b66684c97fd3cd2f3`. Only that one-file incremental patch
was adopted after matching preimage `2898fb8c1c372a7efc57de9114dd1b0c66e2a7cd`.
Own branch controls pass four cases: three cleanup/actual active-owner-guard
controls and default-profile Vertex transfer. Personal/explicit transfer and
cleanup controls pass separately in the #1347 checkout. These are separate
branch results; the earlier uncertain six-case command is not requalified.
Readiness allowance changes from one to ten seconds remain explicit; lifecycle
ten seconds and scenario sixty seconds remain unchanged. Original hosted causes
are unproved. No whole #1359 branch, Telos source or foreign registry was imported.

Hosted compile follow-up: exact published f4d20f82b CI43664029172,
job132659348172, reported four TypeScript errors in the two new test instruments:
a missing negative-control receipt identity, private transport request narrowing,
and a readonly expected-array argument. The test-only correction supplies the
original identity, checks the private request field before parsing, and copies the
readonly expectation. All assertions remain. The affected 26 checks pass with six
existing physical gates skipped; lint/format pass. The exact reviewed five native
production files remain unchanged. Original compile output SHA256
`9336c05b050a2b04abeaacc5a728351a3adbd34abe2dc126a4828ac7ecf401a9`
and corrected-control output are retained as `f4d-compile-original.log` and
`native-type-correction-controls.log`. Hosted compilation and current-head final
review still require fresh results; a local transpiled test pass is not a typecheck.

## Existing-test contract follow-up after current hosted CI

Exact2248449e1 completed hosted compile/source preflight132661241472 and Core
checks successfully. Its focused43664654566 passed14 authenticated application
checks, five client/portal controls and62 browser tests. The raw artifacts and
exact build/viewports remain under `current-2248449e1/`; these passes do not
qualify its failing full CI43664654595.

Unit4 job132662861847 failed three existing assertions requiring generic
`Preparation objects unavailable` text after the reviewed producer now retains
original errors. The test-only update requires original Git code128 with no
published view or alternate-target read, exact non-abort first-error identity,
and original cancellation reference after all started wave reads join. Existing
cancellation-before-object-results precedence and no-next-wave assertions remain.
The first local test candidate incorrectly expected synchronous `status` rather
than asynchronous `code`, and a read error despite that cancellation precedence;
its red output is preserved, not attributed to production. The corrected three
native controls and two targeted-sharing controls pass in12.23s. The latter
fixture now fulfills only the exact GET source-recipient readiness response;
all unexpected requests and non-GET requests still fail. No UI production change.

The same head's Unit2 job132662861862 failed only the canonical guarded-detach
control225 at the unchanged default5000ms budget (518 other files/7368 tests
passed). After this actual match and exact47610a preimage, only the existing
owner's independently reviewed d43ea9ba setup patch was adopted. Its incremental
SHA256 is `274936e58b186f0fe4a55dfc08be946ba477dc16e2d4f15695fa11e48e33886a`,
result Git blob `6fe3d2b5f93dcfe00783b38fe792f7b996365eee`.
It removes unrelated Git/account fixture setup while retaining the actual
EventStore, registry, active-owner setter and all cause/guard/store assertions.
Default5s, lifecycle10s and scenario60s limits are unchanged. Five own affected
controls pass52.92s: guard3.46s, both cleanup controls and default-profile
Vertex/personal transfers. This is separate from the53.62s PR1347 receipt.

Original Unit4 log SHA256
`f57cfc3a205ef10b463b663a5f9bbb07189cb1951a88b8e24f73573831fd544a`,
artifact14142093381 SHA256
`dd2b4bdc51cd4e2f4cdc2f220c1421f0c68bfc6f41dc6f26ca19e18cee40895c`;
Unit2 log SHA256
`4389df6527bbb1178a53720cc8198bbb8223044995a2461ff4b95647f516d4fb`,
artifact14142174013 SHA256
`808443717d5c4548a043b299991f939dc2572315f6907e707fca34111821264d`.
Original logs, local candidate red, focused green and SDK controls are retained
under `current-2248449e1/`. The independently reviewed five production files
remain unchanged; source pins retain2514 keys at revision1191. Fresh successor
combined CI and final exact-head review remain required. Neither failure proves
the original hosted capture cause or the original device incident.
