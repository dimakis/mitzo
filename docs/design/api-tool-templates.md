# Reviewed API tool configuration — Phase 3

Telos e8ae49e9b2f89183, parent a27aa207cce82024. Initial accepted base d1a3c66a.
Source acceptance and live qualification are separate. Phases 1 and 2 retain
outstanding live qualification. Staging and its pipeline remain stood down.

## First operation and private contract

The initial code-owned template is `home-assistant.state@1`: GET
`/api/states/{entityId}` through the existing Home Assistant Keychain connection
and `CredentialConnections.request`. Home Assistant is already supported by
`credential-setup.ts`; request origin, path, method, authentication, network,
redaction, cancellation and current grant checks remain with that engine.

Configuration contains the fixed template, a label, an existing connection ID
and one validated entity ID. Invocation accepts only `{}`. The endpoint is the
connection's HTTPS origin, never a runtime argument. There are no custom headers,
methods, bodies, output expressions or executable code. The validated mapping
returns only `entity_id`, `state` and `last_changed` from an HTTP 200 response for
the exact entity. Attributes and arbitrary response fields are omitted.

The implementation is inspectable in `server/api-tool-template.ts`, with a source
fingerprint in the reviewed runtime closure. Template semantics changes require a
new deliberate contract/source revision; the binding refuses changed source.
The existing capability registry, including always-approved, durable idempotent
GitHub publication, is untouched. This slice registers no write template.

## Lifecycle

Private SQLite drafts use increasing versions and optimistic concurrency. Save
validates the current connection scope without reading a credential or calling an
API. Explicit verification makes one GET through the existing request engine
under a short-lived verification session, validates the mapped response and
always removes that session grant. This is a real API read in the product; all
implementation tests inject fake HTTP and vault adapters. Page reads and draft
saves cannot verify implicitly.

Verification binds the exact draft, connection authority/transport inputs and
the entire reviewed source closure and its deliberate runtime revision. Even an unrelated registered-source change requires an explicit re-save, verification and publication; this conservative boundary avoids missing transitive execution changes. Cancellation, supersession, changed authority,
non-200 or malformed output prevents publication. Starting another verification
invalidates its previous proof. A failed attempt cannot retain an older success.
Verification stores no response, credential or session grant.

Publication retains immutable definitions and versioned receipts. Exact retries
return the original publication. Changes to configuration or authority block
older publications and require verification, publication, deliberate profile
selection and a new session. Cold resume must retain original definitions and
recheck current authority; configuration cannot silently replace an admitted tool.

Portable profiles carry only `api:<UUID>`, positive version and opaque revision.
Another installation cannot resolve that reference by label or template. Secrets,
grants, connection IDs, endpoints and entity configuration remain private.
Selection never grants access. Legacy missing selection and explicit empty
selection retain their existing meanings. Explicit API references are enrolled only on local OpenAI Responses and Gemini/Vertex API routes; the existing other-route refusals remain. RequestConnectionAccess must also be selected. Canonical policy/hook/display identities remain distinct from private approval keys.

## Delivery and tests

Dependency slices: private template/publication contract; local API admission and
dispatch; bounded Library editor; acceptance and documentation. Required gates are
current-head CI, two trusted exact-head Centaur LGTM/merge/zero-blocker reports,
resolved threads, current main ancestry and fenced official squash merge.

Initial deterministic tests recorded missing implementation, then covered
verification, publication/retry, scope/method/template violations, malformed
output, concurrent edits, cancellation, drift and foreign receipts. One local
worker and a 1 GiB Node heap apply. No backend, staging, personal credentials or
model is used. Native routes and active-session refresh remain unsupported.
