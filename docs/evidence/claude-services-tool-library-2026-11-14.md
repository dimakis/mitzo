# Ordinary Claude service tools

Verified 14 November 2026 against freshly fetched main
`f801f8df6cac9c1305727b85a7235928eef2e175` and Claude Agent SDK `0.3.322`.
This is implementation/offline evidence, not production adoption or service qualification.
Telos feature: `8e186fdf-9058-4ad6-af18-8fd6797bf935`; service slice:
`a0feccacb8e9d585`.

## Scope and ownership

Ordinary Local Mac personal Claude and guarded Vertex share the SDK path. The
previous ordinary helper filter exposed only connection discovery even though
the canonical service handlers already supported the other operations. Legacy
Vertex uses the existing shared API path; its dispatch stays unchanged.

| Capability                                            | Implementation and verified boundary                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connections discovery, access, guidance, setup/status | Register the existing eight native connection definitions and use `sessionConnectionTools` / `createCredentialConnectionTools`. No new grants or credential handling.                                          |
| HTTP, WebSocket, Home Assistant dashboards            | Existing request and frame owners; real SDK MCP calls reach synthetic private transports and return results. Dashboard save keeps the existing config-hash contract.                                           |
| Google Workspace                                      | Small MCP registration adapter accepts the canonical union schema and calls `sessionGoogleWorkspaceTools`. Existing Google account/Auto consent remains authoritative.                                         |
| Web access                                            | Existing SDK implementation retained. Exact SDK alias now respects explicit profile selection; other aliases remain excluded.                                                                                  |
| Default configured MCP                                | Reuse `connectCodexMcpTools`, the existing Vertex/Codex owner, with the native execution environment, scoped approval and per-query fences. No provider account environment is copied.                         |
| Explicit Tool Library MCP                             | Reuse published receipts, schemas, lazy source launch, current-source checks and approval from `admitConfiguredTools`. Excluded sources/tools are unavailable.                                                 |
| Explicit Tool Library API                             | Reuse `admitApiTools` and the existing connection owner. Current template is `home-assistant.state@1`; publication and connection grants remain necessary.                                                     |
| Custom tools                                          | Not enabled: installed source inventory is empty and the current accepted custom publication contract permits only `local-api`. A Claude-compatible qualified publication is a concrete separate prerequisite. |

An explicit connection-operation profile also needs `RequestConnectionAccess`,
as required by the existing canonical handler, even with a retained connection grant.
Default profiles retain ordinary built-in helpers; an explicit empty tool list
does not inherit configured sources. API tools require an explicit published reference.

## Inventory actually observed

The live selected catalog was paginated to completion: **101 entries**, comprising
**65 MCP tools** (context7: 2; atlassian: 63) and **36 configured host helpers**.
It exposed **zero API and zero custom tools** in this chat. Those counts describe
this selected catalog, not every private installation or publication. Source
inspection found an empty `installed-custom-tools.ts` registry. No private host
database or credentials were read to infer more inventory.

Synthetic published MCP/API providers qualify transport and handler wiring. They
do not qualify all 65 real selected MCP operations or any external service write.
No real model calls or external-service writes were used.

## Offline verification

- Actual MCP clients call the SDK server and inspect returned results, including
  text/images, invalid schemas, excluded helpers, sanitized failures and source drift.
- The ordinary query owner dispatches a service request on the first query, a
  successor and a cold continuation; retired-query callbacks are blocked. The
  existing query-owner suite covers queue/continuation behavior without a model.
- Canonical access cards exercise approval, denial, expiry, cancellation and
  revocation. Separate transport tests cover WebSocket, dashboard read/save,
  setup/status and no credential exposure.
- Google tests cover default/explicit selection, skill ceilings, invalid input,
  retirement, cancellation and runtime replacement. API/MCP tests cover grant
  revocation, cancellation, original authority and published-source changes.
- Existing configured-tool regression tests exercise Codex and legacy Vertex.
  Targeted lint, formatting and reviewed source-artifact checks pass.

Focused validation uses one Vitest worker and a 1 GiB Node heap. The final
15-suite run passed 206 tests, including the default-profile MCP regression.
A full server build at that heap limit exhausted memory. An earlier
server typecheck passed before the final default-profile addition. Two broader
startup suites could not create disposable Git hooks under TaskExecution's Git
metadata fence (37 fixture failures); these are not counted as passing. Full
build/startup verification remains with CI.

## Integration boundaries

PR #1342 was inspected as an open draft at
`b2675af8199ab8a99f3628d3d93c4e65145c7244`. It owns TaskExecution, approvals and
notifications. This patch does not adopt that branch or replace those owners.
Shared additive edits overlap `credential-sdk-tools.ts`, `chat.ts`, helper/catalog
registration, ordinary SDK guidance and the source-artifact manifest. Preserve
its additions and regenerate the manifest when integrating.

The shared-information, Telos and coordination sessions separately own their
registrations. Their tool IDs and handlers are outside this patch. Source pins
must be regenerated for the combined result. Merge, deployment, independent
review and live provider acceptance remain separate outcomes.

## Landing corrections

Centaur review `5901465931` at `1c01ef34690f69a6946db53b26c45d28236fd2e7`
reported two blocking Google-read findings. `CEN-178D2B344567` omitted the exact
SDK identity from the Ask read-only allowlist. `CEN-23A947D2DF61` marked ordinary
read failures uncertain, preventing terminal callback settlement. Regressions
reproduced three failures before the repair: fresh Ask consent, retained Ask
consent, and settlement after a sanitized failed read. They pass after adding
the exact SDK identity and settling completed read failures only after fresh
authority, consent and cancellation checks. Explicit uncertainty, cancellation
and retired ownership still prevent settlement.

An independent full source/test/fixture pass found the same settlement defect
also affected Google preparation failures. An export-failure regression reproduced
`callbacks_failed` before the additional repair. Preparation and resource reads
now share the same guarded failure classification. Preparation cancellation,
retired ownership and an explicit original-service uncertainty receipt remain
blocking; credential-provider diagnostics remain sanitized by their existing owner.

The correction validation passed **141 tests in eight focused suites**, plus
targeted lint, formatting and registered source fingerprints. A separate local
Tool Library run passed 16 tests. Two focused read-only local reviews inspected
the original adapters; a follow-up security review inspected the first correction,
and an independent full pass found the preparation case. The attempted saved
Vertex specialist authorization and its original-request read both returned
`specialist_tool_failed`; no cross-model contribution was confirmed. Local
reviews do not replace trusted exact-head Centaur approval.

Hosted run `43552259394`, unit shard 2, found eight failures in two older suites
whose assertions still expected the newly enabled services and explicit web
selection to be unavailable. Their updated assertions retain profile exclusion,
unknown execution readiness and empty grants, and exercise rejection of an
unrecognized connection through the actual MCP handler. The capability projector
suite passes locally. A local integration run was terminated by its mistakenly
selected ten-second executor envelope. After inspecting that interrupted attempt,
the complete SDK-owner integration suite passed all **13 tests in 41.35 seconds**
within a 120-second executor bound. The interrupted attempt is not counted as a
pass. Fresh hosted CI must qualify the update.

## Accepted-base integration

The integration uses accepted main
`0ad803cdae56ed6e22c89273ae800d3e7aeb9706`, preserving the accepted lifecycle,
approval, shared-information and Telos corrections. Catalog, selection, chat,
credential SDK registration and source-manifest conflicts are resolved additively.
The runtime revision is `v1.0.1160-claude-services-accepted-base`.

Two targeted read-only integration reviews caught a temporary catalog resolution
that restored main's older ListConnections-only Claude eligibility. The existing
catalog test reproduced one failure before restoring the reviewed service/web
predicate. Both reviewers verified the correction and reported no remaining
integration blocker. Accepted information, delivery, authority and mutation
settlement fences remain present.

Native offline validation passed **299 tests in 14 focused suites**, followed by
all **19 SDK integration tests**, for **318 passing tests across 15 suites**.
The nine runtime-authority fixtures previously blocked by TaskExecution's temporary
directory fence pass under the current native workspace permissions. Two physical
OS-sandbox tests remain skipped because they require `MITZO_TEST_OS_SANDBOX=1`;
this validation does not claim their physical qualification. One test worker and
a 1 GiB Node heap were used. Targeted lint, formatting and source fingerprints pass.

Trusted Centaur review `5903840115` remains the approved baseline at
`bf75c2f96945bafb2cf4f79380705795af517965`; conflict resolutions require fresh
current-head CI and Centaur review. A separate disposable composition with
unaccepted coordination candidate `186807ceb3938352a37a7bc6e4477c9f3c65c68d`
is being prequalified. Its source is not included in this accepted-base integration.
No merge, deployment, live-model or external-service qualification is claimed.

The merge coordinator retains the serialized landing order. Full Stop/reconnect
and cold Send recovery qualification requires the repaired lifecycle behavior
owned by PR #1348. Source review found no consumption of a new PR #1351
authorization contract. Final main integration, combined fingerprints, CI and
Centaur approval remain necessary at the assigned merge turn. No deployment or
production activation is authorized by this evidence.

## Final coordination composition

Accepted main `416faccb366f64ab858897f5b4bfa465e91ef385` has the same tree as
reviewed coordination head `186807ceb3938352a37a7bc6e4477c9f3c65c68d`.
The disposable composition passed **428 focused tests in 19 suites** and all
**22 SDK integration cases**, including Stop, reconnect, cold Send, failed-turn
Retry and FIFO/native selection. Two opt-in physical sandbox cases remain
skipped. The final accepted composition reuses the four reviewed conflict
resolutions; both focused reviewers confirmed preservation of both parents'
registration, approval, credential and query-owner contracts. Query mechanics
match the coordination source; the query module's only services delta is guidance
to use canonical Connections, Tool Library and Google Workspace handlers.

Hosted run `43615462748` on `3e4f83ec90d162e367f45deaa5527c791be03164`
found one failing Connections lifecycle fixture in unit shard 2. The fake SDK
never consumed its first input but expected its successor to resume history.
This reproduced locally as 33 passes and one failure. The fixture now pushes and
consumes first, successor and cold inputs through the actual query owner before
service invocation. All existing resume, retired-query refusal and service-call
assertions remain. The Connections and SDK query-owner suites then passed all
**59 tests**. This correction changes no runtime behavior and weakens no timeout
or assertion. Both focused reviewers verified this narrow delta.

The combined runtime revision is
`v1.0.1166-claude-services-final-composition`, with the union of 2,453 registered
source artifacts regenerated. Fresh hosted CI and trusted exact-head final
Centaur approval are required for the published composition. The coordinator
has reserved the next landing turn; actual merge release remains gated. No live
model, external-service write, physical sandbox qualification or deployment is
claimed.

## Avoid a duplicate full CI run after merge

At Dimitri's request, the final scope also removes the main-push trigger from
`.github/workflows/ci.yml`. Parsed workflow comparison against `8b45b9cb` proves
that every PR trigger, job, permission, environment and concurrency setting is
unchanged. No main-only test/build step was found. Main formerly forced all
optional owners; PR selection continues to run every affected owner, with full
selection for unknown paths or incomplete diffs. Core, compiler/source validation,
full unit discovery, required aggregators and exact-head Centaur remain required.

Inspected repository artifact consumers use immutable IDs from the same CI run.
Recovery and landing reconciliation already react to PR CI events through their
accepted default-branch workflows. The separate native-helper workflows retain
their existing triggers. No new scheduler, artifact adoption or recovery route
is introduced. External artifact consumers were not independently inventoried.

The intentional tradeoff is the absence of a second full suite on main, including
optional suites legitimately unselected for a PR. Accepted-commit verification
must compare GitHub's merged commit/tree with the tested combined candidate;
PR artifacts retain their original provenance. No post-merge full-suite result
will be claimed. Existing strict up-to-date branch protection and exact-head
guarded merge remain necessary.

All **191 focused CI-policy tests in seven files** pass, covering selection,
required gates, cancellation, trusted recovery, compile preflight, build output
and landing reconciliation. Both focused reviewers found no blockers in this
delta. The runtime/source revision advances to
`v1.0.1167-claude-services-pr-ci`; fresh hosted CI and final Centaur review of the
published head remain mandatory.
