# Codex 0.159.1 isolated runtime measurement

This successor adds the native Luna 6 and Sol 6.1 catalog to fresh Symposium
seats. Existing runtime contracts remain valid for retained resources. No
production configuration, credentials or existing gateway is migrated.

The public `@openai/codex@0.159.1` package was installed in a disposable layer
based on the exact reviewed 0.156.1 image
`sha256:f3f1f3e6ad517a2055f2a6c3d56f7a03514038abcd8909cc686cc02e3ea96e5f`.
The build verifies the prior canonical executables before replacing them. The
normalizer pins the new package JSON, main ELF and code-mode helper separately.
The management runtime recipe also selects 0.159.1 for future builds.

- Package layer image: `sha256:3591fba3f05ca8dcbefdbcfe6087af8f5e92a965be00a38c485325a8856d37be`.
- Normalized image: `sha256:8d228fc4836797a00e09b48166cbeb35e0847aba76b5ef9ff796e0d1c9ae081a`.
- Podman manifest: `sha256:19f5e8c3c4eb660a94cd154740ceda3e05abea86b4107a62540a3daadf08dbff`.
- Version: `codex-cli 0.159.1`; OCI user: `sandbox`.
- Package JSON SHA256: `fa911ae5709786fb391fd8417073683915f8d8dd8527078adfc6da0fb3c0d625`.
- `/usr/bin/codex`: `22c787768933ff4d97e62e2d4613e1671e18b6a2cc999f0666be544acecffa45`.
- `/usr/bin/codex-code-mode-host`: `d2f036fd6adc398a1f87a2458c3726558c2eb5660e73dc2b4b4a6b25241c6178`.
- Normalizer SHA256: `292ef068979e55ffca80a31dfa503eab05794f507deec475544b035d4975b1b9`.

Both canonical executables are root-owned regular files with mode 0755. The
Landlock launcher, attempt controller and subscription bootstrap retain their
0.156.1 hashes. Admission verifies the complete selected image contract and the
original helper image still used for artifact sealing/export. Missing helpers,
mixed native versions and caller-supplied unknown image identities fail closed.

Credential-free containers on 30 September 2026 passed normalization `--check`
and the existing private HOME, read-only workspace, symlink and `/proc` Landlock
canary. Native `initialize` and `model/list` ran under the read-only launcher with
shell/unified/code-mode/code-mode-host tools disabled and `--network=none`.
The bundled catalog exposed `gpt-6-luna` and `gpt-6.1-sol`, both with low
reasoning, using the fields and pagination expected by `model-catalog.ts`.
The reusable `codex-0.159.1-no-inference-canary.py` also verified native coder
`externalSandbox` write/read success and outer Landlock denial of `/tmp` writes.
Native reviewer `readOnly` read and write commands remain unavailable with exit
101 and the socket/bubblewrap diagnostic. The supported reviewer uses the host's
sealed paged evidence tool with native execution tools disabled; this is not a
claim of usable native reviewer filesystem execution. Mocked sealed-page tool
checks passed separately. No turn or inference request was sent.

Run the reproducible canary on a host with the measured image already installed:

```sh
python3 docs/spikes/openshell-codex/codex-0.159.1-no-inference-canary.py
```

It starts one disposable network-disabled container with no host mounts or
credentials, checks the exact ID/digest and native hashes, and removes it on exit.

This proves the measured native catalog and narrow isolation boundary, not account
entitlement, live model execution, integrated review acceptance or deployment.
A new independently custodied stage must refresh the authenticated account's
catalog before selecting either model. Tests that make model calls must explicitly
select supported Luna and announce the charged account; Sol is not a test fallback.
The original Stage 21 catalog on 0.156.1 exposed only 5.6 Luna, so its new-model
guards correctly refused continuation without inference.

The [official Codex changelog](https://learn.chatgpt.com/docs/changelog) describes
0.159.1's bundled GPT-6.1 Sol addition. Account availability still depends on the
current plan, client and workspace settings.

Build inputs are `Dockerfile.codex-0.159.1-measure`,
`Dockerfile.codex-0.159.1-normalized-measure` and
`normalize-symposium-codex-0.159.1-measure.py` in this directory. Build both layers
with `--pull=never` and the measured image IDs as their respective base arguments;
never rebuild an active stage in place.
