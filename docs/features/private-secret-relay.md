# Private secret relay

An agent can request one password or token from its current chat and apply it to
several reviewed destinations without receiving the value. This is separate from
setting up API authentication: an API's login credential and the password being
written into that API can be different secrets.

1. The agent researches the documented API/device form and calls
   `PrepareSecretRelay` with exact destinations and non-secret request templates.
2. A card in the original chat opens `/connections/secrets/:id`.
3. The user reviews the destinations, methods and secret fields, enters the value
   in the masked input and authorizes saving with their Mitzo passphrase. Recent
   browser authorization can be reused. Values never belong in chat/tool arguments.
4. The host creates a dedicated, unattached OpenShell provider. SQLite stores only
   configuration, pinned provider identity/version, and dispatch receipts.
5. The durable readiness outbox resumes the same chat when it is attached and
   idle. Busy or detached chats retain the pending notification. Provider dispatch
   uses the existing persisted message identity, not a new independent task.
6. The agent requests existing API connection access and calls `ApplySecretRelay`
   with only the relay ID and target index. The host resolves the value privately,
   fills the approved fields, and sends the exact reviewed write.
7. The tool returns HTTP status only. The agent verifies non-secret service state
   or telemetry before reporting the task complete.

The same stored value can fill multiple fields and destinations. JSON templates
use existing `null` slots selected by RFC6901 pointers. Form templates use existing,
unique empty fields. The agent cannot change templates, destination revisions,
methods, paths or fields after capture. Prototype keys/traversal are rejected.
API authentication continues through the existing connection transport; relay
values are stored in OpenShell, not silently copied to Apple Keychain.

## Boundaries and supported destinations

- Existing authenticated HTTPS connections: POST, PUT and PATCH with JSON or
  URL-encoded form bodies; exact connection revision and chat grant required.
- Separately enabled LAN device forms: canonical literal RFC1918 IPv4 HTTP origins
  with the same methods/body encodings. The setup page explicitly discloses
  cleartext transport. DNS, public addresses, loopback, metadata/CGNAT addresses,
  the controller's own network interfaces, credentials in URLs and redirects are
  rejected. LAN consent is limited to the exact reviewed write; it creates no
  general network access for the agent.
- Native MQTT, arbitrary browser login/OAuth/MFA, cookies/CSRF exchanges, file
  uploads and WebSocket field injection need additional trusted adapters. The
  agent must not export a value to a shell or browser to bypass those limits.

The heating-controller fixture demonstrates the flow, **not a verified HeishaMon
API contract**. Its `/settings` and field names are synthetic. Research the actual
device version's documented save operation and preserve unrelated settings before
preparing a real request. This implementation performs no device migration.

Direct write response bodies are discarded. Supported subsequent HTTPS,
WebSocket and dashboard reads redact known relay values using persisted Gateway
references, including across chats using the same endpoint. A Gateway resolution
failure withholds the response. This protects supported Mitzo transports; it does
not claim control over every unrelated third-party tool or arbitrary service
transformation of a secret. Keep agent egress limited to reviewed adapters.

## Failure, expiry and revocation

Requests and execution access expire after 30 minutes. The private page can revoke
ready access immediately; active relay operations are aborted. Existing connection
revocation, rotation, runtime retirement, Ask mode and skill/tool selection remain
additional fences. The host checks authority again after asynchronous storage and
resolution and before dispatch. Losing browser authorization cannot publish ready.

Each destination has a durable `not_sent`, `unconfirmed` or `confirmed` receipt.
Mitzo records `unconfirmed` **before** calling the transport. A crash, timeout or
lost response can therefore never cause automatic replay. Concurrent duplicate
calls are rejected; later calls return the retained receipt. `confirmed` means an
HTTP response was received, including error statuses; it is not proof that an
application-level update succeeded. Inspect non-secret state before considering
another user-authorized attempt.

A lost Gateway save response retains an unconfirmed setup and deterministic
provider name. A returned provider reference is retained even if authorization
then expires. Do not automatically resubmit the value or discard uncertainty.
Expiry/revocation ends Mitzo's execution access; it does not delete Gateway storage
or diagnostic records. Cleanup is a separate operator operation against the exact
recorded provider identity. No name-only automatic deletion is provided because
that could remove a replacement provider. Retained references continue to protect
subsequent reads from echoing values.

## Runtime enrollment (explicit operator action)

The feature is disabled by default. It attaches to the existing protected
credential-connection runtime and private metadata database. That runtime currently
requires the signed macOS Keychain helper for API authentication. This does not
migrate existing API credentials or bypass its setup requirements.

Required operator configuration:

```text
MITZO_SECRET_RELAY_ENABLED=1
MITZO_SECRET_RELAY_GATEWAY=<registered-gateway-name>
MITZO_SECRET_RELAY_WORKSPACE=<private-workspace>
MITZO_SECRET_RELAY_PROTOCOL=openshell-operator-credentials-v1
# Only when cleartext LAN device writes are intended:
MITZO_SECRET_RELAY_LAN_HTTP_ENABLED=1
```

The host reads the selected Gateway registration and mTLS files from its own
`~/.config/openshell/gateways/<name>`. These files are denied to native agent
reads and the protected SDK process tree. The transport pins the endpoint and
certificate identity for its lifetime, bounds requests, disables retries and
suppresses Gateway diagnostics. No TLS material or raw value is delivered to an
agent sandbox; relay providers must never be attached to one.

The Gateway must support the reviewed workspace-selector API and the direct
operator `GetProviderCredentials` RPC. This differs from Mitzo's historical
0.0.116 provider-update protocol. Setting the feature flag does not upgrade a
Gateway. Unsupported RPCs fail closed without a Keychain, CLI or plaintext-file
fallback. Live acceptance on an explicitly authorized target is required before
activation; it has not been performed by this change.

An operator must import a workspace-scoped `mitzo-secret-relay` profile with one
required static credential named `value`, environment key `MITZO_SECRET_VALUE`,
and no endpoint, binary, file, discovery, inference, refresh or token-grant
configuration. The host verifies that profile before storing or resolving a value
and pins its resource version. The narrow wire descriptor is in
`server/openshell-secret-protocol.ts`, based on the official
[OpenShell API](https://github.com/NVIDIA/OpenShell/blob/main/proto/openshell.proto)
and [data model](https://github.com/NVIDIA/OpenShell/blob/main/proto/datamodel.proto)
retrieved on 21 October 2026. Existing deployments require a separately reviewed
compatible Gateway upgrade/backport and profile enrollment; this PR changes neither.

No staging or production activation is part of this change. Canonical Mitzo
staging remains stood down.

## Offline verification and design evidence

Focused unit/integration tests cover private storage identity, protocol tags,
owned-session setup, exact fields, grants/revisions, redaction, authorization races,
revocation, duplicate/uncertain writes and durable readiness continuation. Gateway
transport tests use disposable mTLS certificates and a synthetic local gRPC server.
There are no model calls or live service credentials in these tests.

The private page/card reuse `ConnectionSetupView`, `ConnectionSetupCard`, existing
connection authorization, workspace surfaces/actions, `UiIcon`, semantic tokens,
and shared form styles. New destination disclosures use the shared spacing/type
scales, monospace role and 44px control height; no palette/font is introduced.
The approved Chat settings design is unchanged.

The intercepted `tests/offline/secret-relay.spec.ts` fixture checks 320px mobile
WebKit/Chromium and 1280px desktop Chromium, dark Mint/System and light Teal/Georgia,
keyboard disclosure, scrolling, touch targets, private submission and revocation.
Inspected captures: [mobile review](../design/assets/private-relay-mobile-dark.png)
and [desktop entry](../design/assets/private-relay-desktop-light.png).
The full server type check exceeded the repository's local 1 GiB heap limit; the
focused relay module type check passed. Broad application builds and the complete
`test:ui` matrix are left to CI under the host resource policy.
