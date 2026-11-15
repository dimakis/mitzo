# Accepted-main integration after PR1359

The isolated `test/symposium-integrated-acceptance` branch merges actual accepted
main `2ec453f0214e6c03571ceb51697b8faeeab8da8c` (parent 4bc83d18, reviewed PR #1359
tree 64791304) into prior source `68a4c89b4e8608bcee980da1f6a550474a3aa71a`.
The only explicit conflict is source registration. All 2516 keys from both parents
are preserved and regenerated from the combined bytes as revision 1195.

Accepted main contributes Telos current-work/preparation controls, its failure
adapter and contract fixture, the reviewed native object-set test observer and
the Claude multi-device fixture. Its SDK fixture is already byte-identical to
this branch's reviewed 900ef adoption; no second patch/import is applied. Accepted
production #1356/parity remains intact. No Symposium production or diagnostic-owner
resolution was needed.

The five native diagnostic production files remain exact reviewed diff SHA256
`5cee44eb1766ff7005ace7aaa0eefd797666900f9cd9339fe48710f79d81b45b` against cc89.
No original unknown-effect operation was replayed. This merge does not claim a
fix of the earlier native capture/private-publication failures, a new cause of
the 24e queued first reply, or device/runtime qualification.

Relevant combined-tree controls:

- 28 checks/3 suites pass in 21.60s: Telos current-work, work controls and all 12 actual
  native partial-operation observer cases. `main2ec-owner-composition.log`.
- 13 checks/3 suites pass in 1.88s: 6 real producer/object-data cause consumers,
  5 strict object-store diagnostic controls and 2 acceptance diagnostic privacy/
  getter-failure controls. `main2ec-diagnostic-controls.log`. Counts overlap later
  integrated diagnostic controls and are not additive.
- The full 21 integrated ordinary acceptance checks pass in 99.52s: 14
  authenticated application checks, 5 client/portal controls and 2 diagnostic
  controls. `main2ec-integrated.log`.
- 4 registered native-preparation adapter/consumer controls pass in 11.63s,
  including the actual producer/parser/result/Pino and retained receipt path.
  `main2ec-registered-controls.log`. Deterministic external physical/account
  boundaries remain distinct from real native workflow qualification.

Fresh hosted CI and final exact-head review remain required; the prior 68a focused
21/62 result is retained in `current-68a4c89b4/`. These local logs identify the
pre-commit HEAD68a plus the merge working tree; source registration binds the
tested bytes to the subsequent published merge. They do not claim a hosted run
on the new commit. Scoped lint/format and source registration pass.

Only relevant integration review/normal new-head CI is requested. Prior accepted
source reviews remain baselines; none is treated as final approval of the new
composition. Source #1354 remains a separate unlanded dependency and must be
reconciled to leave eventual #1355 landing residual harness/evidence plus the
reviewed native correction. PR #1347 has separate custody/14 repair anchors; its
grant expired and no write there uses the #1355 grant. No actual merge turn or
deployment is authorized here.
