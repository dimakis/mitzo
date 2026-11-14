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
