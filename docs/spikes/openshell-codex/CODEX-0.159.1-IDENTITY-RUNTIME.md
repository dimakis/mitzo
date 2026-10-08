# Codex 0.159.1 private account identity successor

The retained opaque-only bootstrap writes an OpenShell account handle into
`tokens.account_id`. Native workspace discovery compares this value with actual
account IDs returned by the backend. Exact 0.156.1 and 0.159.1 offline probes
showed that this cannot establish a matching workspace identity. Stage 23 failed
at `account/read` before `model/list`; its bootstrap catalog is not authenticated
model availability evidence. The precise live network failure was not retained.

This successor passes the verified **non-secret account routing ID** from the
existing host OAuth receipt to the private seat bootstrap. This explicitly
discloses that ID inside the seat's private auth file. Access tokens remain opaque,
refresh tokens stay in the gateway, and gateway credential classification is
unchanged. No response rewriting or upstream gateway extension is introduced.
The host receipt, selected provider, custody, seat membership and immutable claim
remain the authority. Native routing metadata complements these checks.

## Private protocol and authority

Only the separately measured image below consumes a `stdin-v1` preface. Legacy
images, helpers and bootstrap bytes remain admitted for their retained resources;
the host never sends this preface to an opaque-only image.

The host installs RPC/error readers before writing one bounded ASCII JSON line:
`{"version":1,"claim":"<64 lowercase hex>","accountId":"<verified routing ID>"}`.
The identity comes from the independently verified OAuth ID token retained by the
existing provisioner, with a capability that rejects replacement authorization,
provider/selection drift or custody loss. Execution also rechecks the active seat
proof. The account ID never enters public account profiles, EventStore bindings,
HTTP responses or error messages through this new capability.

The bootstrap requires the claim to equal its private HOME suffix. It accepts at
most 512 bytes including newline, rejects duplicate/extra fields, unsafe account
IDs, EOF and an absolute ten-second deadline. Unbuffered one-byte reads preserve
the next native initialization frame. It still requires an opaque account handle
and stable opaque access handle, traverses private directories without symlinks,
atomically writes a single-link owner-only 0600 auth file in a 0700 directory,
filters child environment, forces native URLs and replaces itself with Codex.

Both execution and discovery require
`account/read.workspaceRouting.chatgptAccountId` to match the current receipt
before `model/list`. Model/effort validation and subsequent host dispatch checks
remain mandatory. Failed preface/initialization uses the exact retained controller
claim for cleanup; unconfirmed cleanup retains recovery semantics. No inference
request is available through the discovery client.

Catalog freshness is independent from authorization revision: a failed refresh
marks the existing catalog stale while preserving its models and authorized
binding. Successful discovery publishes a new catalog/revision. Confirmed failure
returns HTTP 422; uncertain cleanup returns 409, with distinct UI messages.

## Measured immutable image

- Base image: `sha256:8d228fc4836797a00e09b48166cbeb35e0847aba76b5ef9ff796e0d1c9ae081a`.
- Successor image: `sha256:3c40c75d441addde40441c89479e6b982735bba16ef7493a552c8450557a632c`.
- Manifest: `sha256:3e2c2338debf745e6f20dbbd6663e19b0243434e309471fb3b698a02a3dab856`.
- Bootstrap SHA256: `9bb569cf68df23e8f98c6a2dc2e915f49aa1ddf86a5914539434222907a7cbda`.
- OCI user: `sandbox`; canonical native files root-owned regular 0755.
- Codex remains `0.159.1`; binary, code-mode helper, Landlock and controller hashes
  are unchanged from the measured predecessor.

Build with `Dockerfile.codex-0.159.1-identity-measure`, `--pull=never` and
`--network=none`. Admission checks the complete selected image/artifact mapping
and the original sealing/export helper. Mixing the new bootstrap with a legacy
image, or the old bootstrap with this successor, is rejected.

## Offline evidence and limits

Nine Python bootstrap cases and composed host tests cover malformed framing,
timeouts/slow input, permissions/symlinks/hardlinks, revoked receipts, exact claim
ordering, mismatched native routing, transport failures and cleanup uncertainty.

`codex-0.159.1-identity-no-inference-canary.py` ran in a disposable network-disabled
container without host mounts or real credentials. It verified measured hashes,
real controller/Landlock bootstrap initialization, preserved native stdin, private
auth permissions, and exact native `account/read` routing against synthetic
loopback metadata. The imported test launcher alone uses a loopback URL override;
the measured launcher still forces official URLs. Bundled `model/list` exposes
`gpt-6-luna` and `gpt-6.1-sol` with low reasoning. The fixture sends no turn request,
retains its container ID, and confirms that exact container is absent afterward.

Controls against the actual retained supervisor image
`sha256:8df2e97c2b25b75031b4c00cb49e4cd487ba2384ebe7d884a0aa12095be20937`, executable
SHA256 `289fae8ee6399713e07db192331a2393391cb0b53808a256cde3fa0aa6fba34d`, verified
literal synthetic account-header forwarding and HTTP 500 refusal of an unresolved
opaque bearer before upstream contact. The standalone proxy cannot accept the
credential bundle needed for successful endpoint-bound substitution. That path
was not newly proved by this control; it is unchanged and requires composed
gateway validation. Source inspection alone is not executable provenance.

This is runtime compatibility evidence, not fresh account entitlement, successful
live inference, integrated acceptance or production readiness. A successor stage
requires exact-head CI and Centaur LGTM, a fresh independently custodied login,
and successful owned catalog discovery. Model-backed tests must explicitly use
supported Luna and announce the exact charged account/model first. Migration,
rollback and merge/cutover remain closed pending their separate gates and intent.

## Failed live discovery and bounded diagnostics

Stage 24 completed fresh Personal Pro authorization but its one owned metadata
refresh failed at `account/read` before `model/list`. HTTP 422 is the application
failure receipt, not an observed upstream status. The catalog remains stale; this
does not establish Luna availability. Cleanup completed and no inference ran.
The retained diagnostic lacked a native failure category, so elapsed time alone
cannot distinguish a routing error, an RPC timeout or a receipt mismatch.

The successor host retains optional fixed `nativeFailure` categories and a
bounded signed 32-bit `rpcCode`. Native routing messages are classified in memory
only for `account/read`; other RPC methods preserve their existing execution
error classification. Typed local transport, account metadata and routing
identity errors distinguish the remaining host failures. Generic error text is
never inspected or retained. Provider messages, account identifiers, headers and
response bodies are excluded from the diagnostic receipt. Legacy receipts still
validate, and allocation, cleanup, account and admission guards are unchanged.

Synthetic RPC-frame tests verify persisted categories, secret exclusion, refusal
before `model/list`, and exact cleanup. This adds observability; it does not claim
to repair the unproven live cause or justify replaying the retained refresh.
