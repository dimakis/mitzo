# Reviewed code-mode native seat image

The original owned image and Claude-capable variant remain pinned. This
successor starts from the already reviewed, public-CA-fixed owned image
`a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161`.
It installs the public Linux/arm64 `@openai/codex@0.155.1` package and copies
both reviewed native executables to `/usr/bin`. Codex resolves its code-mode
host beside the main executable; copying only `codex` caused a completed live
Luna turn to report `/usr/bin/codex-code-mode-host` missing and perform no
filesystem work.

The disposable package-layer image was
`f9b6dd9ebbad622ad39302f2d96e44f8fb3b370d5aa04e98157e3a33110734eb`.
The final local image ID is
`93233f9037f12afadfa1fb17a8ee96aa7e94499366d6977b4859a93fa03e5004`,
with Podman manifest digest
`sha256:161cde9d0f59c07b3354a0e5c2d863b3796ed81716c728f7eafd4db70ab0dd42`.
The exact build inputs are
[`Dockerfile.codex-0.155.1-measure`](../spikes/openshell-codex/Dockerfile.codex-0.155.1-measure),
[`Dockerfile.codex-0.155.1-normalized-measure`](../spikes/openshell-codex/Dockerfile.codex-0.155.1-normalized-measure),
and [`normalize-symposium-codex-0.155.1-measure.py`](../spikes/openshell-codex/normalize-symposium-codex-0.155.1-measure.py).

| Root-owned regular executable | SHA256 |
| --- | --- |
| `/usr/bin/codex` | `298d3d73d0bbc1367e58a370df5b6216fe30ce0a92e8b6b0afb0377a958dc335` |
| `/usr/bin/codex-code-mode-host` | `7348d1c1cee36270b5599da24ed431e1ac6372666a94bb09e09ef87d1bc9e3b8` |
| `/usr/local/bin/symposium-attempt-controller` | `d9f995cd0871ca63be4efa3c5d5760094af9c07496e1acf5d838acf8b55f2209` |
| `/usr/local/bin/symposium-seat-landlock` | `286c37e476c145df22216402310b20ac7a7ac735d6280a1293b800299b76801f` |
| `/usr/local/bin/symposium-subscription-app-server` | `ffb14857502305d354143e475ad8b417aa733857254b6d3e34b66023e444adfb` |

The package JSON SHA256 was
`98862962c00eef34e3946f14a4345c26efbaaa733f8c6188069654a234adeee0`.
The build check verified Codex `0.155.1`, both native hashes and the original
CA-fixed Landlock hash. In disposable containers with `--network=none`, no
credentials and no model call, native `command/exec` with `externalSandbox`
wrote and read a workspace marker. Native `readOnly` denied writes to both
`/sandbox` and `/tmp` (exit 2) and read `/etc/os-release` (exit 0).
Native `model/list` offered `gpt-5.6-luna`; it did not offer `gpt-6-luna` or
`gpt-6-sol`. This image therefore supports the explicitly approved 5.6 Luna
acceptance path and does not claim Luna 6 availability.

The runtime contract selects this image by exact ID. Its new helper is a
mandatory physical artifact for this image; the original and Claude images
retain their separate artifact sets. This static image evidence is not a live
application, account, credential, seal, or production migration acceptance.
