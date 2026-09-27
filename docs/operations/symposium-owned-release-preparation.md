# Fresh owned-custodian release preparation

The ordinary `scripts/start.sh`, `scripts/deploy.sh`, production stack lock and existing
launchd service remain unchanged. `scripts/prepare-owned-custodian-release.mjs` is a
separate, explicit preparation path for a **fresh** owned custodian. It does not
install a service, replace production, migrate databases, authenticate providers,
run model requests or prove admission. Existing production migration remains gated.

Build the reviewed detached release with `npm run build:server` and `npm run build`.
Apply the existing release/source review and CI checks before preparation. Fetch current main separately; preparation and startup reuse `assert-deployable.sh --offline` to require a clean detached published checkout and exact source/tree/base-main release manifest without network access. The default deployment guard still fetches. Supply
an absolute private owned-host JSON configuration, a new empty private repository
directory, and a separate private preparation directory:

```sh
node scripts/prepare-owned-custodian-release.mjs --owned-custodian \
  /absolute/private/owned-host.json /absolute/private/new-repository \
  /absolute/private/preparation
```

All three paths must refer to the intended fresh environment. The repository and
gateway state parent must be empty. Any existing repository content, artifact
mapping or admission attestation is refused. This deliberately does not reinterpret
legacy `owner_kind=NULL` rows, clear import/cleanup claims, reuse old providers, or
adopt an old gateway. Preparation does not fetch refs or independently prove that compiled bytes came from source; retain the separate build/review receipt. It fingerprints the compiled server, frontend, workspace packages and
scripts so later changes prevent launch. Actual Node ESM resolution must map every supported `@mitzo` package/subpath to this release’s built outputs, never another checkout.

Static validation uses the same strict configuration schemas as bootstrap, without
importing bootstrap or authentication owners. It derives the complete expected
runtime tuple from `symposium-owned-runtime-contract.ts`, checks actual CLI/gateway
file digests, configured workload/runtime/supervisor image identities, profile and
policy bytes, and seed contents. Credential references and private TLS/JWT/ADC
files receive metadata checks only: contents are not resolved or copied. Work
Vertex requires the Claude variant and the reviewed endpointless provider profile.
Image/native hashes in the output are reviewed expectations, not a physical image
probe. Runtime admission still requires actual image/native evidence, fresh provider
readiness and per-seat installed-policy receipts.

The preparation writes exclusive mode0600 files: `owned-release.json`, an empty
ordinary account catalog, and `com.mitzo.owned-custodian.plist`. A partial preparation
failure is reported, never silently overwritten. The plist has its own label,
`RunAtLoad=false`, `KeepAlive=false` and `ExitTimeOut=180`. No installation or
`launchctl` command is executed. The plist intentionally contains no authentication secrets. A separately reviewed
secure launcher transport must supply explicit AUTH_PASSPHRASE (at least32 characters),
AUTH_SECRET (at least64 characters), a numeric PORT1024–65535 and loopback
MITZO_BIND_HOST before a manual start can succeed. This preparation does not install
that transport or make the plist independently deployable. Missing settings fail
before the durable launch marker. Startup can authenticate the explicitly selected
provider references.

The plist selects `scripts/start-owned-custodian.mjs`, which requires a Node runtime
with `process.execve` (Node22.15+ on supported Unix hosts). It verifies the plan,
exclusively writes and fsyncs `launch.intent` and its private parent directory,
rechecks configuration/build immediately before exec, then replaces itself with
`dist/symposium-custodian-main.js`. The parent PID remains the owner. All release `.env*` files and `certs` directories
are refused before launch; this fresh preparation is loopback HTTP only. The plist
clears NODE_OPTIONS/NODE_PATH and fixes DOTENV_CONFIG_PATH to `/dev/null` before
Node starts. Direct invocations must use a trusted Node bootstrap; the script also
refuses nonempty loader options and arbitrary dotenv paths before claiming. It
passes only explicit auth/listener values and fixed runtime settings to the parent,
never inherited proxies, provider credentials or arbitrary environment variables. An existing
intent, including a dangling symlink, prevents another launch. The intent is never
automatically removed, including after clean shutdown or failure before exec.
Deleting it is not a supported retry/recovery procedure.

This fresh-only mode fixes repository/private Codex paths and private HOME/XDG paths
from the reviewed plan, disables ordinary OpenShell execution, and selects the
empty ordinary catalog. It is not a migration of existing ordinary conversations.
The default ordinary launcher retains its existing behavior. The custodian owns
app-child replacement and rotates child auth; launchd must not restart the parent
automatically and claim recovered custody. Parent death, uncertain shutdown and
relaunch remain explicit unsupported recovery boundaries. The180-second launchd
exit allowance exceeds the current120-second drain; timeout still means uncertainty,
not successful cleanup.

Offline tests cover actual static filesystem checks, mixed/missing tuple and config,
disabled legacy-switch bypass attempts, changed build/script bytes, existing state,
private/symlink metadata, exclusive repeat-launch refusal, and actual fixed entry
selection with a synthetic compiled entry. Those tests do not launch a gateway or
prove live production migration, image installation, model acceptance or database
rollback. Preserve originals and durable uncertainty; an old binary or database
snapshot must not erase newer fences. Publication fresh-login reconciliation and
native hard-budget/final-usage authority remain separate unresolved contracts.

Preparation rejects dangling attestation entries and overlapping preparation,
repository, gateway-state, or app-home paths. These mutable directories must be
pairwise separate (no equality or ancestor/descendant relationship). The seed must be separate from configured
private references and mutable runtime directories; a shared ancestor directory
is allowed. The verifier accepts canonical root-owned public CA and Podman
executable files with no group/other write permission. Private metadata still
requires the current owner and private permissions. Every launch boundary also
rechecks the exact empty ordinary-account catalog. Known configured private file
identities are rejected before hashing any policy/profile/executable input or
seed/build-tree file, including symlink and hard-link aliases.
