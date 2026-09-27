# Reviewed canonical native seat build

This change replaces the earlier npm-wrapper image pins with the exact immutable
image built from [PR628 source `9b67c2a6`](https://github.com/dimakis/mitzo/commit/9b67c2a6c0e4decf5bc81d4b43ea2230996ec072).
That source received an exact-head Centaur LGTM and passed all CI before attended
runtime verification. The image contains the [canonical native Codex normalization](../spikes/openshell-codex/CANONICAL-CODEX.md)
and [narrow public CA read fix](../spikes/openshell-codex/SEAT-PUBLIC-CA.md).

The measured values are:

- Image ID: `sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161`
- Image manifest digest: `sha256:55b6dc5c7aaf443c4a11c44d29a170697648e63f3b8f81f7e1e93b7535e9fe17`
- `/usr/bin/codex` SHA256: `4d76e542c222ea8c75861d8c4ade60a1a332a63255ce1c60bdaebf7c2a2869e6`
- `/usr/local/bin/symposium-seat-landlock` SHA256: `286c37e476c145df22216402310b20ac7a7ac735d6280a1293b800299b76801f`
- Sandbox Codex version: `0.153.4`, Linux arm64; the host device-login CLI is separate.

The attempt controller (`d9f995cd0871ca63be4efa3c5d5760094af9c07496e1acf5d838acf8b55f2209`)
and subscription bootstrap (`ffb14857502305d354143e475ad8b417aa733857254b6d3e34b66023e444adfb`)
are byte-for-byte unchanged. OpenShell CLI/gateway version and binary hashes,
sandbox-runtime image and supervisor image pins remain unchanged. The image
normalizer's build-provenance hash is
`e049aeaf64e2d66598d9a6a11efbc8fe9a26d574a94d3ceebd59d7fe7bc4e2de`;
it is not a new runtime authority or provider grant.

## Sanitized attended evidence

The isolated personal ChatGPT connection on test port 3331 ran **gpt-5.6-luna**
with **low** effort. Two turns completed with 16 streamed text deltas; both
synthetic nonce replies matched exactly. `thread/read` replay returned the two
completed matching replies. Controller stop, exact gateway deletion, physical
workload and supervisor absence, and local SSH proxy-process absence were verified.
Final gateway sandbox inventory was empty. No private prompts, account identifiers,
credentials or nonce values are included here.

The acceptance workspace recorded `outputs/LUNA_LIVE_SMOKE.json` and
`outputs/runtime-image-measurement.json`. A separate read-only inspection of this
exact image confirmed its manifest digest and all four native artifact hashes,
using a disposable `--network=none --pull=never` container with no credentials.
Those public measured values are reproduced above so this record is reviewable
without private workspace access.

## Scope of the pin update

`TESTED_SYMPOSIUM_NATIVE_BUILD` changes only the image ID, image digest, native
Codex hash and seat Landlock hash. The owned attestation's `controllerSha256`
already derives from the native Codex entry. Regression tests reject the previous
wrapper build and wrong hashes, accept the measured build through mocked existing
proof interfaces, and still reject lost custody and changed policy. Other gate
regressions continue to require provider instance/profile proof, gateway identity,
physical image checks, artifact volume proof and reviewed roles.

This source update writes no attestation and enables no running application.
Production admission and full application acceptance remain false. Actual dynamic
host facts must still be measured and verified for the selected host; provider
allowlists, policy, credentials, leases and physical checks are not widened.
The attended execution/replay evidence does not establish enforced review token
budgets, durable terminal receipts or artifact-bound review publication proof.
