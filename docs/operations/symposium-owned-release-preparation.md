# Fresh owned-custodian release preparation

The ordinary `scripts/start.sh`, `scripts/deploy.sh`, production stack lock and existing
launchd service remain unchanged. `scripts/prepare-owned-custodian-release.mjs` is a
separate, explicit preparation path for a **fresh** owned custodian. It does not
install a service, replace production, migrate databases, authenticate providers,
run model requests or prove admission. Existing production migration remains gated.

Build the reviewed detached release with `npm run build:server` and `npm run build`.
Apply the existing release/source review and CI checks before preparation. Supply
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
adopt an old gateway. Preparation does not fetch a release or independently prove
that compiled bytes came from reviewed source; retain the separate build/review
receipt. It fingerprints the compiled server, frontend, workspace packages and
scripts so later changes prevent launch.

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
`launchctl` command is executed. Review app listener/authentication settings before
any separately authorized manual start; startup can authenticate the explicitly
selected provider references.

The plist selects `scripts/start-owned-custodian.mjs`, which requires a Node runtime
with `process.execve` (Node22.15+ on supported Unix hosts). It verifies the plan,
exclusively writes and fsyncs `launch.intent` and its private parent directory,
rechecks configuration/build immediately before exec, then replaces itself with
`dist/symposium-custodian-main.js`. The parent PID remains the owner. An existing
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
