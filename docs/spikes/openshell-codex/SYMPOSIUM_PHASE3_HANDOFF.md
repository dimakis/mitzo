# Symposium Phase 3 runtime checkpoints

## Current source gate (26 September 2026)

This document preserves the sequence of disposable experiments below. The current
source adds the OpenShell 0.1 per-seat runtime, durable sandbox lifecycle fences,
artifact leases, and physical host evidence. A production runtime is created only
after the trusted bootstrap installs a host capability and its attestation passes
verification. Missing or changed evidence blocks activation, admission, and
dispatch; environment settings alone are insufficient.

The initial gate allows only attested OpenAI implementer/coder seats. Claude
Vertex policy and controller fixtures remain experimental, and native reviewer
read-only enforcement is not admitted. Restoring the canary scripts does not run
them or establish live provider, IAM, gateway, or production readiness. Earlier
shared-owner and unwired-runtime statements below describe their dated checkpoint,
not the current source gate.

## Historical shared runtime checkpoint

This is a safe development checkpoint, not a production activation. No live model call, production sandbox mutation, provider creation, or provider attachment occurred. The runtime factory deliberately rejects Claude attachment until private per-seat state is enforced, and Phase 5 activation must remain fail-closed.

## Source state

- Mitzo clone: `mitzo-symposium-runtime`, branch `feat/symposium-shared-runtime`, based on `429102c9` (#598). Local commits: `8f61b6ea` provider union, `b9df0ca2` dispatch fence, `25bc952d` Codex accepted-turn callback, `78034368` exact claim and host grant fence, `d85799fb` OpenAI native seat, `bde0e42f` Claude Vertex native seat, `b30207bd` session-owned factory. Do not push before parent integration review.
- OpenShell isolated clone: `openshell-seccomp-review`, branch `fix/allow-restrictive-seccomp-stacking`, commit `42cb9b0e6a9e22caf3e8234be1384bea7a84422f`. It permits only zero-flag restrictive seccomp filter stacking while preserving the outer filter and `no_new_privs`; it rejects nonzero flags, TRACE and USER_NOTIF relaxation attempts. 24 Linux seccomp tests and `cargo fmt --check` passed. This is not deployed.
- No-model disposable canary `app-server-readonly-probe.mjs` used the pinned Codex 0.153.4 app-server with `features.use_legacy_landlock=true` under the patched filter: writes to `/sandbox` and `/tmp` were denied, read from `/etc/os-release` succeeded. The canary proves the disposable filter path only, not the deployed image/gateway.
- Focused Mitzo validation after factory work: 61 tests in the Symposium orchestrator, seat runtime and Claude native files; `npm run compile:server`, exact `npx tsc --noEmit`, and touched-file ESLint passed. Full mocked suite has not yet run for this branch.

## Implemented contracts

`createSymposiumSessionRuntime({sessionId,store,profiles,hostGrants,codexStore,resolveProviderIdentity,runtimeConfig,readOnlyEnforced,recordAccepted})` returns a session-scoped orchestrator, shared sandbox owner, and dynamically resolved seat executors. `hostGrants.verifySeat({sessionId,seat,membershipGeneration})` is required at final native dispatch; root's durable registry implementation is in separate clone `mitzo-host-grants`, commit `c32481eb451635532f7280a1cd3c445c53be196b`. The factory's `createOpenShellProviderIdentityResolver` reads fresh gateway provider name, type, ID, and workspace. The owner serializes all provider-union operations and checks admitted seat generations and host grants before and after attachment. Existing service-provider grants are rejected until a shared-scope review exists.

`SymposiumSeatExecution.claimToken` now travels from the durable recipient claim to native execution and cancellation. OpenAI uses a distinct durable Codex thread keyed by session, seat, membership generation, full binding and grants; it sends exactly the recipient's routed content, explicitly pins model/effort and the API launcher for `https://api.openai.com/v1`, and records a receipt only after `turn/start` returns the provider turn ID. Claude Vertex uses the pinned provider, `CLAUDE_CODE_USE_VERTEX=1`, `CLAUDE_CODE_SKIP_VERTEX_AUTH=1`, configured project/region/model/effort, stdin-only routed content, a generation-specific UUID, and a conservative assistant-message receipt. `system/init` is not acceptance. `getUnsettledSymposiumExecutions` and its per-seat form now expose nullable claim tokens; cancellation forwards the exact token. Unknown or legacy remote cleanup stays `recovery_required`.

Do not interpret a seat's reply or completed delivery as proof the model cognitively read the text. The receipt means the provider accepted that exact attempt. iOS projection/ledger commits `ff0c0b3` and `c60c7fd` in `mitzo-delivery-projection` add `EventStore.markSymposiumRecipientAccepted(...)`, immutable dispatched input and source lineage; merge those before wiring `recordAccepted` to the actual EventStore method. Root's nullable cost ledger commit `b73953f270a8185f94bb318c59e15b4913d01b7f` must also be merged. The native route intentionally omits unknown cost; do not turn it into zero. Budgeted native dispatch currently rejects until trusted per-attempt cost reservation exists.

## Required next work

### Disposable seat filesystem prototype (25 September 2026)

`symposium-seat-landlock.c` is an unwired Linux Landlock ABI 3+ launcher.
`symposium-seat-landlock-canary.sh` compiles it inside a disposable local
`release-387c13ed-20260911` runtime container with `--network none`. Run:

```sh
podman run --rm --network none \
  -v "$PWD/docs/spikes/openshell-codex:/src:ro" \
  --entrypoint /bin/sh \
  localhost/mitzo-mgmt-runtime:release-387c13ed-20260911 \
  /src/symposium-seat-landlock-canary.sh
```

The canary passed: private HOME and shared workspace work, while sibling HOME
reads (including symlinks), `/proc/self/environ`, `/tmp` writes, and reviewer
workspace writes fail. This is a filesystem prototype, not native admission
proof. It is not in the image launch paths or tested under the OpenShell
gateway's seccomp filter. Landlock does not prevent same-UID cross-process
memory access by itself; inspect and constrain ptrace and related syscalls
before treating credentials and persistent state as isolated. All multi-seat
native admission, including two Codex seats, remains fail-closed.

`Dockerfile.symposium-seat-probe` installs the launcher in a **disposable**
derived image. Built locally from `release-387c13ed-20260911` as
`localhost/mitzo-symposium-seat-probe:cb1b10ae-v3-20260925`, then reran the
canary against the installed binary successfully. `codex --version` under
the wrapper reported `codex-cli 0.153.4` without a model call. The native
Codex and Claude launch paths are still unwired. The patched supervisor's
source blocks ptrace, `process_vm_readv/writev`, and pidfd operations, but
the disposable gateway has not yet been built or tested with this image.

### Local transport wiring after the disposable proof

`server/symposium-attempt-transport.ts` now launches a native command through
the controller over OpenShell SSH. The child inherits stdin/stdout/stderr, so
Claude's stream JSON and routed prompt pass through without putting prompt text
on argv. The bridge hashes the durable claim to the controller's 64-hex
identity and accepts cleanup only from its exact terminal marker. SSH closure,
timeout, malformed proof, and another claim's marker remain unconfirmed. Its
cancel operation is repeatable with the known sandbox name and claim after a
host restart. `createClaudeVertexSeat` uses this bridge on the real spawn path;
the fake spawn hook remains available to test event and receipt handling.

This is source wiring only. The shared owner still rejects every Claude union
and every multi-seat union. No trusted image digest, patched supervisor,
controller binary, sibling layout, or read-only policy has been attested in
production. At this checkpoint the host did not persist a claim-to-sandbox
registry or quarantine observer loss. Do not relax the admission guards or
deploy this path until those checks and recovery are implemented.

`server/symposium-attempt-registry.ts` subsequently adds a host-owned SQLite
claim-to-sandbox map. The parent directory must be private. A claim is reserved
durably before the controller starts; a reserved or uncertain claim quarantines
the sandbox across process restarts. A failed or absent controller marker leaves
it quarantined, including observer loss. `pending()` exposes recovery work, and
`recover(claim)` retries the exact controller cancellation against the recorded
sandbox. Only a valid marker moves it to confirmed. The real Claude path now
requires this registry and the session factory passes a host-supplied instance.
No factory admission guard was relaxed. The host still needs to instantiate and
retain the registry at a trusted private path, reconcile pending rows on boot,
and attest the exact image, supervisor, layout, and reviewer policy before
Claude or multiple native seats can be admitted.

The app startup now initializes `server/symposium-native-host.ts` only when
the operator supplies `SYMPOSIUM_NATIVE_ATTEMPT_DIR` as an absolute private
host directory outside `/sandbox`. It refuses public directories, symlinks,
and public database files. Startup marks all unsettled rows uncertain locally;
it makes no gateway call. The host wrapper passes the same registry into
`createSymposiumSessionRuntime`. This clone does not yet mount a production
Symposium route or instantiate a session runtime from the app, so the wrapper
is the explicit integration point for the later merged factory. With the env
unset there is no registry and the real Claude launch refuses to run. Recovery
against a live sandbox and release of quarantine still require a separate
trusted host action and exact controller proof.

Codex now has a source-level controller adapter in `symposium-codex-native.ts`.
It uses the same claim registry to wrap the app-server's existing stdio JSON-RPC
stream, waits for the exact native turn terminal event, then closes the relay
and requires the controller's exact descendant-cleanup marker. Cancellation
requires both exact turn termination and controller proof; observer loss stays
unconfirmed and quarantined. The direct `/usr/bin/codex app-server`
argv is pinned to the reviewed OpenShell API provider configuration because
Landlock denies the old `/sandbox/run-mitzo-app-server` wrapper. Real launch
also requires a host-supplied `verifiedCodexControllerCommand` equal to this
argv and a registry. The host supplies neither by default, so admission still
fails closed. The direct argv has not been canaried in the patched image, and
image digest, binary version, workspace initialization, network/provider
routing, and native read-only behavior still need no-model verification before
the host can supply that capability. No active gateway or model was used.

### Direct Codex argv no-inference image canary

The retained v9 disposable image (`9d0e5fed2457`) was available on 25
September, but the prior private patched-supervisor gateway was stopped. A
no-network `podman run --rm` of that image found the installed Codex 0.153.4
binary at `/usr/bin/codex` (symlink target under `/usr/lib`), not the earlier
source pin `/usr/local/bin/codex`. The pin was corrected. The new
`symposium-codex-controller-canary.sh` created the intended shared workspace
inside only the disposable container, launched the exact direct API
app-server argv through the controller and Landlock read scope, sent only the
JSON-RPC `initialize`/`initialized` handshake, received response ID 1, and
obtained the matching terminal marker. It printed
`codex_controller_initialize=passed`; process exit was zero. No model turn,
provider attachment, network access, active gateway, or active sandbox was
used. Codex emitted nonfatal diagnostics about project trust and its bundled
bubblewrap fallback. This image-only proof does not repeat patched-supervisor
integration, validate thread/start or native reviewer read-only behavior, or
attest an active image. Keep the capability and multi-seat gates closed.

### Claude no-model controller/registry fixture

Focused fake-process tests now exercise `createClaudeVertexSeat` through the
real SQLite claim registry seam: routed stdin, streamed init/assistant/result
events, assistant-derived acceptance receipt, exact controller confirmation,
cancellation, observer-loss quarantine across registry reopen, and both
matching and mismatched resumed thread identities. A concrete gap was fixed:
`result.is_error=false` without an assistant event can no longer complete a
turn without an acceptance receipt. A no-network/no-provider disposable v9
image run of `symposium-claude-stream-canary.sh` forwarded fixture stream JSON
through Landlock and the controller, then proved natural terminal and exact
cancellation markers; it printed `claude_fixture_stream_and_stop=passed`.
This does not invoke Claude. Real Vertex credential routing, actual Claude
stream-json ordering and receipt semantics, `--resume` behavior, native
read-only enforcement, and patched-supervisor integration for this exact
launcher remain unproven. Claude and multi-seat admission remain closed.

### Claude CLI argv and provider-v2 routing inspection (25 September 2026)

The retained disposable v9 image was run with `podman --network none` and no
prompt, credentials, or provider attachment. Its `/usr/local/bin/claude` is
Claude Code `2.1.156`. `claude --help` confirms the parity argv flags:
`--print`, `--bare`, `--disable-slash-commands`, `--strict-mcp-config`,
`--verbose`, `--output-format stream-json`, `--include-partial-messages`
(requires print and stream JSON), `--append-system-prompt`, `--model`,
`--effort`, `--tools`, `--permission-mode` (`plan` and `acceptEdits` among
the choices), `--resume`, and `--session-id` (a valid UUID). The repeatable
no-model check is `symposium-claude-argv-help-canary.sh`. This is CLI help
compatibility, not proof of stream ordering, session resume, or provider
routing. The installed binary also contains the documented environment names
`ANTHROPIC_VERTEX_BASE_URL`, `CLAUDE_CODE_SKIP_VERTEX_AUTH`, and
`CLAUDE_CODE_USE_VERTEX`; string presence does not prove their interaction.
This runtime clone still has the pre-parity Claude argv; the
integration branch's parity argv was inspected read-only.

Do not enable the current `CLAUDE_CODE_USE_VERTEX=1` argv in this sandbox.
The installed OpenShell `google-vertex-ai` provider-v2 profile binds token
placeholders to `*-aiplatform.googleapis.com` and related endpoints. Static
`auth_style` and header placement are not yet generic: the client must emit
a placeholder token for the proxy to resolve. Its Vertex provider plugin
sets non-secret project/region aliases but neither `GCE_METADATA_HOST` nor
the `GCP_SA_ACCESS_TOKEN`/`GCP_ADC_ACCESS_TOKEN` keys consumed by the GCP
metadata emulator. Those belong to a distinct `google-cloud` provider.
Claude's Vertex mode uses ADC/metadata discovery, so attaching only the
`google-vertex-ai` provider does not establish a credential-safe direct
Claude route. The installed provider documentation explicitly warns against
`CLAUDE_CODE_USE_VERTEX=1` in a sandbox and instead documents
`ANTHROPIC_BASE_URL=https://inference.local ANTHROPIC_API_KEY=unused`.

A seat-owned loopback pass-through is a plausible design, not an admitted
route. Anthropic documents `ANTHROPIC_VERTEX_BASE_URL` for a custom Vertex
endpoint and `CLAUDE_CODE_SKIP_VERTEX_AUTH` for a gateway that supplies auth.
Such a pass-through would need to accept only the exact claimed Claude seat's
request, validate project/region/model and Vertex paths, forward to the
profile-bound `aiplatform.googleapis.com` endpoint with a provider placeholder
in the bearer header, and relay streaming responses. It would also need to
prevent every other process in the shared sandbox from using that same
placeholder or bypassing the pass-through to the profile endpoint. Providers
v2 currently injects static placeholders into the sandbox environment and
does not restrict their resolution by calling binary; the profile endpoint
boundary permits the whole Vertex host, not one project/model/seat. No
seat-specific credential or network boundary is demonstrated. An untested
local proxy would therefore be a bypassable account-routing control. The
installed CLI help and binary-symbol check cannot prove request URL shape,
header handling, or token rewrite, and no model request was allowed. Build no
prototype that could be mistaken for an admitted credential route yet.

The OpenShell development provider guide does show a native Vertex request
from a newly started sandbox process using
`Authorization: Bearer $GOOGLE_VERTEX_AI_TOKEN` (or its service-account
equivalent), with the real token substituted at the bound endpoint. The
installed `0.0.116-mitzo.2` profile and provider code contain the same token
keys and Vertex endpoints. This supports the pass-through's _upstream_ half,
but it does not establish Claude's local base-URL request shape or seat
confinement. A disposable no-provider probe cannot exercise proxy rewrite.
Two viable investigation paths are a trusted host broker that owns route and
account selection outside the shared sandbox, or separate provider-isolated
sandboxes with a deliberately shared workspace. Both require explicit
filesystem, stop, and policy proofs; neither is implemented here.

That documented route cannot simply replace the current argv for a shared
OpenAI/Vertex sandbox: `inference.local` is configured for one provider/model
pair per gateway, and attached providers do not mount their own routes.
Provider-v2 path-based multi-provider inference routing is still listed as
future work. No provider/credential change, active gateway call, or model
invocation was made. Keep Claude and multi-seat admission closed until a
separately reviewed route proves independent account/model selection and
secret-safe credential delivery in the exact image and gateway version.

Source references: [Google Vertex AI provider](https://docs.nvidia.com/openshell/providers/google-vertex-ai),
[Providers v2](https://docs.nvidia.com/openshell/sandboxes/providers-v2),
[Native Google provider guide](https://docs.nvidia.com/openshell/dev/manage/providers/google),
[Inference Routing](https://docs.nvidia.com/openshell/sandboxes/inference-routing),
[Claude Vertex setup](https://code.claude.com/docs/en/google-vertex-ai), and
[Claude environment variables](https://code.claude.com/docs/en/env-vars).

1. **Per-seat filesystem privacy:** the disposable runtime image has `HOME=/sandbox`. Claude session persistence would put a target-only aside under shared `/sandbox/.claude`; another seat could read it with native tools. The factory therefore rejects every `anthropic-vertex` union before attachment, including write seats. Build and verify a narrow per-seat OS Landlock wrapper that gives each process a private HOME/TMPDIR, denies other seats' private state, allows only the approved shared workspace, and enforces reviewer read-only. Keep the outer OpenShell filter and `no_new_privs`; use disposable no-inference read/write/cross-seat escape canaries. Only lift the fail-closed guard after proof. Codex may also persist native state under shared `/sandbox`, so inspect and isolate it too. A prompt or CLI permission mode is insufficient.
2. **Exact stop proof:** Claude's host SSH `SIGTERM` does not prove the remote process stopped. Persist a per-attempt remote process identity and obtain a terminal/absence acknowledgment before `cancel` resolves. Normal Stop/Remove must not kill other seats. Unknown remains reserved for recovery, and retries must target the original attempt. Codex interruption likewise must wait for the matching terminal turn event; inspect transport-loss races.
3. **Provider setup and policy:** gateway inventory currently has OpenAI providers but no `google-vertex-ai` provider. Use the _configured Work Vertex profile's exact_ `credentialRef`, project and region; never silently use default gcloud ADC. The inspected CLI supports `openshell provider create --name <pinned-name> --type google-vertex-ai --credential GOOGLE_SERVICE_ACCOUNT_KEY` for an exact service-account JSON supplied via a host-only environment variable, or `--from-gcloud-adc` only after staging and verifying the exact configured ADC file in an isolated HOME. Confirm the credential file type and principal/project match the selected profile before preparing either command. This creates a new workspace provider but does not attach it to any sandbox. Its returned name/type/ID/workspace must be pinned into the account profile revision before admission. The current OpenAI-only policy allows `api.openai.com`; a future reviewed policy must preserve that route and prove a per-seat Vertex credential boundary before adding `*-aiplatform.googleapis.com`. Adding a direct Claude endpoint allow rule alone cannot establish that boundary. Do not mutate an active sandbox or production policy during setup.
4. **Host wiring:** merge the host grant registry, receipt ledger, cost ledger and current main; wire the Phase 5 activation callback to the factory using authenticated host-owned references. No client-minted grant can make a draft active. Reconcile physical providers before marking membership `confirmed`. Test concurrent add/remove, revocation between claim and provider dispatch, late acceptance/output, distinct account/model routing, and restarts using fakes. Run the one-worker full mocked suite after coordinating the shared test runner. Production rollout and live model canaries require separate approval; if a live test is later authorized, announce the exact supported Luna model and charged account first.
