# OpenShell harness spike report — 2026-09-10

## Decision

**No-go for a production migration now; go for a local development integration.** The
outer OpenShell boundary works on the local rootless Podman/arm64 path, and a
current Codex app-server can execute with `externalSandbox` inside it. This is
not evidence that live account credentials, recovery, Mitzo integrations, or
multi-repository workflows are ready. Mitzo remains the authority for the
conversation, Symposium scheduler, grants, approvals, provenance, durable
queue, and trusted external-action executor.

Do not select a universal harness yet. Codex is the most direct candidate for
ChatGPT seats; Pi is an embedded SDK candidate for a future API/Vertex route;
OpenCode documents both a server interface and ChatGPT browser authorization,
but was not run in this spike. The Pi local smoke test proves construction of
an embedded session only—not a competitive runtime result.

## Exact inventory

| Component           | Version / evidence                                                  | Result                                                                |
| ------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Host Codex CLI      | `0.153.4`                                                           | Generated app-server schema exposes `externalSandbox`.                |
| OpenShell           | `0.0.116` gateway and CLI                                           | Connected local mTLS gateway using a rootless Podman machine.         |
| OpenShell base      | upstream `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` | Carries Codex `0.117.0`; warmed successfully for the smoke tests.     |
| Derived Codex image | local `mitzo-codex-spike:0.153.4`                                   | Public `@openai/codex@0.153.4` installed successfully on Linux/arm64. |
| Pi coding agent     | npm `@earendil-works/pi-coding-agent@0.85.1`, MIT                   | SDK session created with read-only tools and no auth/model call.      |
| OpenCode            | npm `opencode-ai@1.18.30`, MIT                                      | Upstream-document comparison only.                                    |

The host and base schemas were generated with the same ordinary
`codex app-server generate-json-schema` command. The host 0.153.4 schema
contains `externalSandbox`; the upstream base 0.117.0 schema scan did not.
That is an observed version-surface difference, not a claim that every older
release is unusable. The public Linux/arm64 installation and in-sandbox probe
remove the risk that 0.153.4 is only a desktop-app-bundled build.

## Execution evidence

| Acceptance item                           | Status                                                    | Evidence / limitation                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenShell topology                        | **Pass**                                                  | Gateway 0.0.116 ran with the rootless Podman driver and its machine socket. The earlier VM provisioning stall is not treated as an incompatibility finding.                                                                                                                                                                                                                                                                                                                       |
| OpenShell filesystem and egress boundary  | **Pass**                                                  | `run-disposable.sh` emitted `POSITIVE_FILESYSTEM=pass`, `POSITIVE_NETWORK=pass`, and `NEGATIVE_NETWORK_POLICY_DENIAL=pass`. The negative control is a denied POST and requires the proxy's `policy_denied` response—not merely a failed connection.                                                                                                                                                                                                                               |
| Codex `externalSandbox` command execution | **Pass**                                                  | A no-secret JSONL app-server probe in the derived 0.153.4 image executed `/bin/sh` through `command/exec` with the command `sandboxPolicy` set to `externalSandbox`; it emitted `APP_SERVER_EXTERNAL_EXEC=pass`.                                                                                                                                                                                                                                                                  |
| Correct protocol placement                | **Pass (fixture/schema)**                                 | `sandboxPolicy` is turn-scoped (`turn/start`) and command-scoped (`command/exec`); it is not a `thread/start` parameter. The request fixture reflects this.                                                                                                                                                                                                                                                                                                                       |
| Brokered Codex subscription turn          | **Blocked safely**                                        | A `codex --from-existing` provider was attached without mounting the host auth store. OpenShell explicitly denied raw OAuth traffic to `chatgpt.com`/`api.openai.com`: the built-in profile has no L7-injectable auth mapping, so the proxy failed closed. No model action occurred.                                                                                                                                                                                              |
| Inspected OpenAI API request              | **Pass**                                                  | Direct and sandboxed `POST /v1/responses` with the same exact Keychain credential, `gpt-4.1-mini`, and request body both succeeded after importing the custom endpoint-bearing bearer profile. The legacy `openai` type had produced `invalid_api_key` because no installed profile supplied placement metadata.                                                                                                                                                                  |
| Codex API-key app-server turn             | **Pass through custom HTTPS provider**                    | The built-in provider still received 401 at its WebSocket handshake, but a custom Codex `responses` provider for `https://api.openai.com/v1` used inspected HTTPS. A real model turn ran shell inside OpenShell and created the required marker.                                                                                                                                                                                                                                  |
| Mitzo app-server transport                | **Pass (development seam)**                               | The browser-default SSE+HTTP route completed a real `gpt-5.3-codex` turn with nine ContexGin sources, emitted visible `Bash` start/result events, and created `normal-sse-marker.txt` in the retained sandbox. The blocking defect was an explicit empty `environments` array on `thread/start` and `turn/start`, which disables Codex built-ins; omitting it restores tool use. Built-in `commandExecution` items are now mapped into Mitzo's existing tool event contract. |
| Follow-up/cancel/restart/resume/refresh   | **Pass for stop/resume; broader partial**                 | Stop interrupted a 30-second shell command before its marker was created. Resuming the same application session after explicit queue acknowledgement emitted another visible `Bash` call and created `RESUME=pass` in the same retained sandbox. Sandbox recreation and durable restore into a different sandbox remain unproven; conversation SQLite alone cannot restore uncommitted sandbox files. |
| GitHub read and clone                     | **Pass (broker/clone)**                                   | Existing `gh` token was captured in process memory, stored in a temporary provider, and exposed only as a placeholder. Authenticated `gh api user` passed; a genuinely private repository clone passed when the placeholder was supplied through HTTPS Basic auth. The earlier Mitzo clone was public. These are filesystem clones, not Mitzo workspace registration.                                                                                                             |
| GitHub write denial                       | **Pass**                                                  | A write request was explicitly `policy_denied`; no issue was created. Future controls should use only a synthetic endpoint.                                                                                                                                                                                                                                                                                                                                                       |
| Google Workspace read                     | **Blocked on OAuth reauthentication**                     | Host `gws 0.18.1` remains healthy. The warm image now pins the same CLI and a disposable sandbox verified `/usr/bin/gws` at 0.18.1, but `gws auth status` reports no sandbox credentials. The existing OpenShell GWS profile has zero credential keys and does not materialize the CLI auth files; earlier securely imported refresh material returned `invalid_grant`. A fresh Google login/export is required before a real sandbox Drive read can pass. No Workspace write was attempted. |
| MGMT seed and repository workflow         | **Partial**                                               | A reviewed seed reduced 13 GB to ~28 MB while preserving sampled modifications/deletions and excluding runtime/auth stores. Warm sandbox submission was ~0.69 s, seed preparation ~2.10 s, and upload ~0.39 s on this Mac. A Mitzo-driven sandbox agent created and committed a proof file. Disposable dependency resolution added `litellm`, but the next bounded MGMT check exposed another undeclared dependency, `anthropic`; parity is incomplete.                           |
| Credential isolation                      | **Pass for static API/GitHub placeholders; broader open** | Hash-only checks proved sandbox provider variables differ from the real host tokens; host `gh` config and host Codex paths were absent. Gateway default storage uses AES-256-GCM envelopes and wrapped per-credential keys. Image-local `/sandbox/.codex` exists and still needs content classification. OAuth refresh-material and sibling-process threat tests remain.                                                                                                          |
| External-effect approval bypass           | Not tested                                                | No real write credential or trusted-executor mock was used.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Two-seat Symposium contract               | **Pass (design sketch only)**                             | `node --test symposium-seat-fixture.test.mjs` verifies independent seat bindings and message provenance in one shared workspace. It is not live Mitzo, runtime, or isolation evidence.                                                                                                                                                                                                                                                                                            |

## Harness comparison

| Criterion                              | Codex app-server                                                                                             | Pi coding agent                                              | OpenCode                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Integration surface                    | JSON-RPC app server, dynamic tools, thread lifecycle                                                         | First-class TypeScript SDK with sessions/events/custom tools | Whole coding agent with HTTP server, REST/SSE control surface |
| Built-in local tools                   | Shell/files; OpenShell must enforce                                                                          | Read/write/edit/bash; OpenShell must enforce                 | Rich coding-agent tools; OpenShell must enforce               |
| Subscription auth                      | ChatGPT login and documented external-token paths                                                            | Documents ChatGPT Plus/Pro `/login`                          | Documents ChatGPT Plus/Pro browser `/connect`, or API key     |
| API/provider breadth                   | OpenAI/Codex routes                                                                                          | Broad model runtime; candidate for API/Vertex runner         | Broad provider support                                        |
| Mitzo-owned approvals/history/recovery | Must remain in Mitzo                                                                                         | Must remain in Mitzo if embedded                             | Must remain in Mitzo for Symposium orchestration              |
| Reusable executor only                 | Not preferred: app-server owns a Codex thread                                                                | Possible, but leaves Mitzo owning the agent loop             | No current reason to adopt solely for tools                   |
| Evaluation status                      | Outer execution and inspected HTTP auth demonstrated; subscription and API-key WebSocket agent turns blocked | Session construction demonstrated; no inference              | Documentation only; no local test                             |

## Symposium topology

The default is **one OpenShell sandbox per active Mitzo task/Symposium**.
Collaborating seats intentionally share task files. That sandbox—not prompts or
roles—is the filesystem trust boundary.

```
authoritative Mitzo conversation
  ├─ builder seat: profile + account + model + granted prompt package
  └─ reviewer seat: profile + account + model + different granted package
       └─ shared OpenShell task sandbox / explicit shared artifacts
```

Mitzo must keep per-seat runtime histories, cancellation/continuation,
recipient/provider routing checks, and original/edited/delivered provenance.
Separate seat sandboxes are a future option only if filesystem trust domains
must diverge.

## Security conclusions

1. `externalSandbox` delegates local-command safety to OpenShell; it is not
   sandboxing by itself and must never be enabled directly on the Mitzo host.
2. A credential proxy can authorize a limited API request, but cannot turn a
   ChatGPT subscription entitlement into generic API access or safely cover
   arbitrary CLI/OAuth flows.
3. Human approvals remain outside the sandbox. The sandbox may propose work;
   a trusted executor validates the exact approved action and owns write
   credentials.

## Provider findings

OpenShell's built-in Codex profile discovers OAuth access, refresh, account,
and optional ID tokens, but its credential fields have no `auth_style` or
header mapping. The gateway therefore refuses its raw TLS connection when
inspection is mandatory. OpenShell's own supported-agent documentation instead
describes Codex as requiring `OPENAI_API_KEY`. This is an upstream integration
gap for the ChatGPT-subscription route: adding a broad tunnel is not an
acceptable fix. The smallest safe resolution is an OpenShell provider/profile
that can inject/refresh Codex OAuth in an inspectable supported transport, or
a separate trusted host-side Codex token service with a narrow protocol.

The installed Codex 0.153.4 app-server schema exposes managed browser/device
login, but that mode persists real login and refresh material in the runtime's
`CODEX_HOME`. Its alternative `chatgptAuthTokens` request keeps tokens in memory
and delegates refresh to the host, but the generated protocol marks it
`UNSTABLE` and `FOR OPENAI INTERNAL USE ONLY - DO NOT USE`. A custom OpenShell
profile could inject Authorization and ChatGPT account headers at the proxy,
but the supported Codex runtime still requires a valid local ChatGPT identity
for account verification, model discovery, and refresh; an opaque proxy
placeholder is not a supported login input. Mitzo therefore fails closed when
a subscription profile is selected while its runtime is configured inside
OpenShell, instead of silently routing the turn through the work API provider.

For the API route, the installed registry had no `openai` profile. A distinct,
workspace-scoped custom profile added the missing `OPENAI_API_KEY` bearer
placement and `api.openai.com` endpoint. With that correction, matched direct
and sandboxed HTTP Responses calls succeeded. Codex's built-in provider
WebSocket upgrade still received 401 even after adding explicit
`protocol: websocket` rules. This does not mean OpenShell lacks WebSocket
support. The working route is instead a custom Codex Responses provider over
inspected HTTPS; its live model/tool turn passed.

The GitHub provider followed the same secret boundary: the host `gh auth token`
was captured to a shell variable, passed to `provider create --credential
GITHUB_TOKEN` by environment-name lookup, and stored in the gateway's encrypted
credential store. The sandbox received a revisioned placeholder rather than the
real token, and no host `gh` configuration directory was mounted.

After explicit approval, policy version 2 added inspected read-only
`api.github.com` access for `/usr/bin/gh`, `git`, and `curl`. A real
Mitzo-transported agent turn ran `gh api user` without recording the identity,
then created and committed `github-chat-proof.txt`; verification emitted
`MITZO_GITHUB_CHAT=pass`. GitHub write access remains absent.

## Development-server safety incident

The first normal-server launch used a disposable `REPO_PATH`, but the copied
MGMT `.mitzo.json` retained absolute host repository paths. Startup stale-
worktree cleanup followed those paths before any chat was sent. Logs report
seven MGMT worktrees removed and one Mitzo worktree auto-rescued.
Cross-repository GitHub inventory confirmed that the cleanup created eight open
draft rescue PRs: `dimakis/mgmt#291` through `#297`, plus `dimakis/mitzo#483`.
Those drafts preserve the corresponding session branches; none were closed,
merged, deleted, or restored. The server was stopped immediately. A guarded
development relaunch now requires `MITZO_DISABLE_REPO_MAINTENANCE=1` and
`MITZO_REPO_PATH_CEILING` set to the disposable root. The former disables
startup reconciliation and stale-worktree cleanup outside production; the
latter rejects configured repositories whose canonical paths escape the
ceiling.

The first guarded acceptance fixture exposed a second seed defect before
launch: BSD tar ignored exclusions placed after `-x`, so the supposedly
sanitized tree still contained `.mitzo.json`. The seed script now places all
exclusions before extraction, explicitly excludes `.mitzo.json`, and fails
closed if protected roots survive. A regenerated seed contained 2,317 files
(27,553,792 bytes), no `.mitzo` directory, and no `.mitzo.json`; the host and
sandbox Git repositories matched at commit
`9a3ce221c29e81542419676a2e3d97d237c8f9a5`.

## ContexGin session boundary

ContexGin remains part of MGMT parity. Mitzo already fetches
`/api/agents/:name/context`, sends provenance to the UI, and appends the
compiled Markdown to the system prompt before opening the agent turn. The live
daemon is healthy on its documented port 4195, but the current Mitzo defaults
still point at stale port 8321. More importantly, daemon compilation observes
the host checkout rather than the exact seeded task state.

The target is a session-start hook that compiles context against the sandbox's
seeded MGMT workspace and injects that payload into the same task. Shared
indexing and goal services may remain outside the sandbox. Compiled content is
context, not an authority grant: filesystem, network, credential, and approval
policy remain independently enforced. If session-scoped compilation is
unavailable, Mitzo must expose that fallback rather than silently presenting
host-derived context as sandbox-derived context.

## Local task lifecycle and recovery

The target is one retained sandbox per Mitzo task/Symposium. A warmed,
local-only image contains Linux-compatible agent and MGMT dependencies, while a
fresh writable workspace is seeded from `/Users/dsaridak/redhat/mgmt`.
Credentials arrive only through attached gateway providers. The source checkout
is never mounted writable or modified.

The seed records the starting commit and file hashes in a host-side baseline.
Future nontechnical save-back also requires externally durable change
checkpoints, attachments, repo registrations, account bindings, and runtime
continuation metadata. Mitzo must compare current host state to that baseline
before applying an exact reviewed change set. Workspace Markdown/front matter
is ordinary content and cannot alter grants or approval policy. Destroy/recreate
recovery and native agent-thread resume are not yet tested.

The raw 13 GB is dominated by accumulated `.claude/worktrees` (~4.9 GB),
`.mitzo` (~1.9 GB), two macOS virtualenvs (~2.8 GB), and a 1.6 GB refresh log.
Those are not per-task seed content. The reviewed seed is ~28 MB, but full MGMT
parity is not established: `.agents` skills are included, while executable
`.codex`/`.claude` hooks require explicit trust review before inclusion.

## Next qualification gate

Complete guarded normal Mitzo chat qualification with a sandbox-path binding
distinct from host cwd. Validate the disposable resolved MGMT runtime image
with representative commands, and keep the source lock divergence visible
rather than rewriting host MGMT. Add durable workspace checkpoints before
expiry/recreation tests. The retained development sandbox has inspected,
read-only GitHub API access for `gh`, `git`, and `curl`; its real
Mitzo-transported GitHub marker passed. GWS still needs a fresh refresh token.
Add session-start ContexGin compilation against the seeded sandbox workspace;
the current host-daemon call is not exact-state parity. Vertex support is an
accepted dependency based on existing colleague validation, not locally
re-proven by this spike; Vertex/Anthropic end-to-end work is deferred.

## Guarded normal-chat checkpoint

The browser-default SSE + HTTP path reached a real `gpt-5.3-codex` turn through
the inspected OpenAI provider. It delivered `welcome`, reconnect, worktree,
session, ContexGin boot-context, message, token, and session-end events; SSE
connection-to-send readiness was 7 ms in that single local observation. This
is lifecycle evidence, not tool-loop acceptance: the model replied `done`
without a tool event or the requested marker, so the result correctly remains
a failure.

Two adapter defects found by this run now have focused coverage: per-turn
verification incorrectly fell back to ChatGPT account inspection instead of
the injected API binding verifier, and the OpenShell prompt advertised
unavailable host tools. A direct control using the same sandbox, credential,
transport, and `gpt-5.3-codex` created and verified
`direct-codex-marker.txt`, proving the underlying persistent tool loop works.
The normal prompt also exposed host worktree paths that do not exist in the
sandbox; it now emits only the sandbox workspace path. The next full-context
SSE rerun requires explicit authorization because assembled MGMT context can
contain personal and organizational material sent to the configured OpenAI API.

No tool-call transport latency is claimed yet: the failed normal turns emitted
no tool event. The successful direct control's whole-turn duration includes
inference and is not a transport-latency measurement. Stop/resume remains to be
verified after the first marker-producing SSE turn.

## Kubernetes integration target

The Podman results prove local Linux/arm64 compatibility only—not Kubernetes
deployment or pod-escape resistance. OpenShell's Kubernetes driver runs the
gateway as a cluster service and creates Agent Sandbox CR-backed pods in a
configured namespace; sandbox supervisors initiate authenticated callbacks.
The Helm chart separates gateway and sandbox ServiceAccounts, while the gateway
receives sandbox-lifecycle RBAC plus node-read and TokenReview permissions.

The first development integration should keep Mitzo's trusted server/UI and
credential/policy administration outside the agent namespace. Agent pods must
receive no Mitzo administrative socket, gateway user credential, hostPath, or
shared writable volume containing Mitzo state. Separate pods/namespaces still
share a kernel; use the validated Kata `RuntimeClass` option when the threat
model calls for a VM-strengthened boundary.

Start with OpenShell's default `combined` topology for parity with its complete
network/filesystem/process enforcement, and explicitly review the elevated
capabilities it requires. Sidecar topology lowers agent-container privilege and
keeps gateway credentials in the network sidecar, but uses a shared process
namespace and relaxes parts of the combined process model. Minimum Kubernetes
acceptance covers CR lifecycle, RBAC and ServiceAccount scope, projected-token
absence from the agent, denial of gateway/Mitzo administrative reachability,
placeholder isolation, storage scope, pod restart/resume, and node/runtime
escape review. Kubernetes/Kata work is now deferred. A kind base cluster named
`mitzo-openshell` was created with a separate kubeconfig before the deferral
arrived; no OpenShell or Mitzo workload was installed into it.

## Sources

- [Codex app-server](https://learn.chatgpt.com/docs/app-server) — lifecycle
  and `externalSandbox` protocol.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) — subscription
  and API-key authentication/billing distinction.
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
  and [quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md).
- [OpenCode providers](https://opencode.ai/docs/providers) and
  [server documentation](https://opencode.ai/docs/server).
