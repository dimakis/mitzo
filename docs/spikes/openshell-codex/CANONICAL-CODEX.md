# Canonical native Codex in disposable seat images

The reviewed Linux arm64 runtime package is `@openai/codex` **0.153.4**. Its npm
`/usr/bin/codex` entrypoint is a symlink to a JavaScript wrapper. The wrapper starts
a child ELF under the platform package, so the connecting process is not identified
by the policy's `/usr/bin/codex` path. Its ancestor is Node, not the JavaScript
pathname. This is distinct from the host's 0.156.1 device-login CLI.

Pinned [OpenShell policy source](https://github.com/NVIDIA/OpenShell/blob/1905069948f96921daf88bffb160dceb9ac2a307/crates/openshell-supervisor-network/data/sandbox-policy.rego#L144-L171)
matches executable paths and executable ancestors. It deliberately excludes
command-line paths because they are spoofable. The
[binary identity implementation](https://github.com/NVIDIA/OpenShell/blob/1905069948f96921daf88bffb160dceb9ac2a307/crates/openshell-binary-identity/README.md)
reads and hashes the live `/proc/<pid>/exe` object.

`Dockerfile.symposium-seat-probe` now runs `normalize-symposium-codex.py --install`
inside the image build. The script accepts only the reviewed Linux arm64 package,
package JSON hash and native ELF hash below. It replaces only the expected npm
entrypoint symlink with a root-owned regular copy of that ELF, retaining all npm
package assets. An already normalized image is checked without replacement.
Unknown architectures, versions, hashes, symlink targets and writable/nonregular
artifacts fail; no package is downloaded or upgraded. `--check` is read-only.

- Version: `0.153.4`
- Package JSON SHA256: `302ed64d0846795501768be9f60f78133688c0c09162c76e80a8a04b045664cb`
- Native ELF SHA256: `4d76e542c222ea8c75861d8c4ade60a1a332a63255ce1c60bdaebf7c2a2869e6`
- Source ELF: `/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex`
- Canonical ELF: `/usr/bin/codex`

The seat launcher checks for a root-owned, nonwritable regular arm64 ELF before
starting direct Codex or the subscription bootstrap. This structural startup check
rejects old shim images; full byte hashes remain the build validator and immutable
image proof's responsibility. No network policy/provider profile or approved
capability manifest changes. Existing inspected REST and credential rewrite guards
remain unchanged. A new image digest and launcher/native binary hashes must be
recorded and reviewed before runtime admission; historical attestation pins are
not updated or bypassed by this source change.

## Offline reproduction

```sh
sh docs/spikes/openshell-codex/canonical-codex-smoke.sh
```

The script uses the existing immutable image
`c621f4a66281689c9d4c2692ca7234ba61cd154f58c3df003a193f58375bb63d`, with
`--network=none --pull=never`, no host mounts and no credentials. It proves the
old image fails the canonical check and, before the launcher fix, incorrectly
passes bootstrap. After normalization, read/write seat version checks succeed;
a local app-server process exposes `/usr/bin/codex` through `/proc/<pid>/exe`.
No inference request is sent. Hash mutation and changed package metadata fail.
The npm wrapper inspected in this pinned image adds only package-manager update
metadata and signal forwarding; it does not inject an asset path needed for this
offline startup. Package assets remain present in the normalized image.

This does not prove a successful live subscription request. The fresh image's exact
ID/digest and emitted native/package proof still need to be captured by the attended
acceptance runner. Running gateways and existing policies are not edited.
