# OpenShell harness spike report — 2026-09-10

## Decision

**No-go for a production migration now.** Continue with a bounded OpenShell
qualification, but do not make Codex the universal Mitzo runtime. Keep Mitzo as
the owner of the authoritative conversation, Symposium scheduler, grants,
approvals, provenance, durable queue, and trusted external-action executor.

Codex app-server remains the strongest route for ChatGPT subscription seats;
Pi is the strongest evaluated general-purpose alternative for a future
API-key/Vertex-capable embedded runner. OpenCode is useful as a whole coding
agent/server, but its documented prerequisite is API-key provider setup and it
does not cover the ChatGPT-subscription route. A consistent Mitzo experience
does not require one universal internal harness.

## Exact inventory

| Component | Version / evidence | Result |
| --- | --- | --- |
| Codex CLI | `0.153.4` | Generated app-server schema contains `externalSandbox`. |
| OpenShell | `0.0.116` | Installed local gateway, mTLS connected; VM driver explicitly configured. |
| Pi coding agent | npm `@earendil-works/pi-coding-agent@0.85.1`, MIT | SDK smoke test created an in-memory, read-only-tool session successfully. |
| OpenCode | npm `opencode-ai@1.18.30`, MIT | Documentation comparison only; not selected for the representative test. |

The installed Codex schema supports `sandboxPolicy: { type:
"externalSandbox", networkAccess: "restricted" }`; the fixture records the
current request shape. The mode deliberately turns off Codex's own OS sandbox,
so it is valid only after an outer sandbox is genuinely operating.

## Execution evidence

| Acceptance item | Status | Evidence / limitation |
| --- | --- | --- |
| OpenShell topology | Partial | Local Homebrew gateway started after explicitly selecting its VM driver. Docker/Podman were unavailable. |
| OpenShell filesystem and deny-egress proof | **Blocked** | Disposable `mitzo-spike-6960` pulled the base image but remained `Provisioning`; it was deleted. No command output appeared, so neither filesystem nor egress enforcement is claimed. |
| Codex `externalSandbox` support | Pass (protocol) | Installed schema and official documentation agree. No app-server process ran inside a ready OpenShell sandbox. |
| Codex ChatGPT subscription | Not tested | No login directory/tokens were copied into a sandbox. Managed login would persist credentials in the app-server environment, conflicting with the required host-secret isolation unless a carefully designed external-token or trusted broker arrangement is proven. |
| Codex OpenAI API account | Not tested | The app-server supports API-key login, but a real key was not injected or mounted for this spike. |
| Follow-up/cancel/restart/resume/refresh | Not tested | No authenticated live account turn was authorized. Process restart must not be conflated with replacing the whole OpenShell sandbox. |
| `gws`, `gh`, private clone, second-repo registration | Not tested | The sandbox never became ready. A raw clone would still not prove Mitzo workspace registration. |
| Credential isolation | Partial / design blocker | App-server supports managed ChatGPT OAuth, API key, and experimental externally managed ChatGPT tokens. Neither OpenShell nor Praxis was shown to substitute every CLI/OAuth flow. Do not mount `~/.codex` or API keys into an agent-visible sandbox. |
| External-effect approval bypass | Not tested | No real integration write credential or mock trusted executor was used. Existing Mitzo host callbacks remain outside a Codex-only sandbox and must move behind the trusted executor/broker. |
| Two-seat Symposium contract | Pass (mocked) | `node --test symposium-seat-fixture.test.mjs` passed. It verifies per-seat account/model/context bindings plus original/delivered transcript provenance in one shared workspace; no live provider turn occurred. |

## Harness comparison

| Criterion | Codex app-server | Pi coding agent | OpenCode |
| --- | --- | --- | --- |
| Integration surface | JSON-RPC app server, dynamic tools and thread lifecycle | First-class TypeScript SDK; session events, custom tools, in-memory or persisted sessions | Whole agent with HTTP server/SDK surface; heavier runtime adoption |
| Built-in local tools | Shell/files; outer OpenShell must enforce | Read/write/edit/bash; outer OpenShell must enforce | Rich coding-agent tools; outer OpenShell must enforce |
| Subscription auth | **ChatGPT managed login**, device code, experimental host-managed tokens | Documents ChatGPT Plus/Pro subscription login | Docs lead with provider API keys; no demonstrated ChatGPT subscription entitlement route |
| API-key/provider breadth | OpenAI API and provider-specific Codex capabilities | Broad model runtime; suitable candidate for API/Vertex runner | Broad API-key providers |
| Mitzo-owned approvals/history/recovery | Must remain in Mitzo for cross-runtime seats | Must remain in Mitzo if embedding only the loop/tools | Must remain in Mitzo for Symposium orchestration |
| Reusable executor only | Not the preferred boundary; app-server owns a Codex thread | Possible, but extracting only tools leaves Mitzo with loop/history/cancel/recovery | No reason to select solely as a tool executor |
| License / maintenance | Product-specific platform dependency | MIT, active SDK packaging | MIT, active but fast-moving whole application |

Pi's actual SDK smoke test created `createAgentSession` with
`SessionManager.inMemory` and the read-only `read`, `grep`, `find`, `ls` tool
set, without a model call or credentials. That proves embedding construction,
not inference, account auth, OpenShell execution, or policy enforcement.

## Symposium topology

The default is **one OpenShell sandbox per active Mitzo task/Symposium**, with
all collaborating seats intentionally sharing task files. The sandbox is the
local execution trust boundary; prompt/context grants cannot make a file secret
from a different process in that same sandbox.

Each seat nevertheless has independent immutable bindings:

```
authoritative Mitzo conversation
  ├─ builder seat: profile + ChatGPT subscription + Terra + granted prompt package
  └─ reviewer seat: profile + Vertex + reviewer model + different prompt package
       └─ shared OpenShell task sandbox / explicit shared artifacts
```

Mitzo must retain separate runtime histories, cancellation and continuation per
seat, recipient/provider destination checks, and original/edited/delivered
message provenance. A provider's native multi-agent feature cannot safely be
the authority for this cross-provider contract. Separate seat sandboxes are a
conditional future option only if filesystem trust domains must diverge.

## Security conclusions

1. `externalSandbox` is **not** evidence of sandboxing; it delegates all local
   command safety to OpenShell. Do not enable it on the Mitzo host.
2. A credential-injecting proxy can authorize an API request but does not turn
   ChatGPT subscription entitlement into generic API access or protect every
   arbitrary CLI/OAuth flow.
3. API keys, ChatGPT OAuth caches, and integration write credentials cannot be
   put in the sandbox filesystem/environment and then called isolated. The
   remaining viable patterns need qualification: an OpenShell provider/broker
   that injects only task-scoped request authority, or a trusted host-side
   app-server/token service with a narrow mediated protocol.
4. Human approvals belong outside the sandbox. The sandbox may propose actions;
   a trusted executor must validate the exact approved action and own real write
   credentials.

## Next qualification gate

Fix the OpenShell VM `Provisioning` failure and rerun `run-disposable.sh` until
it emits both required pass markers. Then, before any broader Mitzo work,
qualify one no-secret API request through a broker/provider, prove the agent
cannot read its credential material, and separately run the ChatGPT managed or
external-token flow with forced refresh and restart/resume. Only after those
gates should Mitzo replace its host-side native executor for a selected route.

## Sources

- [Codex app-server](https://learn.chatgpt.com/docs/app-server) — external
  sandbox behavior and account APIs.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) — separate
  subscription and API-key billing/authentication paths.
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
  and [quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md).
- [OpenCode documentation](https://opencode.ai/docs) and [server docs](https://opencode.ai/docs/server).
- Local OpenShell checkout: `/Users/dsaridak/redhat/openshell` at the checked-out
  revision; driver requirements were read from its current docs.
