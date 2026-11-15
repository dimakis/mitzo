# Phone repair: retain queue failure observations

This test-only increment preserves the original missing-input assertion and appends a finite command observation to its original error on failure. It does not fix or establish the cause of the hosted failure.

## Original failure

PR #1347 head `a9353f0c505d3f56303a1b771359c9d08d5f0579`, accepted base `30308c49d319d0f5c66d0235a4e069ceedd792fc`, full CI `43714641542`, Unit 1 job `132814048747`: the managed personal subscription case at `claude-multi-device.test.ts:455` observed the first two inputs and lacked the raced third input. The original one-second wait and 30-second scenario budget remain unchanged.

The original job log is retained verbatim as `a935-unit1-original.log`, SHA256 `2ac788236b82057ec5980d6c3e6fa18c0d16eb40c5e9064dd1e4ea8b86282745`. Original artifact `14162366761` has ZIP SHA256 `d8f599a5f31d4d01e06056aececcfc8461d43e8e442409c4e842e3de9ab7f0d2` and remains in the owner's cache.

The `runtime_unavailable/not_admitted` and `recovery_unavailable` records also appear in a passing controlled journey with the expected same-ID overlap refusal and retry. They do not identify the hosted missing-input cause. The held-history negative is an alternative controlled state, not a reproduction of the original cause.

## Source and review

Canonical fixture owner `2208b5d4-686e-8b94-82bc-8d46e0611614` supplied only the test delta in direct handoff `494ab0cd-8720-49ad-b6ca-ff32df8c6174`. Global placement receipt `43f5cf97-d079-4e6d-a550-f94817f8651d` retains this same PR's sole target writer. Independent bounded review `e3a40e5f-5b5f-4d41-92de-080977683477` found no blocking finding on the source delta, privacy contract and controlled evidence. The original patch, manifest, review packet and logs are preserved here without rewriting their bytes.

Source patch SHA256: `bff0acfffa9f32d6fc5c8e383035a3da25c72da483ecc4582e7ebcc039042741`. Original target blob `53477c90a5b3c2abdbe924b349b78967271e68e6`; reviewed postimage blob `19d7983e78df0c27ee94cdb15624e0849421086a`.

Required Prettier formatting wraps only the admission expression after its property colon. The formatted target blob is `847e078732f9b7508ac077485b9e02ecb8f575ce`, SHA256 `9b9d66255a11358fd1643a238b076d6fa6ed4f64614161e2f324136ba44c892b`. The source owner received this exact formatting continuity in message `5b08aac5-2ed6-4358-8dd5-e9141de93a8e`.

The passing path performs no new observation. On failure, optional reads append only a fixed stage/code, current command ID/phase, and the three original commands' admission states and provider event types. Read failure appends a fixed unavailable marker; the same original error is thrown. No payload, raw error, credentials or private paths are projected. Original POSTs, IDs, order, assertions, permissions, Stop and cold-history checks remain.

## Qualification

The exact reviewed proposal passed the owner's managed case: one pass, three unselected cases, 10.14 seconds total. The peer positive and both negative logs retain their attributed scope: both negative controls remain red at the original assertion and preserve the error identity and original message. These controls do not qualify the hosted failure or all accounts.

The target registry retains all 2,506 parent keys and changes only the actual device test hash plus revision `v1.0.1201-symposium-phone-queue-observation`. All fourteen phone repair anchors, production files and approved HTML remain unchanged from the accepted-base baseline. Prior combined owner/design and authorization checks remain separately attributed in `../accepted-30308.md`; they are not new passes for this delta.

Final local formatting, lint, source-artifact and diff checks pass. The formatted managed case passes once in 9.09 seconds total, with three unselected cases; its original log SHA256 is `6c21dbaa28aececd03a5605287d89d9a4d94323d29fe76dc345a4b2aed8e5185`. This repeats the same case and is not additive coverage. New-head CI, trusted exact-head Centaur and the global exclusive merge turn remain required. No physical phone, audio, live provider, runtime or deployment qualification is claimed.
