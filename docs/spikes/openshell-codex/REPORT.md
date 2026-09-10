# OpenShell harness spike report — 2026-09-10

## Decision

**No-go for a production migration now; go for a bounded qualification.** The
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

| Component | Version / evidence | Result |
| --- | --- | --- |
| Host Codex CLI | `0.153.4` | Generated app-server schema exposes `externalSandbox`. |
| OpenShell | `0.0.116` gateway and CLI | Connected local mTLS gateway using a rootless Podman machine. |
| OpenShell base | upstream `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` | Carries Codex `0.117.0`; warmed successfully for the smoke tests. |
| Derived Codex image | local `mitzo-codex-spike:0.153.4` | Public `@openai/codex@0.153.4` installed successfully on Linux/arm64. |
| Pi coding agent | npm `@earendil-works/pi-coding-agent@0.85.1`, MIT | SDK session created with read-only tools and no auth/model call. |
| OpenCode | npm `opencode-ai@1.18.30`, MIT | Upstream-document comparison only. |

The host and base schemas were generated with the same ordinary
`codex app-server generate-json-schema` command. The host 0.153.4 schema
contains `externalSandbox`; the upstream base 0.117.0 schema scan did not.
That is an observed version-surface difference, not a claim that every older
release is unusable. The public Linux/arm64 installation and in-sandbox probe
remove the risk that 0.153.4 is only a desktop-app-bundled build.

## Execution evidence

| Acceptance item | Status | Evidence / limitation |
| --- | --- | --- |
| OpenShell topology | **Pass** | Gateway 0.0.116 ran with the rootless Podman driver and its machine socket. The earlier VM provisioning stall is not treated as an incompatibility finding. |
| OpenShell filesystem and egress boundary | **Pass** | `run-disposable.sh` emitted `POSITIVE_FILESYSTEM=pass`, `POSITIVE_NETWORK=pass`, and `NEGATIVE_NETWORK_POLICY_DENIAL=pass`. The negative control is a denied POST and requires the proxy's `policy_denied` response—not merely a failed connection. |
| Codex `externalSandbox` command execution | **Pass** | A no-secret JSONL app-server probe in the derived 0.153.4 image executed `/bin/sh` through `command/exec` with the command `sandboxPolicy` set to `externalSandbox`; it emitted `APP_SERVER_EXTERNAL_EXEC=pass`. |
| Correct protocol placement | **Pass (fixture/schema)** | `sandboxPolicy` is turn-scoped (`turn/start`) and command-scoped (`command/exec`); it is not a `thread/start` parameter. The request fixture reflects this. |
| Brokered Codex subscription turn | **Blocked safely** | A `codex --from-existing` provider was attached without mounting the host auth store. OpenShell explicitly denied raw OAuth traffic to `chatgpt.com`/`api.openai.com`: the built-in profile has no L7-injectable auth mapping, so the proxy failed closed. No model action occurred. |
| Inspected OpenAI API request | **Pass** | Direct and sandboxed `POST /v1/responses` with the same exact Keychain credential, `gpt-4.1-mini`, and request body both succeeded after importing the custom endpoint-bearing bearer profile. The legacy `openai` type had produced `invalid_api_key` because no installed profile supplied placement metadata. |
| Codex API-key app-server turn | **Blocked at WebSocket handshake auth** | With ordinary HTTP substitution proven, Codex still received upstream 401 on `wss://api.openai.com/v1/responses`; adding a documented WebSocket endpoint/rules admitted the upgrade but did not substitute its Authorization header. OpenShell supports WebSockets generally; `websocket_credential_rewrite` applies to text frames after HTTP 101, not handshake headers. No marker file was created. |
| Follow-up/cancel/restart/resume/refresh | Not tested | No authenticated live account turn was authorized. Restarting an app-server must not be confused with replacing the OpenShell sandbox. |
| GitHub read and clone | **Pass (broker/clone)** | Existing `gh` token was captured in process memory, stored in a temporary provider, and exposed only as a placeholder. Authenticated `gh api user` passed; a genuinely private repository clone passed when the placeholder was supplied through HTTPS Basic auth. The earlier Mitzo clone was public. These are filesystem clones, not Mitzo workspace registration. |
| GitHub write denial | **Pass** | A write request was explicitly `policy_denied`; no issue was created. Future controls should use only a synthetic endpoint. |
| Google Workspace read | Partial | Host `gws 0.18.1` encrypted OAuth login is healthy and a one-item Drive read passed. Sandbox brokerage is blocked by secure import: `gws auth export` yields refresh/client material, while OpenShell's refresh CLI accepts material values in process arguments. That is unsuitable for secret isolation without a stdin/handle integration. |
| Credential isolation | **Pass for static API/GitHub placeholders; broader open** | Hash-only checks proved sandbox provider variables differ from the real host tokens; host `gh` config and host Codex paths were absent. Gateway default storage uses AES-256-GCM envelopes and wrapped per-credential keys. Image-local `/sandbox/.codex` exists and still needs content classification. OAuth refresh-material and sibling-process threat tests remain. |
| External-effect approval bypass | Not tested | No real write credential or trusted-executor mock was used. |
| Two-seat Symposium contract | **Pass (design sketch only)** | `node --test symposium-seat-fixture.test.mjs` verifies independent seat bindings and message provenance in one shared workspace. It is not live Mitzo, runtime, or isolation evidence. |

## Harness comparison

| Criterion | Codex app-server | Pi coding agent | OpenCode |
| --- | --- | --- | --- |
| Integration surface | JSON-RPC app server, dynamic tools, thread lifecycle | First-class TypeScript SDK with sessions/events/custom tools | Whole coding agent with HTTP server, REST/SSE control surface |
| Built-in local tools | Shell/files; OpenShell must enforce | Read/write/edit/bash; OpenShell must enforce | Rich coding-agent tools; OpenShell must enforce |
| Subscription auth | ChatGPT login and documented external-token paths | Documents ChatGPT Plus/Pro `/login` | Documents ChatGPT Plus/Pro browser `/connect`, or API key |
| API/provider breadth | OpenAI/Codex routes | Broad model runtime; candidate for API/Vertex runner | Broad provider support |
| Mitzo-owned approvals/history/recovery | Must remain in Mitzo | Must remain in Mitzo if embedded | Must remain in Mitzo for Symposium orchestration |
| Reusable executor only | Not preferred: app-server owns a Codex thread | Possible, but leaves Mitzo owning the agent loop | No current reason to adopt solely for tools |
| Evaluation status | Outer execution and inspected HTTP auth demonstrated; subscription and API-key WebSocket agent turns blocked | Session construction demonstrated; no inference | Documentation only; no local test |

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

For the API route, the installed registry had no `openai` profile. A distinct,
workspace-scoped custom profile added the missing `OPENAI_API_KEY` bearer
placement and `api.openai.com` endpoint. With that correction, matched direct
and sandboxed HTTP Responses calls succeeded. Codex's WebSocket upgrade still
received 401 even after adding explicit `protocol: websocket` rules. This does
not mean OpenShell lacks WebSocket support: installed source and schema support
GET upgrades and `WEBSOCKET_TEXT`. It is specifically the credential placeholder
in the HTTP upgrade Authorization header that remains unresolved.

The GitHub provider followed the same secret boundary: the host `gh auth token`
was captured to a shell variable, passed to `provider create --credential
GITHUB_TOKEN` by environment-name lookup, and stored in the gateway's encrypted
credential store. The sandbox received a revisioned placeholder rather than the
real token, and no host `gh` configuration directory was mounted.

## Next qualification gate

The next engineering gate is handshake-header placeholder substitution for
Codex's Responses WebSocket, followed by real turn/follow-up/cancel/restart
tests. Independently, add a secret-handle or stdin path for GWS OAuth refresh
material before sandboxing `gws`. Mitzo multi-repository registration and a
synthetic trusted-executor denial fixture remain separate from the proven
private filesystem clone. Do not replace Mitzo's host-native executor until
those gates pass.

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
escape review. This spike did not provision a cluster.

## Sources

- [Codex app-server](https://learn.chatgpt.com/docs/app-server) — lifecycle
  and `externalSandbox` protocol.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) — subscription
  and API-key authentication/billing distinction.
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
  and [quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md).
- [OpenCode providers](https://opencode.ai/docs/providers) and
  [server documentation](https://opencode.ai/docs/server).
