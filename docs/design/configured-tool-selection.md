# Configured tool selection, Phase 2

Baseline: accepted main f995c9d5 (16 October 2026). Telos fe020c5eb8557e9a,
parent a27aa207cce82024. PR 960 owns the catalog redesign and remains open.

## Route inventory

Local OpenAI Responses and Gemini/Vertex share openResponsesChat, host tool
permissions and private snapshots. Explicit selections currently expose static
registrations plus required AskUserQuestion, and exclude configured MCP tools.
Claude SDK, native Codex, OpenShell and native Symposium/reviewer/search routes
refuse explicit selections. Their native surfaces remain unenrolled.

## Identity and binding

A host-configured stdio source opts into library discovery with librarySourceId,
a unique lowercase UUID. Friendly server names are labels. Tools use
mcp:<source UUID>:<SHA-256 of the exact tool name>. Structured tuples, rather than
delimiter aliases, determine identity. Built-in references serialize unchanged.
Discovered references additionally require an opaque revision UUID and a positive
integer version. Neither wire aliases nor descriptions identify a contract.

The private catalog binds each revision to the full discovered descriptor (including
output schemas and annotation hints), the model-facing definition, and
the trusted launch contract (command, arguments, environment, execution location
and source launch directory). Discovery normalizes that directory to an absolute
path and snapshots its launch environment. The private receipt retains that directory;
admission launches the peer there, independently of the authorized task workspace.
Changed ambient launch environment requires discovery again. No paths or environment
values enter the public catalog or portable references.
Versions advance after changes, including remove/re-add. Old revisions are retained,
never overwritten. Local executable bytes and a remote implementation are not
attested by schema fingerprints: the configured operator remains responsible for
the implementation behind an authorized source. Selection grants no authority.

Portable exports contain identity, version and opaque revision only. They contain
no commands, paths, environment, credentials or grants. Another installation lacks
the private revision receipt and reports unresolved; matching names, source UUIDs
or schemas cannot auto-bind an imported reference. Explicit trusted migration of
private receipts is outside this cut.

## Discovery and sessions

GET is a saved projection only. Operator-triggered refresh requires existing
configuration authorization and runtime custody before process creation, during
pagination and before publication. Only opted-in host stdio sources are included.
A refresh owns its clients, closes on completion/error/cancellation, has bounded
pages/tools and rejects repeated cursors. A newer refresh supersedes older results;
a failed/cancelled refresh retains the last saved catalog and reports failure.
Current configuration is rechecked before atomic publication and execution.
Untrusted descriptions, schemas and annotations never authorize a tool.

Published profiles and admitted sessions are immutable. Additions appear in the
library only; removal, schema/config changes, disablement and replacement refuse
old references. No active-session tool refresh is enrolled: new session required.
Cold resume must match both private admitted definitions and source/tool/revision
receipts, and recheck current authority. Revocation blocks an awaited approved call.

Discovery uses the trusted discovery workspace directly and refuses inherited
per-source directory overrides before starting a process. Admitted execution
uses the exact private directory retained by that receipt. Configured source/tool
tuples determine discovery wires as well as portable identity, so labels containing
delimiters cannot collide. Cancellation retains and awaits one shared peer shutdown
promise; the refresh and retained owner cannot settle ahead of real peer cleanup.

Configured-source permission names use a distinct `configured-mcp:` namespace with
a JSON source/tool tuple. Session grants are exact-tool grants. Legacy `mcp__`
server-wide grants keep their existing scope and cannot authorize an opted-in
source, even when the legacy server label equals a source UUID. Neither namespace
grants source access or bypasses mode, skill, workspace or current-runtime checks.

Permission grant keys remain separate from hook/display identities. Opting a source
into discovery preserves its existing `mcp__<server>__<tool>` project-hook matcher,
including denial and input-validation hooks, while approval lookup uses the isolated
source/tool grant namespace.
