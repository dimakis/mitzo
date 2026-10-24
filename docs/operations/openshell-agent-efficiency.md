# OpenShell agent efficiency

Owned ordinary OpenShell Codex chats now use the same producer-side efficiency
principles as owned Local Mac chats. OpenShell keeps its existing sandbox,
gateway, credentials, repository custody and admission owners. Legacy non-owned
OpenShell adapters retain their existing tool surface.

## Delivery boundaries

Mitzo host dynamic tools expose their original names and concise descriptions
with abbreviated argument schemas. `ListIntegrationTools` searches that selected
host catalogue; `DescribeIntegrationTool` returns the exact full contract. Call
the original tool directly afterward. Direct-only OpenShell discovery has no
`InvokeIntegrationTool` proxy: native call identity, validation, approval and
receipt handlers still own execution. The full catalogue digest participates in
the existing tool-surface fingerprint and native thread rollover logic.

Sandbox MCP tools are a separate native Codex registry. They are never connected
on the host or copied into this host catalogue. `openShellCodexRuntimeConfig`
continues to admit only explicitly sandbox-owned MCP commands, rejecting host
credential environments. Native deferred MCP discovery depends on the selected
model and provider supporting it; Mitzo does not force support, replace native
tool search or claim schema savings for that registry. The reviewed Codex 0.160.0
source paths are `core/src/tools/spec_plan.rs` (`search_tool_enabled`,
`apply_mcp_tool_exposure_policy`) and `model-provider/src/provider.rs`.

The native skill metadata budget is 1500 tokens. `SearchSkills` uses `skills/list`
on the active sandbox app-server with its effective `runtimeCwd`, never a host
skill scan. It returns only enabled metadata in bounded pages. Read the selected
sandbox SKILL.md through native tools; explicit invocation and native skill
instructions still apply. The current Read selection and skill ceiling are
checked before and after metadata lookup, together with current native
transport, active turn, working directory and OpenShell admission.

## Large host read results

`TelosGetItem`, `TelosFindArtifacts` and `TelosReadArtifact` text results larger
than 8 KiB return explicit previews. `ReadToolOutput` searches or pages retained
text with the same UTF-8 byte and UTF-16 cursor bounds as Local Mac. Existing
private conversation storage limits remain 4 MiB per output, eight per
conversation, sixteen globally, and a 24-hour TTL.

Each reference belongs to its conversation/account, original read tool, current
runtime instance and physical sandbox identity. The live owner retains at most
eight original parsed read inputs and client identities. Every page runs the
original read permission handler against those arguments and checks current
operator/session, profile selection, skill ceiling, physical scope, cancellation
and native call identity again after the permission wait. An output ID grants
no authority. Runtime restart, replacement, scope changes or cache eviction
invalidate references; use a fresh narrow read when evidence is needed.

Write receipts, error results and rich results retain their existing contracts.
Native sandbox command/MCP output stays with Codex's native output and history
owners. Mitzo does not truncate native history, change compaction thresholds or
rerun writes to recover output.

Instruction delivery uses the shared exact-section deduplication. Debug manifests
record instruction hashes/sizes, tool schema bytes/count and the skill budget.
Tool observations contain numeric byte counts, duration and outcome, excluding
arguments, content and credentials. Shared sanitized dynamic-tool failures already
apply to both runtimes.

Native asynchronous processes continue to use native session handles. The Local
Mac-only `AgentCommunication wait` helper is not installed in OpenShell: its peer
message send/admission protocol has no OpenShell owner. This efficiency change
does not create cross-runtime messaging authority or an alternative sender.

## Offline proof and limits

Run `node scripts/measure-openshell-agent-efficiency.mjs`. It uses one worker and
a 1 GiB Node heap, retains diagnostics in a temporary directory and prints a small
JSON report. It exercises the original OpenShell admission, cold/reconnect,
command and custody owners with synthetic RPC; no sandbox, model, credential or
live server is used. Local Mac component coverage runs alongside shared code.
The separate Local Mac script remains available for its broader repository
preparation/commit/publication proof.

The representative OpenShell fixture has 26 original host tools: 31,716 schema
bytes become 12,944 including the new helper definitions (59.2% less). A 151,903-byte
multilingual Telos read becomes a 6,109-byte preview (96.0% less). These are
serialized-byte regressions, excluding native sandbox MCP schemas; they are not
model-token counts, end-to-end latency, context peaks or compaction timings.
Prompt caching does not remove cached tokens from the context window.
Live measurements require a separately authorized target and the configured Luna
model/account rules. Staging remains stood down; merge does not deploy this work.
