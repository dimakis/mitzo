# Personal ChatGPT seats in Symposium

The experimental native route keeps personal ChatGPT subscription billing separate
from work OpenAI API and Claude via Vertex. Each active seat generation has its own
upstream OpenShell sandbox and exact provider attachment. All seats remain in one
Symposium conversation. Shared artifacts use the existing explicitly admitted
volume and writer/read-only reviewer mounts; authentication and runtime state stay
in the private seat home.

Production admission remains closed. This implementation does not add a personal
account to a running deployment or prove live subscription inference. The existing
production attestation authorizes only OpenAI API writer seats; changing its
provider allowlist cannot enable subscriptions.

## Authentication route

The native route follows the public upstream
[Codex app-server example](https://github.com/NVIDIA/OpenShell/tree/1905069948f96921daf88bffb160dceb9ac2a307/examples/codex-app-server),
introduced in upstream commit `1905069948f96921daf88bffb160dceb9ac2a307`.
The example's profile uses gateway-owned OAuth refresh material. Its sandbox
receives opaque access-token and account-ID handles and calls native OpenAI
endpoints. The bootstrap writes sandbox-private Codex authentication state with
`auth_mode: chatgptAuthTokens`; it does not expose a real refresh token to the seat.
Mitzo adapts the bootstrap to its controlled stdio process lifecycle.

This differs from the older Mitzo `openai-codex-oauth` compatibility route described
in [subscription upgrades](../operations/openshell-subscription-upgrades.md). That
route requires a private gateway patch and `inference.local`. Symposium rejects
that binding and host credential references for its new native route. No gateway
patch is included here.

The upstream bootstrap uses a synthetic ID token for local Codex parsing.
Consequently, `account/read` can check ChatGPT authentication mode but its displayed
email and plan do **not** prove the real account identity. A trusted host must
independently bind the selected personal account and profile revision to the exact
provider instance, reviewed provider profile, authorization state, sandbox and
membership generation. Missing proof must fail before inference. Configured labels
or a matching provider name alone are insufficient.

## Explicit selection

A native Symposium account profile uses provider `openai-codex`,
`nativeAuth: sandbox-chatgpt`, `sandboxProviderType: codex`, and an explicit
`sandboxProvider` name and `sandboxProviderId`. The profile retains its configured
personal account email, plan and model catalog. It must not include a host
`credentialRef`, old `sandboxGrantId`, or a work `workspaceId`.

The Director's account/model selection retains the immutable `AccountBinding`.
A profile, provider or membership change requires reconciliation; it cannot silently
rebind an existing seat. Unsupported models or unavailable accounts fail explicitly.
Neither an API key nor another account is a fallback. Native controller attempts
retain the selected CLI, gateway, workspace and endpoint across sandbox reuse and
restart recovery; ambient host defaults cannot redirect a turn or cancellation.
Legacy attempts without a recorded route remain quarantined for reconciliation. This native profile is scoped
to Symposium and cannot be launched through the legacy ordinary-chat adapter.

## Acceptance still required

Before enabling this account in production, the host needs verified evidence for:

- The matched upstream CLI/gateway, imported refresh-capable Codex profile, exact
  provider instance and personal-account authorization binding.
- The runtime image, controlled native launcher, private seat home, and absence of
  work/API credentials or shared authentication mounts.
- Native endpoint policy, credential substitution, refresh, negative route denial,
  and cross-seat credential isolation.
- Streaming and durable replay, cancellation and host-restart recovery, and
  coexistence with work OpenAI and Vertex seats in one ChatView.
- The existing artifact-volume, reviewer and production-bootstrap gates.

Focused tests use mocked providers and processes. Live acceptance must explicitly
select a Luna model supported by the personal account and announce that exact model
and charged account beforehand. If Luna is unavailable or unsuitable, obtain approval
for another model. The separate approved Vertex Haiku test remains blocked by the
previous IAM denial; no IAM changes are part of this work.
