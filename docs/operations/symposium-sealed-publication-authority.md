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

Remaining integration: the real credential custodian, dedicated controller
CapabilityService binding, physical seal read-only inspection/bundle export,
sealed publication executor, authenticated selection UI, and end-to-end tests.
No GitHub network or model calls were made by the mocked prerequisite tests.
