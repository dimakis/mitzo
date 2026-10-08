# OpenAI API key replacement in Connections

Enrolled accounts appear in **More → Connections → OpenAI API accounts**. The operator
reauthorizes, selects **Replace API key**, enters a masked replacement once, and confirms
that it belongs to the same work OpenAI project. The browser clears the key before waiting
for the response and does not put it in browser storage.

Validation first checks `gpt-6-luna` availability, then sends one fixed, tool-free Responses
request with `reasoning.effort=low`, `store=false`, and at most 256 output tokens. The form
discloses the model, reasoning setting and selected billing account before submission.
Failure leaves both stored credentials unchanged. The API check cannot independently
establish the billing project behind a key; the same-project confirmation is required.

## Custody and recovery

The existing Keychain item is authoritative because host API calls already use it and
OpenShell does not export stored credentials. Mitzo replicates the validated key to the
existing, pinned OpenShell provider. It does not create providers, alter account profiles,
change their billing selection, or change network policy.

An atomic Keychain update writes the secret and an operation receipt together, preserving
the existing item's access controls. The receipt includes an integrity check kept inside
Keychain so a password-only external edit invalidates readiness. The native helper rejects
duplicate items, malformed coordinates and unfamiliar metadata. Values pass through its
stdin and the gateway CLI's environment, never credential-bearing command arguments or
temporary credential files. Errors do not forward native or upstream response bodies.

`openai-key-operations.db` contains only operation IDs, configuration fingerprints,
resource versions, phases, timestamps and safe error codes. It contains no credential
values or credential digests. Its durable intent precedes side effects. The existing
Connections control-plane gate serializes replacement with sandbox admission.

Affected provider-attached sandboxes stop before replacement and retain their workspaces.
Host API requests resolve the verified canonical key for each request, including web
searches. Known unsynchronized accounts cannot start or resume provider work. Removing UI
enrollment or disabling Connections does not bypass previously recorded account fences.

After interruption, recovery can complete a proven Keychain commit whose gateway update
has not started and whose bindings and gateway revision are unchanged. A started or
uncertain gateway update remains **needs attention** until an attended **Retry
synchronization**. Recovery never claims success from a resource-version change alone.
An explicitly entered replacement can supersede a pending operation within the same
binding; the supersession and new blocking intent are one SQLite transaction.

## Enrollment and acceptance

This feature is closed by default. On macOS, with the existing Connections/OpenShell
controller configured, an operator may enroll exact account IDs through
`MITZO_OPENAI_KEY_MANAGEMENT_ACCOUNT_IDS=work-openai`. Each enrolled OpenAI account needs
an existing Keychain reference, `sandboxProvider`, and pinned `sandboxProviderId`.
The current adapter accepts the reviewed `mitzo-openai-keychain-spike` policy only.
Shared provider or Keychain references across configured accounts are refused.

System Python and normal macOS Keychain authorization must be available. A locked,
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
