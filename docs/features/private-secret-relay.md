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
   with the relay ID and target index (and an action index for a reviewed browser
   action). The host resolves the value privately,
   fills the approved fields, and sends the exact reviewed write.
7. The tool returns a safe receipt (HTTP status, MQTT acknowledgement, or browser
   verification/challenge status), never a response body or session state. The agent verifies non-secret service state
   or telemetry before reporting the task complete.

The same stored value can fill multiple fields and destinations. JSON templates
use existing `null` slots selected by RFC6901 pointers. Form templates use existing,
unique empty fields. The agent cannot change templates, destination revisions,
methods, paths or fields after capture. Prototype keys/traversal are rejected.
For HTTPS API targets, authentication continues through the existing connection transport; relay
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
- Native MQTT 3.1.1: a fresh TLS connection authenticates with the captured value
  as its password. `connect` requires CONNACK; `publish` sends one exact topic and
  public payload with QoS 1 and requires its matching PUBACK. Retain is reviewed
  explicitly. No subscriptions, Will, persistent session, reconnect or retry is
  enabled. PUBACK proves broker receipt, not that a device applied the message.
  Cleartext MQTT requires its own flag and a numeric RFC1918 broker, with the same
  controller/loopback/metadata exclusions as the LAN HTTP adapter.
- Private browser: same-origin HTTPS form sign-in, optional human-entered numeric
  MFA, and pre-reviewed later form actions. Cookies and CSRF state remain inside
  the isolated host browser; the agent receives no DOM, screenshots, cookies,
  storage state, response body or OTP. See the browser contract below.
- Cross-origin OAuth, passkeys, push approval, CAPTCHA, bearer-token-only browser
  sessions, arbitrary browsing, file uploads and WebSocket field injection remain
  unsupported. They need dedicated trusted adapters or a human ceremony. Never
  retrieve a raw value for a shell or browser workaround.

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

## Private browser and MFA contract

For runtime-bound OpenShell and Local Codex chats, readiness uses a host-only
capability on the existing ordinary runtime owner. It retains the latest consumed
selection and ordinary admission checks, and rechecks the exact setup, expiry,
chat and runtime through the final native enqueue. Only an exact consumed receipt
acknowledges delivery; an uncertain notification is never replayed. Notifications
start already-admitted FIFO work without acknowledging paused recovery. Other
runtime-bound providers reject private setup before credential capture until they
implement the same guarded continuation contract.

A browser target supplies one `origin`, `allowPrivateNetwork`, reviewed request
rules (`path`, `methods`), login selectors, and an authenticated JSON verification
request (`path`, RFC6901 `pointer`, scalar `equals`). Paths are exact unless a rule
ends in `/`, which explicitly permits that subtree. Each action supplies its label,
page path, non-secret selector/value pairs, submit selector, and optional separate
JSON verification. Research these against the service's documented interface.
The private page displays the account, actions and full public configuration.

Mitzo launches an isolated Chromium instance without attaching to any existing
browser or agent. Service workers, WebSockets, downloads and popups are blocked.
All HTTP is fulfilled through the host's checked HTTPS sender; a blackhole proxy,
disabled QUIC and a non-proxied UDP restriction guard browser-internal fallback
traffic. The sender checks all DNS answers, excludes controller/metadata/loopback,
pins one address, preserves private cookies, bounds bodies/headers, and rechecks
session/runtime/operation authority immediately before actual socket dispatch.
TLS verification remains enabled. Each mutating method/path can be dispatched only
once per operation. Host-memory body fingerprints also block an identical write
across operations. Every operation owns a fresh page; only its main frame can send
requests, and the page closes before the operation ends. Old documents, timers,
popups and late requests cannot borrow a later operation's authority. Cross-origin
redirects and requests fail closed.

`ApplySecretRelay` without `actionIndex` starts sign-in. A
`challenge_required` / `awaiting_code` receipt means the user must open the existing
private relay page. The masked **Verification code** field accepts 6–10 digits
through the browser-only, recent-passphrase/CSRF-protected control plane. It clears
on submission. Codes are kept only in host memory; SQLite and OpenShell contain
no OTP. Staging the code sends no network request. A distinct durable readiness
event resumes the original chat. The next permitted `ApplySecretRelay` consumes
that code before submitting it. Ask mode, tool/skill selection, cancellation,
exact session ownership and runtime authority are checked again. Duplicate code
submits, uncertain MFA and uncertain form actions are never replayed. MFA resumes
by a fresh allowlisted GET of the challenge URL using private context cookies.
The service must restore its code form on that GET; Mitzo never replays the
password POST or retains the old challenge document's scripts to reconstruct it.

After confirmed sign-in, `ApplySecretRelay` with `actionIndex` performs only the
corresponding reviewed form action in that private session. The password is not
resolved again for MFA or later actions. After a private browser dispatch, general
Mitzo API/WebSocket/dashboard response bodies from that origin are withheld, even
after expiry/revocation, because they could echo newly minted cookies or OTPs.
The retained attempt record keeps that boundary across restarts, chats and disabled
relay execution. Other captured relay secrets still require redaction; if their
resolver is unavailable, affected responses are withheld. Use
reviewed browser verification for the task, or operator-side inspection; the
agent cannot switch to another Mitzo transport to extract private browser state. Browser session state is memory-only:
revocation, expiry or runtime retirement closes it; restart loses it and cannot
silently sign in again. An operator must inspect uncertain service state before
preparing an explicitly authorized fresh request.

Browser enrollment also requires the Chromium binary matching the pinned
`playwright-core` package, installed by the operator. No runtime browser download
or fallback to a personal browser is performed. Chromium's sandbox stays enabled
and its child process receives only a minimal OS environment. Browser debug modes
and external test browser attachment are refused; host `NODE_DEBUG` /
`NODE_DEBUG_NATIVE` logging must be disabled for the entire relay runtime.
No tracing, screenshot capture, persistent profile or storage-state export is
configured for private sessions. Offline browser fixtures use synthetic values only.

Example native MQTT target (no password in tool input):

```json
{
  "adapter": "mqtt",
  "broker": "mqtts://broker.example:8883",
  "username": "device",
  "operation": "publish",
  "topic": "home/device/set",
  "payload": "on",
  "retain": false,
  "allowPrivateNetwork": false
}
```

The MQTT wire adapter follows the bounded CONNECT/CONNACK and QoS1 PUBLISH/PUBACK
exchange in the [MQTT 3.1.1 specification](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html).
It deliberately does not retransmit an unacknowledged publish.

## Failure, expiry and revocation

Requests and execution access expire after 30 minutes. The private page can revoke
ready access immediately; active relay operations are aborted. Existing connection
revocation, rotation, runtime retirement, Ask mode and skill/tool selection remain
additional fences. The host checks authority again after asynchronous storage and
resolution and before dispatch. Losing browser authorization cannot publish ready.

Each destination has a durable `not_sent`, `unconfirmed`, `confirmed` or
`challenge_required` receipt. Browser form actions have separate durable receipts.
Mitzo records `unconfirmed` **before** calling the transport. A crash, timeout or
lost response can therefore never cause automatic replay. Concurrent duplicate
calls are rejected; later calls return the retained receipt. `confirmed` means an
HTTP response was received, including error statuses, for HTTP targets. MQTT
receipts name the protocol acknowledgement. Browser receipts confirm the reviewed
interaction and JSON check; when an action omits its own check, only the original
authentication check is repeated. None implies an unconfigured application-level
update check. Inspect non-secret state before considering
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
# Independently opt in to the native adapters:
MITZO_SECRET_RELAY_MQTT_ENABLED=1
MITZO_SECRET_RELAY_BROWSER_ENABLED=1
# Only when cleartext LAN MQTT is intended:
MITZO_SECRET_RELAY_LAN_MQTT_ENABLED=1
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

Adapter verification adds fake-stream MQTT packet tests, browser DNS/transport and
MFA lifecycle tests, and an isolated real Chromium fixture for CSRF cookies,
private OTP continuation, reviewed session actions, blocked off-origin traffic,
blocked page-script retries and expired operation scopes. Phone/desktop fixtures
also cover browser/MQTT review and the masked code form in both themes. Inspected
captures: [mobile MFA](../design/assets/private-relay-mfa-mobile-dark.png) and
[desktop adapter review](../design/assets/private-relay-adapters-desktop-light.png).
No live broker, website, Gateway or model is called by these checks.
