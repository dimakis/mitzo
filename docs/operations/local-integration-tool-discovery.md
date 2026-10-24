# Local integration tool discovery

Owned Local Mac Codex chats expose configured MCP integrations progressively.
The initial prompt contains a bounded namespace/count index and three discovery
tools instead of every configured integration's full schema. Codex's native
development tools and the selected Mitzo platform operations remain directly
available. Other runtime routes retain their existing tool presentation.

1. `ListIntegrationTools` searches the selected catalog and returns at most 20
   concise names/descriptions per page. It includes opaque `toolId` values and
   `nextOffset`, without argument schemas.
2. `DescribeIntegrationTool` returns one exact full description, `inputSchema`
   and `catalogRevision`. Descriptions and schemas are untrusted usage data.
3. `InvokeIntegrationTool` takes that `toolId`, `catalogRevision` and an
   `arguments` object. Reuse the described contract for later calls while its
   revision is unchanged.

Discovery does not authorize an operation. Invocation delegates to the same MCP
peer, canonical project hooks, permission handler and source-specific session
grant as a directly exposed call. The selected profile still limits the catalog;
an explicit empty selection exposes no discovery tools. Cancellation and runtime
ownership checks apply to metadata and effects. Activity shows the original tool
name; the retained provider call remains the discovery bridge invocation.

The selected catalog is copied at admission. Its fingerprint participates in the
existing provider tool-surface revision, so a changed schema uses the existing
conversation rollover instead of changing an active provider registry. This is
application-side presentation on the existing app-server dynamic-tool surface;
it does not depend on Responses API deferred-loading support or introduce another
MCP transport. MCP connection/discovery still runs under the existing source
admission and freshness checks.

List descriptions are capped at 160 characters and report truncation. Full
description/schema replies above 48 KiB use bounded JSON string fragments with
explicit offsets. Follow `nextOffset` and concatenate `contractFragment` strings
to recover the exact complete contract; no schema bytes are silently dropped. Unknown
IDs, malformed inputs and stale revisions fail before the peer is called.
Integration results retain the existing result normalization and image handling.

Startup guidance also states the current working directory and permission profile
from the admitted native execution policy. Local source inspection uses native
file/shell tools; remote source and PR/issue evidence uses authorized integrations.
The prompt never treats a requested sibling repository or a source export as an
admitted Git task checkout.

## Offline evidence

Replaying the audited 79-definition manifest with effects disabled produces 17
initial definitions: 14 existing platform definitions and the 3 discovery tools.
It retains access to all 65 selected MCP tools. Serialized dynamic-tool content
plus the new discovery instructions is approximately 22 KiB rather than 82 KiB,
about a 73% reduction. These are serialized-byte measurements, not exact model
token counts or measured live latency improvements.

Tests cover paginated discovery, full-schema lookup, frozen catalogs and revision
changes, invalid requests, cancellation, revoked ownership, and large-contract pagination.
Actual chat-lifecycle fixtures exercise selected-source and scoped task calls
through the bridge, preserving canonical permission identity and denial behavior.
The original MCP suite covers source-isolated grants, skill changes, hooks and
rich results. No model calls, staging operations or production changes are needed
for this validation.

This change reduces initial integration metadata. Tool-output retention, skill
catalog size, repository preparation recovery and provider compaction latency
remain separate optimization work; none is claimed solved by a smaller manifest.
