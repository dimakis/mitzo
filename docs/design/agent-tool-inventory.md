# Agent profile tool selection inventory

Inspected accepted main `97935dbda839c5ffabec41d1d3d4ecdb1559a2fa` (2026-10-15).
This inventory describes registrations, not grants or live qualification.

| Route                                   | Authoritative optional registrations                                                                                                                                                                                                   | Required platform surface                                                           | Explicit selection admission                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local OpenAI Responses                  | `nativeToolDefinitions`, `credentialConnectionToolDefinitions`, `repositoryChatToolDefinitions`, `profileToolDefinitions`, `webAccessDefinition`, `githubPublishingDefinition`; configured MCP definitions from `connectCodexMcpTools` | `AskUserQuestion`; existing permission, revocation, cancellation and runtime fences | Enroll static host definitions with both exposure and dispatch filtering. Configured MCP is excluded from explicit selections pending source identity/discovery work. |
| Local Gemini / Vertex API               | Same `openResponsesChat` runner and host definitions                                                                                                                                                                                   | Same platform boundary                                                              | Same static host enforcement. Existing account/model admission remains authoritative.                                                                                 |
| Claude SDK                              | SDK-native tools and configured MCP, plus `mitzo-connections` server                                                                                                                                                                   | SDK permission hooks and runtime fences                                             | Refuse explicit selections until SDK-native and MCP exposure/enforcement are enrolled together.                                                                       |
| Local native Codex                      | Native definitions, configured MCP aliases, shared connection/profile/repository tools, capabilities, web and GitHub publishing; owned local narrows this to native/MCP/profile/publishing                                             | Native provider tools, runtime ownership, approval and private-path fences          | Refuse explicit selections: filtering application dynamic tools alone cannot restrict provider-native tools.                                                          |
| OpenShell Codex / brokered OpenAI       | Shared tools, sandbox-native tools, host Telos create/get/update/artifacts, managed provider access, capability wrappers, web and publishing                                                                                           | Native/sandbox execution, gateway grants and custody                                | Refuse explicit selections until native and host wrapper catalogs share an enforced admission boundary.                                                               |
| Native Symposium seats / search threads | Separate native seat tool buses and restricted search catalogs                                                                                                                                                                         | Seat grants, membership and runtime admission                                       | Refuse selected profiles at seat admission; no implicit inheritance of ordinary-chat enrollment.                                                                      |

Static host optional inventory: Read, Write, Edit, Bash, GitHubRead, GitCommit;
ListConnections, RequestConnectionAccess, ConnectionRequest, ConnectionWebSocket,
HomeAssistantDashboard, GetConnectionGuide, PrepareConnectionSetup, GetConnectionSetup;
ListRepositories, RequestRepositoryAccess, PrepareRepositoryChat, GetRepositoryChatPreparation;
SymposiumReadProfiles, SymposiumProposeProfile; RequestWebAccess; RequestGithubPublish.
Names, descriptions and input schemas must come from their exported registrations.
Telos and capability implementations remain visible as incompatible where not enrolled.
Configured stdio tools keep their server-scoped canonical names and hashed provider wire aliases;
never resolve an unknown alias by stripping arbitrary prefixes.

Portable refs use a namespaced canonical ID and an explicit implementation contract version.
No connection ID, credentials, endpoint, local path or grant enters a profile. A missing
selection retains legacy behavior, including its existing route catalog. An explicit empty
selection exposes only required platform tools. There is no automatic migration or change
to historical hashes. Exact published snapshots govern resume; editing a profile affects
new sessions. No active catalog refresh is promised. Selection is an additional ceiling,
not an access grant. Existing current-authority checks remain in every executor.

The catalog/schema slice deliberately leaves all execution adapters unenrolled. It rejects
explicit selections, including an empty list, at ordinary profile resolution, direct API
and native Codex startup, shared owned-runtime admission, native Symposium allocation and
host-grant activation. The runtime slice enrolls the local API runner only after exposure,
dispatch and admitted-snapshot enforcement are present. Offline startup regressions verify
refusal before provider calls, task bootstrap, session allocation or grant creation.
