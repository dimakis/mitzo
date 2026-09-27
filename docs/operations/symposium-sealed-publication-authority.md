# Sealed artifact publication authority prerequisite

This local module is not an installed publication route or a working Create PR flow.
The existing live-builder publication mode remains unchanged.

A physically completed seal revokes writer leases and sandbox attachments. Those
objects cannot be reconstructed to satisfy the live-builder publication adapter.
Managed GitHub connections currently retain a login string and assign capabilities
to model accounts; neither establishes the identity of the controller's GitHub
write credential. The new grant namespace therefore names an authenticated
operator and a separately selected controller credential generation explicitly.

`SealedPublicationAuthority` requires an injected credential custodian. The handle
must retain one immutable generation and perform commands with that credential
only. There is no default custodian or ambient-token fallback. A fixed GitHub
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
and sealed executor integration. Real credential registration, the physical
seal/review bridge and authenticated product UI remain unavailable.
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

## Remaining product wiring

1. Install a reviewed private credential custodian with explicit registration and
   immutable handle generations. No managed provider credential extraction.
2. Install the completed seal/review bridge and shared owned-host lifecycle gates.
3. Add authenticated API selection/preview endpoints binding operator, session,
   exact review/seal, repository, selected connection and verified numeric principal.
4. Add Create PR to the review panel: show unavailable registration state first;
   then explicit account/repository selection and the exact forced approval card.
5. Preserve the durable operation ID across reloads; read-only recovery must display
   pending outcomes without offering blind retry or auto-publication.
6. Run reviewed full integration and live acceptance before enabling the route.

No route, UI action or production credential registration is enabled by this code.

The selected credential custodian must report HTTP failures using the sanitized
`PublicationCredentialHttpError` status contract. An exact 404 maps to the host
publisher's missing-resource branch-rule check; raw stderr/error text is never
parsed. Selected repository names are canonicalized before durable grant hashing.
