# Runtime readiness observations

This first slice provides a shared, versioned observation contract and exposes it
through the existing authenticated `GET /api/sessions/:id/access` response. It
adds no provider probes, runtime launches, credentials or permission grants.
Telos outcome: `65129503d34b4bc3`; slice one: `1ebd2a0c8c3582a4`.

`packages/protocol/src/runtime-readiness.ts` defines the strict wire schema;
`server/runtime-readiness.ts` projects existing owner facts. The legacy Access
fields now use that projection for all four account providers. The existing
operator authentication, hidden-session checks and read-only route remain.

## What each part establishes

| Part           | Meaning                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`      | Current registered session's selected account/model, effective mode, session grants and skill ceiling. These are session observations, not provider acceptance or service health.                                   |
| `execution`    | Persisted explicit runtime binding, marked `configured` only when its account/profile matches the live session and its location agrees with an existing ordinary runtime owner. It never proves physical execution. |
| `capabilities` | Measurements supplied by the existing runtime owner, or an explicit reason they are unknown. The current application composition supplies no measurements yet.                                                      |

A legacy session without a runtime binding keeps its execution unknown. The
projector never chooses Responses versus Codex, host versus OpenShell, or a
different account from a provider name. Version-one bindings remain configuration
without manufactured target revisions or process identities.

Capability observations carry the session, account/profile, selected model,
explicit runtime binding, task root and owner generation. The caller must supply
the current generation from its existing owner, never from HTTP parameters or
published workspace guidance. A mismatched observation fails closed. This
projection is not an admission authority; every actual operation still runs the
existing authorization, policy and ownership checks.

Within a measurement, process readiness, tool availability, executable presence,
connection configuration, approval, attachment, operation policy and operation
verification are separate facts. An attached provider does not imply a working
command. A successful metadata operation does not verify document text reads.
HTTP 404 is a transport response, not a successful authenticated application read.

## Freshness and revision

Measurements preserve their original `observedAt` and `expiresAt`. Expired
measurements are `stale`; operation verification expires independently of the
surrounding inventory. Future-dated or malformed measurements and duplicate
identifiers are rejected. Missing evidence is never represented as empty grants
or an empty measured tool list. Strict nested schemas reject extra fields such
as credentials, raw environment variables and unfiltered errors.

The snapshot `revision` hashes the projected content. Merely reading the snapshot
does not change it. Permission, identity, evidence and freshness changes do.
Measurements are parsed into independent objects; projection does not mutate the
owner's retained receipt.

## Remaining slices

Slice two enrolls existing adapters to supply measured observations and deliver
the compact snapshot before dependent execution, including safe refresh after
access changes, resume and compaction. That work should build on the ongoing
provider-refresh/runtime-inventory change, without creating a second registry.
Service-path repairs, broader access diagnostics and account/model/runtime live
qualification remain separate slices. This contract alone does not establish
that Google Workspace, Jira, Org Pulse or every account/runtime combination is
working. Staging and live model calls are outside this slice.

Offline regressions cover four provider identities, the six explicit ordinary
account/harness/environment routes, legacy bindings, identity/generation/root
mismatches, expired evidence, independent service states, restrictive permission
transitions, strict fields and the authenticated Access endpoint. No model calls
are used.
