# New OpenAI API accounts in Connections

With new-account enrollment enabled, open **More → Connections → Add connection → OpenAI API**.
Reauthorize with the Mitzo passphrase, choose an account label, enter the intended project name,
and enter the API key in the masked field. The project name is an operator declaration; Mitzo
cannot establish the key's billing project from the API response. Confirm that this key belongs
to the intended project before submitting.

Setup runs one bounded, tool-free `gpt-6-luna` request at low reasoning, billed to the project
behind the entered key. It also reads the account's available models and intersects them with
Mitzo's reviewed API chat models. Only Luna is inference-tested during setup. The browser
clears the key when submitting and never stores it in local storage. Keys never appear in
account profiles, API replies, error messages, or enrollment metadata.

A successful setup creates a separate account. Select it explicitly when starting a new chat.
Existing accounts, saved keys, provider bindings, and conversation billing remain unchanged.
Use this flow for a different project; the separate same-project key replacement flow is not
required and is not enabled by this feature. Enrolled accounts are excluded from that
replacement flow even if their IDs are listed in its operator configuration.

## Configuration

The macOS controller requires the existing reviewed Connections/OpenShell configuration and
an explicit `MITZO_ACCOUNT_PROFILES_FILE`. Set both:

- `MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB` to an absolute database path inside a dedicated private
  directory (owner-only directory and files).
- `MITZO_OPENAI_ACCOUNT_ENROLLMENT_ENABLED=1` to allow new enrollments through the browser.

The gateway must already contain the reviewed `mitzo-openai-keychain-spike` provider profile.
The accepted CLI's create-only provider operation suffices: this path never updates an
existing provider, and does not require the pending conditional-update CLI extension.
New gateway providers and Keychain items receive unique names derived from a server-generated
operation ID. The configured signed Mitzo Keychain helper uses create-only insertion; it cannot
replace an existing entry. The same signed identity creates the item and verifies its
receipt, so verification does not introduce a second Python-to-helper authorization
step. The helper must be rebuilt from accepted source before this rollout. Creation
and verification do not open desktop prompts; a locked Keychain requires attended
unlocking on the Mac.

Leave the database configured when disabling new enrollments. Its retained accounts and
credential checks remain active independently of the browser switch. Missing, corrupt,
unsafe, or aliased registry metadata fails closed. Static profiles cannot borrow enrolled
Keychain/provider resources under another account ID, including resources from interrupted
operations. The registry directory and SQLite sidecars remain excluded from chat file access.

## Interrupted setup and readiness

The journal stores a request ID and nonsecret resource metadata before validation. Repeating
the same request returns its recorded state without making another validation call or
creating another provider. A failure before storage permits an explicit attempt with a new
key. Once storage may have changed, an uncertain operation remains **needs attention**;
refresh its status instead of submitting another setup. The server blocks all new enrollment
requests while any saved operation is unresolved, including after a page reload or a new request
ID. Existing ready accounts remain usable. Restart marks unfinished operations
for inspection and never replays credential writes or adopts a provider from its name alone.

An account enters the catalog only after confirmed Keychain storage and provider creation.
Admission then verifies the exact Keychain operation marker, provider ID and resource version,
and the controller gateway/workspace identity. Host requests use the exact verified key returned through
the admission gate, without a second credential lookup. External credential edits or changed provider identity block use.
Pending resources are retained for attended reconciliation; there is no automatic deletion.

## Acceptance and activation

Offline coverage exercises browser authorization, billing consent, secret redaction,
create-only storage, uncertain outcomes, duplicate submission, catalog publication, retained
resource ownership, and legacy-account admission. Real provider acceptance must use the
canonical staging instance with independently reviewed staging configuration and staging-owned
credentials. Do not borrow a production key or gateway for staging. State the exact Luna model
and charged account before any live test. Production activation requires a separate explicit
user action and accepted reviewed sources.
