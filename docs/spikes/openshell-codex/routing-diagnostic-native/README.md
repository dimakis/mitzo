# Finite routing diagnostic native successor

This public source artifact adds an explicit CLI creation-time `--log-level`
pass-through and a disabled-by-default supervisor diagnostic target. The exact
filter is `off,openshell.routing_http=debug` (32 ASCII bytes). Normal discovery,
providers, Codex workload, gateway binary and native forwarding are unchanged.
No new artifact is selected or adopted by this recipe.

`native.patch` applies to official NVIDIA/OpenShell commit
`854b2370b8740b67f6481d3015272fc37aaf9427`. `Cargo.lock` records the unchanged
registry closure. `qualified-public-dependencies.json` records all 766 exact
checksum-verified public archives; `exact-public-provisioning.json` records the
8 additional exact public archives provisioned before offline builds. No private
Cargo configuration, credentials, proxy environment or retained runtime was copied.

`source-qualification.json` records source tree/archive/patch hashes, the native
DCO commit, actual compiler versions, focused tests and measured release artifacts.
`native-commit.txt` and `native-parent-commit.txt` preserve both DCO commit objects so reconstructing the
reviewed source does not invent a different Git-derived version. Use a depth-one
fetch of the pinned official parent with no tags, apply the patch, write its tree
and verify the recorded final tree ID. Reverse `native-style.patch`, write and
verify the recorded parent tree, then write `native-parent-commit.txt` using
`git hash-object -t commit -w --stdin`. Restore `native-style.patch`, verify the
final tree again, and write `native-commit.txt` with that same command. Both IDs
must equal the recorded commits before setting HEAD to the final commit. Do not edit version constants or
inject version environment variables.

## Bounded build recipe

Build with the already installed Rust 1.95.0 toolchain. The measured Linux build
used Zig 0.16.0 and cargo-zigbuild 0.22.3. Do not auto-download a toolchain or install
software. Use a fresh private HOME, CARGO_HOME containing only the qualified public
registry cache, CARGO_TARGET_DIR, TMPDIR and Zig caches. The process environment
contains only these paths, PATH, RUSTUP_HOME, CARGO_NET_OFFLINE=true and
CARGO_BUILD_JOBS=2. No proxy, model, API, provider, cloud or loader environment is
inherited. Commands run in the reconstructed source in the foreground, with an
owned process-group deadline of 900 seconds each:

```text
cargo zigbuild --offline --locked --release -j2 --target aarch64-unknown-linux-gnu.2.28 -p openshell-supervisor --bin openshell-supervisor
cargo build --offline --locked --release -j2 -p openshell-cli --bin openshell
cargo test --offline --locked -j2 -p openshell-supervisor-network routing_diagnostic
cargo test --offline --locked -j2 -p openshell-cli --bin openshell sandbox_create_explicit_log_level
```

Only the CLI unit test uses the installed public Z3 library search path because
its test-only server dependency requires Z3. The release build uses no such path;
`otool -L` reports Apple system libraries only. Release outputs are qualified by
SHA, loader/ABI dependencies and actual CLI `--version`, not by source assumptions.
The Linux supervisor version was executed in a peer-reviewed, network-none,
read-only, non-root, version-only artifact qualification container with no mounts,
auth/provider inputs or persisted logs. Its exact cleanup was independently checked.
The unchanged gateway version is recorded separately from the new CLI/supervisor pair.

The full native `mise run pre-commit` was attempted with offline/tool auto-install
disabled and stopped at unavailable tools in the scrubbed environment. Changed
Rust files passed rustfmt and diff checks; focused CLI and actual production
console-formatter tests passed. No live gateway/sandbox/model test was run.

## Console contract and privacy

The supervisor recognizes only `chatgpt.com:443`, uppercase GET, the exact origin
request target `/backend-api/wham/accounts/check`, and no query. One final terminal
event per nonzero bounded ordinal carries a fixed kind/method/outcome plus an
optional final status 100–599. Interim headers are skipped. The actual production
shorthand layer emits UTC milliseconds, DEBUG, the dedicated target and this
finite message grammar:

```text
TIMESTAMP DEBUG openshell.routing_http: routing diagnostic v1 kind=account_check method=GET outcome=response request_ordinal=ORDINAL status_code=STATUS
```

Actually wired failures are credential_unavailable, transport_failed, relay_failed
and malformed_response. There is no Error Display, URI, header, body, auth token,
account ID or provider data in the event. The synthetic relay test compares exact
forwarded bytes with logging disabled/enabled and uses private header/body fixtures,
100 then 403, and an invalid final status 600. No real endpoint is contacted.

The selected supervisorImage is the OCI config identity; its manifest digest is
recorded separately. Container `.Image` is normalized and compared to that explicit
config ID, avoiding a config/manifest mismatch. The host must bind observations
to the exact original private namespace,
sandbox name/native ID, creation claim, managed supervisor role and selected image.
It must reject any RUST_LOG override, require the exact diagnostic log-level entry,
then recheck identity/image/filter/custody before and after bounded console reads.
`filter-template-fixture.go` proves the finite environment marker expression using
the actual Go template engine (6 offline fixtures); it never prints environment values.

An absent event is inconclusive. Multiple matching requests remain separate;
HTTP 200 does not prove valid account JSON or routing identity. The observer does
not perform inference, publish a model catalog or classify pre-recognition TLS/policy
failures. Normal cleanup fences remain authoritative even when observation fails.

## OCI package proposal

`Dockerfile.supervisor` proposes the exact selected original 8df supervisor base
with only the measured ELF copied at mode 0555 over `/openshell-supervisor`.
Before a bounded canonical private Podman build, independently verify the actual
base identity and review the recipe/commands. No original tag may be overwritten.
Use a new private build context containing only this Dockerfile and the qualified
ELF, a fresh nonce tag, `--pull=never`, and a finite foreground timeout. Inspect the
resulting image ID/digest/layers/config through finite projections. Verify the exact
base layers, one replacement layer, preserved entrypoint/user/env and no RUST_LOG.
Actual Linux `--version` requires a separately reviewed, short-lived, network-none,
read-only image qualification container, with exact cleanup proof; it is not a
sandbox backend or a model operation. Adoption requires accepted Mitzo source,
CI/review, registered measured CLI/gateway version tuple and independent staging
configuration review.

The reviewed bounded package build and version qualification succeeded.
`image-qualification.json` proves the exact 29 base layer prefix and one extra
replacement layer, preserved image runtime configuration, separate config ID and
manifest digest, and no RUST_LOG override. `version-qualification.json` records
the actual version-only execution and confirmed cleanup. Active staging selection
remains unchanged.

`qualify-source.mjs ABSOLUTE_PUBLIC_SOURCE_CHECKOUT` reconstructs both reviewed
commit objects in a new temporary checkout using only an offline local fetch of
the qualified public parent. It checks both trees, commits, history depth and
final archive SHA. HOME and TMPDIR are separate from the source tree so host tool
caches cannot contaminate it. This fixture passed for the final source.
The Mitzo provenance regression checks actual patch/lock/commit bytes, all public
registry checksums, registered CLI/version/config-ID pins, the distinct manifest
digest, exact base layer prefix, replacement-only Dockerfile and sanitized receipts.
