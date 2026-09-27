# Sealed artifact publication authority prerequisite

The controller publication route and review-panel flow are installed when explicit
private credential references are registered. This is a local integration increment,
not proof of fresh-workspace end-to-end publication. The existing live-builder mode
remains unchanged.

A physically completed seal revokes writer leases and sandbox attachments. Those
objects cannot be reconstructed to satisfy the live-builder publication adapter.
Managed GitHub connections currently retain a login string and assign capabilities
to model accounts; neither establishes the identity of the controller's GitHub
write credential. The new grant namespace therefore names an authenticated
operator and a separately selected controller credential generation explicitly.

`SealedPublicationAuthority` requires an injected credential custodian. The handle
must retain one immutable generation and perform commands with that credential
only. There is no ambient-token fallback; explicit registration supplies the process custodian. A fixed GitHub
`GET /user` read verifies numeric user ID and login. Bot/application credentials
are intentionally unsupported in this increment. Credential material never enters
the grant database, approval projection, seal, or model context.

Each durable grant binds the operator, session, review record/hash, completed
seal/hash, repository, connection revision, credential generation and GitHub
principal. Persisted rows do not restore credential authority. Fresh operator,
artifact and credential checks are required on every use. Revocation and changed
numeric identity reject reuse even when the login string is unchanged.

`guardSealedPublicationExecutor` adds the exact public authority fields to the
forced approval projection and durable recovery intent, and checks them before
and after execution and verification. It must wrap a sealed-artifact executor
registered through a dedicated `CapabilityService`; it must never be registered
as an unapproved direct write endpoint. The underlying reviewed recovery remains
read-only and must preserve exact approved title/body/draft checks. The guard
alone does not install this service or implement its export transport.

The service increment below supplies the dedicated controller CapabilityService
and sealed executor integration. Explicit reference registration, the physical seal/review bridge and authenticated
product UI are now provided by the registration increment below.
No GitHub network or model calls were made by the mocked prerequisite tests.

## Local service increment

`SealedPublicationService` now runs the real CapabilityService with a separate
`sealed-publication` connection namespace and explicit `operator:<id>` subject.
It preserves durable idempotency, forced approval and the normal operation state
machine. The exact selected handle constructs `GitHubCliHostPublisher`; validating
one identity cannot dispatch through an unrelated ambient runner. The existing
GitHub executor shares its policy/approval logic through an explicit artifact
source interface; live sandbox resolution remains required in its existing mode.
The GitHub publication implementation pin intentionally advances to v1.0.2;
other reviewed handler revisions remain unchanged.

Recovery allows only fixed GitHub GET and Git ls-remote reads, rejects changed
approved PR metadata, and cannot create a PR when lookup is empty. Lost credential
custody or revocation leaves ambiguous operations durable; no reapproval or export
is attempted. The local suite runs mocked selected-principal → forced approval →
sealed export → real publisher adapter, including denial, revocation and response
loss. It never reaches GitHub.

The physical-export agent supplies compatible inspection/export methods. A real
integration must implement the additional `require(scope)` bridge by validating
the exact trusted review record against the physical completed seal and returning
its canonical repository path and commit. An arbitrary callback is not a receipt.

## Explicit registration and operator flow

The existing private `MITZO_SYMPOSIUM_OWNED_HOST_CONFIG` accepts an optional
`publicationCredentials` array. Each entry is `{ id, label, reference: { provider,
service, account } }`; only registered CredentialResolver providers are supported.
Grant records use a private `.mitzo/publication/authority.db` directory without changing
existing workspace permissions. Inline credential values and unknown fields are rejected. Listing references never
resolves them. No deployment configuration was changed by this increment.

The authenticated review panel explicitly selects a registered reference, obtains
fresh numeric GitHub identity, displays the review/seal scope, and requests a separate
grant. Create PR then uses the existing CapabilityService permission queue. The
controller must belong to the current authenticated login before and after approval.
Native switch/watch uses ConnectionRegistry rather than an SDK session. While approval
is pending, the bridge borrows SessionRegistry only for its existing permission queue
and permission-response ownership check. Bridge-created entries are refcounted for
concurrent approvals, never report SDK activity, and are removed only at zero users
with exact identity. Existing owners are never removed. Watch lifecycle notifications,
auth expiry and disconnect abort pending approval; reconnect cannot restore it under a
new actor. Writer leases and builder bindings are deliberately not required.
Both connection and publication bootstrap obtain the same canonical `.mitzo/capabilities.db`
owner, regardless of initialization order. Individual services do not close it. Global
shutdown fences and drains tracked invocation/recovery tasks before closing the owner.
Legacy startup/reconnect recovery explicitly excludes the sealed-publication namespace;
sealed recovery is scoped to its exact grant connection.

API mutations use operator authentication and the existing same-origin JSON guard.
The service derives canonical paths from the reviewed artifact mount and the seal's
validated relative repository path; request bodies cannot supply filesystem paths.

`PublicationCredentialCustodian` holds immutable secret material only in memory.
Each command re-resolves the exact selected reference before and after dispatch,
rejecting a changed value rather than silently switching credentials. Disconnect
invalidates the revision and cancels in-flight commands. Restart loses all handles
and requires explicit selection. Keychain changes cannot instantly revoke an already
dispatched network request; the provider controls credential revocation. Such an
uncertain result remains subject to the existing read-only recovery rules.

Commands have a 60-second limit and 4-MiB output cap, an empty private temporary cwd,
scrubbed environment and disabled user/system Git config and hooks. No credential
is placed in argv, a profile, a Git config file, diagnostics or durable state. The
fixed Git helper answers only `get` for HTTPS github.com and ignores store/erase.
Only an exact sanitized gh HTTP 404 crosses the subprocess failure boundary.

The UI retains the exact turn/idempotency identity and request in sessionStorage for
uncertain recovery across remounts; it does not allocate a new write on retry.
The reviewed operation store remains authoritative. Tests use real SQLite, the real
permission queue with a removed builder, and injected credential/command providers;
no real credential, GitHub request or model call is involved.

## Remaining acceptance prerequisites

- Supported native hard attempt budgets and authoritative final accounting remain
  unavailable for the selected pinned Personal ChatGPT path. Native review admission
  remains closed; this code never creates a trusted review receipt.
- `symposium-artifact-initializer.ts` creates an empty Git repository with `main`.
  `symposium-session-artifacts.ts` and the owned host contain no operator-authorized
  repository/base materialization action. `symposium-artifact-git-export.ts` and the
  GitHub executor require origin/default/base/source refs. Therefore a fresh artifact
  cannot reach publication merely by registering a credential. A separate reviewed
  initial repository import contract is required; no arbitrary seed `.git` import,
  provider credential extraction or test-only remote setup is an application path.
- Physical completed sealing and a current trusted immutable review record must
  already exist. Missing prerequisites remain explicit unavailability. Live acceptance
  must be performed only after these contracts are available and separately authorized.

The selected credential custodian must report HTTP failures using the sanitized
`PublicationCredentialHttpError` status contract. An exact 404 maps to the host
publisher's missing-resource branch-rule check; raw stderr/error text is never
retained or exposed; the custodian recognizes the fixed gh status diagnostic. Selected repository names are canonicalized before durable grant hashing.

Publication requests bind to the current tab’s server-issued chat transport ID at dispatch. Reconnect updates only that transport binding. Uncertain publication outcomes use the separate read-only recovery action, never another Create PR invocation. Multiple authenticated watchers cannot redirect the initiating tab’s approval. Direct saved-record links require an explicit **Open session for approval** action, keep the immutable record visible, and render the existing permission banner without starting a model.


### Fresh app authentication and read-only recovery

Within the original retained custodian, a newly authenticated app operator can select an exact
`verification_pending` operation for the currently displayed immutable review record. The UI
requires a separate recent passphrase check and CSRF capability, then calls the dedicated
publication `/recovery` endpoint. This does not select or resolve a replacement credential,
issue a grant, prompt for another write approval, export an artifact, or invoke publication.
Only the original retained handle may perform GitHub GET and Git `ls-remote` observations.

The retained service checks the original operation, approval hash, recovery intent, repository,
review/seal, principal, credential revision/generation, sealed grant and capability grant. It
checks fresh observer authorization around awaited reads and synchronously revalidates original
grant validity immediately before the existing SQLite terminal transition. Original JTI,
grant, approval, operation and idempotency identity remain unchanged. The current sealed-grant
schema has active/revoked state rather than an independent TTL; this path does not extend any
authorization lifetime. Expired observer authorization, revocation, disconnect or uncertain
reads preserve the pending operation. A changed handle or new custodian cannot reconstruct
recovery authority. No automatic retry or cross-custody recovery is provided.
