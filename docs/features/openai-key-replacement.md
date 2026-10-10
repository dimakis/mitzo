# OpenAI API key replacement in Connections

Enrolled accounts appear in **More → Connections → the enrolled AI account → Manage API key**. The operator
reauthorizes and selects **Replace API key**. If macOS has not authorized the signed
Mitzo Keychain helper for this item, this explicit action opens native authorization on
the Mac. **Always Allow** retains access for that signed helper and item; it is never
requested for Python or another interpreter. After authorization, the replacement form
opens automatically. The operator enters a masked replacement once,
and selects **Save API key**. No same/different-project assertion is required; OpenAI bills the account associated with the supplied key. The browser clears the key before waiting
for the response and does not put it in browser storage.

Validation first checks `gpt-6-luna` availability, then sends one fixed, tool-free Responses
request with `reasoning.effort=low`, `store=false`, and at most 256 output tokens. The form
discloses the model, reasoning setting and that billing follows the supplied key before submission.
Failure leaves both stored credentials unchanged. The API check cannot independently
establish the billing project behind a key. The form discloses that billing follows the supplied key without asking the operator to identify its OpenAI project. This replaces the credential for the selected Mitzo connection; it does not assert continuity of the external billing identity. Older clients may still send `sameProject`, but it is optional and not an admission requirement.

## Custody and recovery

The existing Keychain item is authoritative because host API calls already use it and
OpenShell does not export stored credentials. Mitzo replicates the validated key to the
existing, pinned OpenShell provider. It does not create providers, alter account profiles,
change network policy, or assert that the replacement belongs to the previous billing identity.

An atomic Keychain update writes the secret and an operation receipt together, preserving
the existing item's access controls. The receipt includes an integrity check kept inside
Keychain so a password-only external edit invalidates readiness. The signed native helper rejects
duplicate items, malformed coordinates and unfamiliar metadata. Values pass through its
stdin and the authenticated gateway API, never credential-bearing command arguments or
temporary credential files. Errors do not forward native or upstream response bodies.

`openai-key-operations.db` contains only operation IDs, configuration fingerprints,
resource versions, phases, timestamps and safe error codes. It contains no credential
values or credential digests. Its durable intent precedes side effects. The existing
Connections control-plane gate serializes replacement with sandbox admission.

Affected provider-attached sandboxes stop before replacement and retain their workspaces. Read-only attachment inventory accepts exact catalog provider names such as `mitzo-keychain-v2`; service-provider mutations remain restricted to their managed prefix. Already stopped sandboxes need no additional stop. An unproven drain aborts a fresh operation before either credential write and reports `CHAT_PAUSE_FAILED`; it never forces a restart or treats an Error phase as proof of quiescence.
Host API requests resolve the verified canonical key for each request, including web
searches. Known unsynchronized accounts cannot start or resume provider work. Removing UI
enrollment or disabling Connections does not bypass previously recorded account fences.
The journal also retains fingerprints of the nonsecret Keychain lookup coordinates and
provider ID/name. Reusing any of those resources under another account ID requires
operator reconciliation, even after the original profile is removed or enrollment is
disabled. Unrelated legacy accounts retain admission. Older journals without individual
resource coordinates retain their intent and conservatively block unproven account aliases;
upgrading never deletes or infers ownership for those records.

After interruption, recovery can complete a proven Keychain commit whose gateway update
has not started and whose bindings and gateway revision are unchanged. The write sends the journaled provider version as a gateway compare-and-swap;
concurrent updates reject it. A started or uncertain gateway update remains **needs attention** until an attended **Finish key update**. The UI only offers this action when a matching saved key can be used. **Refresh status** reads the saved-operation status, shows progress and its last refresh time, and does not send another model test. A failed refresh retains the previous details with a stale-status notice and disables credential edits. Recovery never claims success from a resource-version change alone.
A completed receipt invalidated by an external Keychain edit requires fresh key entry;
Mitzo does not copy that unrecognized saved secret to the gateway. An explicitly
entered replacement can supersede a pending operation within the same
binding; the supersession and new blocking intent are one SQLite transaction.

## Enrollment and acceptance

This feature is closed by default. On macOS, with the existing Connections/OpenShell
controller configured, an operator may enroll exact account IDs through
`MITZO_OPENAI_KEY_MANAGEMENT_ACCOUNT_IDS=work-openai`. Each enrolled OpenAI account needs
an existing Keychain reference, `sandboxProvider`, and pinned `sandboxProviderId`.
The current adapter accepts the reviewed `mitzo-openai-keychain-spike` policy only.
Shared provider or Keychain references across configured accounts are refused.

Credential writes use Mitzo's direct gRPC adapter for OpenShell's existing conditional
`UpdateProvider` API. The CLI still supplies inventory, reviewed profile export and
sandbox draining; it needs no conditional-update flag or patched binary. CLI and API
provider identity/version observations must agree before candidate validation and writes.

Set the controller-only `MITZO_OPENAI_KEY_GATEWAY_API_PROTOCOL=openshell-v1` after
reviewing the selected gateway's protocol. This adapter pins the v1 wire contract at
OpenShell commit `b4c459f92446167afcb0a2dcf7d9fa6c8945e59c`. It does not guess a different
schema or retry a conflict against a newly read version. Unsupported contracts stay
unavailable before Keychain changes.

The first adapter supports registered HTTPS/mTLS gateways. It reads the controller's
`$HOME/.config/openshell/gateways/<configured gateway>/metadata.json` and existing
`mtls/{ca.crt,tls.crt,tls.key}` files, using the same HOME as the CLI runner. An explicit
configured gateway endpoint must match that registration. It rejects writable/unowned,
linked, oversized or changing files, nonprivate keys, invalid or expired client
certificates, and mismatched key/certificate pairs. Endpoint and TLS material are pinned
for the controller instance: restart after independently reviewed registration or
certificate changes. Certificate validation stays enabled. System-only registrations,
custom XDG locations, plaintext, OIDC and edge-token authentication require separate
adapter support; there is no credential or destination fallback.

Requests have bounded message sizes and deadlines; cancellation closes the request
and client. Authentication, candidate keys and raw gRPC failures remain in the controller
and never enter CLI arguments/environment, temporary files or browser status responses.

Profile export uses OpenShell's canonical false defaults: its `profiles.rs` at
commit `b4c459f92446167afcb0a2dcf7d9fa6c8945e59c` uses `serde(default,
skip_serializing_if = "is_false")` for `request_body_credential_rewrite` and
`allow_uninspected_credentials`. Omitted values normalize to false; explicit true,
null or nonboolean values are rejected. Requiring explicit false fields would
reject the canonical export of the reviewed policy.

The accepted signed helper must be rebuilt and installed with the existing Apple
Developer identity before enabling this release, using `scripts/build-keychain-helper.sh`.
The configured `MITZO_KEYCHAIN_HELPER`, `MITZO_KEYCHAIN_TEAM_ID` and controller namespace
are shared with the existing service-connection helper. There is no Python fallback.
OpenAI rotation coordinates are registered separately in the private controller record;
service-connection items cannot be rotated by this adapter. Reads, writes, status checks
and recovery disable native interaction. Only the separately browser-reauthorized
authorization action may open a prompt; it cannot change a key or invoke a model.
Normal macOS Keychain authorization must be available. A locked,
inaccessible or ambiguous item remains unavailable; the helper does not create items or
weaken access controls. Any required OS authorization is attended enrollment.

Offline tests cover secret handling, authorization, stale forms, binding drift, partial
writes, restart recovery, supersession and retained consumers. The macOS native component
test uses only a newly created temporary Keychain with synthetic values, scopes both
queries to it, deletes it, and verifies that the live search list is unchanged.

Actual app/provider acceptance requires separately reviewed enrollment on the canonical
staging service. Use staging-owned credentials and Keychain names; never copy production
credentials or configuration. State the exact Luna model and charged account before a
live check. Production activation remains a separate explicit action.

Many retained chats drain in batches of at most four. Each batch settles before the next starts; every workspace must be confirmed stopped before credentials change. A failed or uncertain stop refuses the write, with no force restart or retry. Failures before any credential write starts are definite not-saved outcomes when there was no prior pending update; configuration drift still blocks consumer admission. If the save deadline expires before any credential write starts, the journal returns a definite not-saved result and requires a fresh status revision before another mutation. The UI ends save progress before refreshing an interrupted request, and uses the journal’s known failure rather than guessing whether a key was saved.

After a lost save response, refresh distinguishes a new completed receipt from an older ready key. A newly verified receipt reports that the saved key is ready; an unchanged older receipt explicitly leaves the replacement unconfirmed. Readiness alone never claims that the just-submitted replacement was saved.
