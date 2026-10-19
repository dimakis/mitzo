# Agent Library

Agent Library lives at `/agent-library`, alongside the existing Agents taskboard at `/tasks`. Desktop navigation and mobile More expose both. A profile has a user-chosen name, short descriptor, description, instructions, expected output, acceptance criteria, and optional advisory setup and compiled-context recipes. Names such as **Bob · The architect** appear in Library, chat selection, and Symposium setup.

## Storage and publication

Library uses the existing owner-scoped Symposium profile version table in `.mitzo/events.db`. Its draft and retry tables add an editable lifecycle without changing existing published versions or their hashes. Identity fields are optional for legacy definitions. Portable validation includes descriptor and description fields.

Draft saves require the expected draft version and published base revision. Draft version numbers keep increasing across publication cycles. Publishing atomically appends an immutable profile version and retires the draft. Exact retries return the original result. Concurrent edits and publication through another profile consumer return a conflict, preserving the working editor contents.

Unsaved edits have a recoverable working copy in the current browser tab. Navigation and refresh restore raw, incomplete fields together with their original version fence and save retry key. Saving or explicitly discarding clears the copy; an acknowledgment from an unmounted editor cannot clear newer edits. Closing a dirty tab prompts before losing its working copy. Browser storage failures retain a memory copy for navigation within the app.

Versioned imports verify the source content hash and create a new local draft identity. An unversioned advisor draft in a `{ "definition": ... }` wrapper passes the same portability validation and enters as a new draft without claiming a source revision. Credentials, machine paths, runtime grants, and transcript dumps are rejected by the existing portability contract. The exported artifact is the same versioned definition consumed by Symposium.

`/api/agent-library` routes require interactive operator authentication. In custodian mode the closed IPC protocol forwards these routes to the retained owner, including exact version reads; unsupported aliases cannot fall through to a local catalog.

## Using a profile

New chats select a published profile alongside account/model selection. The v2 send message carries only profile ID and revision. Before provider dispatch, the server resolves that exact revision through the authenticated transport, verifies its identity/hash and provider compatibility, stores the full portable snapshot on the conversation, and appends its behavioral guidance to the existing platform prompt. Missing or incompatible selections fail explicitly.

Manual profile choices update the current chat URL, including an explicit return to Default Mitzo. Switching between desktop and mobile layouts preserves that choice and the other chat parameters.

Resumes use the saved profile snapshot. Profile edits do not replace it, and an active chat cannot change its binding. Published knowledge adoption, account selection, permission modes, and sandbox ownership retain their existing paths. The older `recipe` field remains advisory reviewer setup guidance. The separate `contextRecipe` field selects compilation. Version 2 packs support ordinary Claude SDK, OpenAI Responses and Gemini/Vertex chats. Native Codex routes cannot use packs, and native Codex or Claude Symposium seats require a profile without a context recipe. Version 1 workspace/preset recipes retain support for local chats and reviewed managed OpenShell sandboxes. Neither field grants tools or installs them.

Library actions are **Use in session** and **Assign task**. Use in session opens ordinary chat setup with the exact selected published profile ID and revision, including a historical revision selected under Versions. Ordinary admission resolves and verifies its immutable hash. Account, model, thinking, Run on and repository setup remain in that session. Symposium is assembled through the session's existing collaboration controls, where saved profiles remain selectable; Library has no standalone reviewer launcher.

## Tasks & schedules

Profiles retains identity, instructions, context, prompt preview, versions and portable import/export. Assigned tasks shows work pinned to that profile. The separate Tasks & schedules collection reads and edits definitions through the authenticated `/api/agent-tasks` API. It preserves `/tasks` and its execution-tree semantics.

Assign task starts with the exact selected published ID/revision/hash. Task settings own the objective, account reference, model/thinking, supported Run on target, workspace/source references and notifications. The ordinary AgentSettingsPicker, controlled AccountModelPicker, ChatExecutionPicker and runtime catalog are reused; Runs with is derived from the selected supported route. No harness picker, credentials, preparation, admission or execution service is added. Saved workspace references are intent, pending future admission validation.

Raw task input and incomplete settings are retained in the current tab across collection/route navigation, refresh, failed saves and conflicts. A failed save retries the same normalized request and idempotency key until an explicit edit. POST uses expectedRevision 0; PUT retains the positive saved revision. Conflicts keep the working copy; refresh retains previously loaded task rows on error. A late save receipt advances its original revision fence and notifies the active editor while preserving newer recovered input. The next edit uses the acknowledged positive revision. Pending list reads merge those receipts without dropping unrelated tasks; a later fresh read remains authoritative. Saved locations resolve through the retained account and harness route as well as target ID, since IDs can be shared by different harnesses. Automatic catalog hydration remains separate from user edits and does not rotate task retry keys or mark a saved draft dirty. Closing an unsaved editor requires explicit discard confirmation. Partial runtime settings, including an empty model choice, remain device-local when they cannot form complete execution intent and survive opening another saved task. Newer saved task revisions leave retained input in place; Refresh tasks and explicit Reload saved task let the user replace it deliberately. These device working copies do not replace the canonical task catalog.

Tasks keep their pinned profile when a newer revision is published. The editor shows an update notice and offers exact published revisions for deliberate selection. Schedules support on demand, weekdays at 07:00, or validated numeric five-field cron and IANA timezone, saved **paused**. Incomplete definitions remain drafts; configured intent stays blocked until run admission is implemented. Run now, enable/resume, run history and computed next occurrences are unavailable in this slice. Saving starts no model or scheduler. See [task contracts](agent-tasks.md).

## Compiled context recipes

The Context tab can opt a profile into ContexGin compilation. A workspace recipe selects up to 20 relative `.md` or `.mdc` documents from the chat's existing workspace, a 256–32,000 token budget, and required or excluded heading paths. For example:

```json
{
  "version": 1,
  "source": "workspace",
  "files": ["docs/architecture.md"],
  "tokenBudget": 4000,
  "required": [["docs/architecture.md", "Architecture", "Constraints"]],
  "excluded": [["docs/architecture.md", "Architecture", "Background"]]
}
```

Heading paths include the filename and each enclosing Markdown heading. Selectors match a case-insensitive prefix, including a whole file; they are not wildcard patterns. All heading levels participate independently. Root `AGENTS.md` is always required in full, with `CLAUDE.md` as fallback when it is absent. Recipes cannot exclude these canonical instructions, and required content exceeding the budget fails explicitly. Missing selected files, symbolic links, invalid UTF-8, oversized sources and unavailable required sections also fail before dispatch. Optional sections may be trimmed to fit.

An existing host-configured ContexGin preset can instead be selected with `{ "version": 1, "source": "contexgin", "agentName": "architect" }`. The host chooses the ContexGin URL; its preset owns source selection and budget. Profiles cannot provide a service URL or runtime grants. Failed or mismatched preset responses fail explicitly.

**Compile preview** uses the server's configured workspace or the selected preset without creating a chat or calling a provider. It shows the compiled prompt, source and token receipt, included and trimmed sections where available, and a context hash. The preset endpoint does not report section trimming; the preview identifies that limitation. A workspace preview is a sample of the configured workspace; a new chat compiles its own selected workspace. Preview bodies remain in the editor state and are excluded from portable exports.

For local chats, compilation completes before provider dispatch. The conversation stores an immutable receipt binding the exact profile revision and hash, recipe, compiler revision, compiled payload and workspace-path identity. That identity checks context scope; existing runtime admission still controls workspace ownership. Logout during compilation aborts admission. First-use compilation failures end the undispatched admission while preserving task roots and history for inspection and retry.

Cold resumes verify and reuse the saved compiled payload even if source documents changed. To use changed sources, start a new chat. A changed recipe, damaged receipt, different workspace path or incompatible compiler revision fails explicitly. Compilation does not automatically publish shared knowledge or record consumer adoption. Portable profiles contain recipe references, never conversation-owned compiled bodies.

For account-independent context, select published [context packs](context-packs.md) in the Context tab. The version 2 recipe pins each pack's identity, revision and content hash plus a final composed token budget. Compilation resolves accepted Git objects from the host-enrolled Knowledge source, independently of writable task roots. Draft previews and supported ordinary chats use this same compiler and source authorization contract.

Pack definitions and profiles remain independent of account, model and runtime, and their editors can still curate and publish packs. Runtime admission currently supports ordinary Claude SDK, OpenAI Responses and Gemini/Vertex chats. Native Codex routes reject packs, including local and OpenShell chats, native Symposium API/subscription seats and approved native search threads. Native Claude Symposium seats reject context recipes; choose a profile without a context recipe for native Codex or Claude seats. Native Gemini Symposium dispatch is unsupported.

Native snapshot/grant and instruction delivery integration is preparation, not admitted pack support. Enabling native Codex packs requires a reviewed native build and enrollment with a trusted source-authority barrier before every provider continuation. Disabling project instructions or checking application-owned tool callbacks alone does not provide that contract. Legacy workspace/preset recipes remain supported for local chats and reviewed managed OpenShell sandboxes, as described below.

## OpenShell sandbox recipes

Ordinary managed OpenShell API and brokered Codex chats compile workspace recipes inside the owning sandbox through `/usr/libexec/mitzo/compile-agent-context.mjs`. Relative references resolve in that conversation's writable task workspace, not the host preview workspace or another sandbox. The protected entrypoint uses the same bounded preloaded-document implementation as local chats, the pinned ContexGin library, and a cleared Node environment. It performs no service fetch, default discovery or runtime grant.

Admission verifies physical sandbox identity, owning conversation/account, Ready state, and the installed compiler/recipe/runtime-input attestations before and after compilation. The image must contain the reviewed agent compiler and its exact ContexGin pin. Older images or missing compatibility pins fail explicitly; removing a rejection does not enroll an incompatible runtime. Unmanaged static sandboxes and isolated native personal/adviser runtimes are not enrolled by this change.

A sandbox snapshot additionally binds the physical sandbox, task root, configured runtime image contract, installed dependency/compiler entrypoint/recipe/runtime-input hashes and effective workspace recipe hash. Cold resume verifies those identities and reuses saved bytes without reading changed source files. A changed preset, compiler or physical sandbox fails rather than silently rebinding the immutable snapshot, including after retained-runtime migration. Use a new conversation when that compatibility cannot be maintained. Existing task roots, history, branches and checkpoints remain preserved.

The recipe is delivered at each safe turn through application context, separate from persistent thread developer instructions. Fresh accepted shared knowledge follows the saved recipe and explicitly supersedes older accepted knowledge copied into task documents. No task root is pulled or reset to refresh knowledge. A new receipt in the private Codex command ledger records exact profile/snapshot/payload/context and sandbox/runtime identities only after the matching native command attempt, thread, turn and generation are acknowledged. Preparation alone creates no adoption receipt.

### Named sandbox presets

`MITZO_OPENSHELL_AGENT_CONTEXT_PRESETS` is host-owned JSON mapping existing preset names to portable workspace recipes. It is bounded to 64 KiB and 100 entries; unknown fields, URLs, paths outside the task root and grants are rejected. For example:

```json
{
  "architect": {
    "version": 1,
    "source": "workspace",
    "files": ["docs/architecture.md"],
    "tokenBudget": 4000,
    "required": [["docs/architecture.md", "Architecture", "Constraints"]],
    "excluded": []
  }
}
```

A portable `{ "source": "contexgin", "agentName": "architect", "version": 1 }` selects this configured sandbox mapping when used in OpenShell. It never copies a host service's compiled body into the sandbox or authorizes a caller-selected service. Local chats and the Library sample preview continue to use the host's ContexGin preset service. Their sources may differ from a configured sandbox mapping; the preview says so. An unavailable sandbox preset fails without fallback.

### Complete application-context delivery

The pinned Codex 0.160.0 provider truncates each additional-context value at 1,000 tokens. Mitzo divides long application context into ordered fragments of at most 800 UTF-8 bytes, preserving code points and all payload bytes. Keys contain a hash of the complete selection and a padded part index: changing any source selection changes every key, so the provider emits the complete changed generation rather than retaining only changed chunks. Total application text is bounded to 1 MiB. User input, provider thread identity and untrusted tool-surface rollover retain their existing paths.

The source contract is verified against OpenAI's exact `79b1b666f2e8551f8abbbca34957227f67f3f553` [fragment implementation](https://github.com/openai/codex/blob/79b1b666f2e8551f8abbbca34957227f67f3f553/codex-rs/context-fragments/src/additional_context.rs) and [ordered context store](https://github.com/openai/codex/blob/79b1b666f2e8551f8abbbca34957227f67f3f553/codex-rs/core/src/state/additional_context.rs). Offline tests assert complete Unicode reassembly, a fact in the middle, required final rules, complete generation replacement, and unchanged user input. This proves transport construction and acknowledged identity, not live model recall.

## Agent Builder chat

**Create with Agent Builder** and **Refine with Agent Builder** open the existing ordinary
Agent Builder conversation. The Library no longer embeds the inference-only
advisor or its separate adviser-account controls. **New agent** still opens the
manual profile editor. Account, model, thinking, execution target and workspace
use the normal shared chat setup; an unavailable route stays unavailable rather
than switching account or runtime.

The handoff retains a normal chat draft with an editable short request and an
attached, content-hashed Agent Library source snapshot. The snapshot carries the
exact selected published revision and definition, or the current unsaved draft
and its version fences. It is reference data, not a tool grant or runtime profile.
The selected chat identity remains the built-in **Agent Builder**, pinned through
its explicit builtin namespace. Opening setup sends no provider turn, saves no
profile and starts no scheduled work.

Returning to the same source reopens its retained draft or acknowledged ordinary
conversation. Reusing an assigned conversation first checks its exact metadata owner.
An explicit hidden state starts fresh setup; an unavailable or mismatched read
retains the link and offers retry. Discarding a composer draft does not cancel an
uncertain send: its pending command identity survives draft recreation until
acknowledgement or definitive rejection, preventing a second command.
Profile edits and conversation drafts remain independent; changing
the source preserves the earlier conversation. The normal composer, Resources,
settings, approval, Stop and reconnect owners remain in control. Proposed profile
edits use the existing review cards and authenticated save/publication lifecycle.
The saved source is visible in ordinary chat context without placing the complete
profile JSON in the editable user message.

The built-in **Agent Builder** chat profile is at revision 2. Its guidance
is resolved through authenticated profile selection, hashed and pinned in session
metadata like a user profile; no setup guidance is pasted into the transcript.
Retained revision 1 drafts continue to resolve their exact original code-owned
guidance, and resumed conversations retain their captured definition.
Selections without the builtin marker still resolve saved catalog content,
including an identical profile ID. The legacy inference-only advice endpoint is
retained for compatibility, with its existing authority and cancellation limits;
it is no longer the Library's creation/refinement entry.

The builder inspects saved profiles with `SymposiumReadProfiles` and creates one complete, portable draft per `SymposiumProposeProfile` call. These tools are registered on ordinary OpenAI Responses, Gemini/Vertex, Claude SDK and Codex chats. Host-bound session and call identities fence draft creation, retry keys deduplicate tool retries, and current skill policy and cancellation remain enforced. In custodian mode, reads and draft creation go to the retained catalog owner using middleware-verified operator authentication, with no local fallback.

Draft cards appear after the transcript in its existing scroll area while Workspace is closed. Review and edit the name, descriptor, instructions, expected output and success criteria, then select **Save reusable profile**. New profiles receive an opaque ID automatically; intentional revisions retain the suggested existing profile identity and conflict checks. Save confirms that the profile is available in Agent Library and links there. The model creates durable review drafts; the authenticated Save action persists the usable catalog revision. No manual JSON import is required. Creating or saving a profile does not grant runtime access or replace an active agent’s revision.

Task definitions can also be read and proposed through `AgentReadTasks` and
`AgentProposeTask` on ordinary routes with verified turn/call identities. They
create durable proposals. The ordinary tool result opens detailed review in the
Library's existing task editor, with a return link to the originating conversation.
The transcript does not contain another task form or editing dialog. Review preserves
exact profile pins, independent task execution settings, the expected task revision
and paused schedule intent. Opening review performs no save or task creation.
Explicit Save task uses the original proposal save route and Library task owner and
shows its exact saved task/revision receipt with a Library link, including after
reload. A proposal is not a save, and a save starts no run or scheduler. Failed or
uncertain saves retain their original request for retry. Proposal review and manual
Library drafts keep separate retained input; navigating between them cannot advance
the proposal's expected revision. Unsupported tool routes
stay unavailable. See [task contracts](agent-tasks.md#ordinary-builder-task-proposals).

The built-in guidance revision is part of the application source. Change its revision when changing its behavior; resumed conversations retain their captured snapshot. It does not create or overwrite user catalog entries.

Legacy workspace/preset proposals can target local or supported managed OpenShell chats. Sandbox presets require confirmed host-owned mappings; the host sample preview may use different sources. Select published packs for supported ordinary Claude SDK, OpenAI Responses or Gemini/Vertex chats. Native Codex and Claude Symposium seats require a profile without a context recipe.

## Validation and rollout

Unit tests cover owner separation, draft/publication conflicts, retries and restart, immutable historical identities, import integrity, private identity fields, exact chat admission, provider compatibility, logout during retained-owner lookup, and reviewer handoff without activation. Mocked startup tests check prompt injection, immutable context persistence, cold resume without recompilation, failure before dispatch, and operator revocation during compilation. Compiler tests cover heading selection, required budgets, source confinement, bounded preset responses, cancellation and receipt verification. Offline browser tests serve the compiled app through request interception with synthetic catalogs, without any running Mitzo service or model calls.

Runtime source authorization remains active through asynchronous provider setup and dispatch. Logout or expiry aborts the owning run. A retained pack snapshot reauthorizes its source namespace, scopes and accepted revision metadata without rereading or recompiling its body. The context disclosure distinguishes preparation from actual provider acknowledgement and preserves source/pack revisions, hashes, budgets and omissions.

Sandbox snapshots additionally verify their owning runtime and installed compiler identities. No deployment is implied; compatible sandbox image enrollment remains separate acceptance work. Canonical staging and its pipeline are stood down on the configured Mac. Live validation requires a separately selected and authorized target and the supported Luna/account declaration rules. Centralized tool grants and automated catalog selection by task templates remain separate work.

## Selecting existing tools

The **Tools** tab chooses existing executable tools for an agent. **Add tools** searches
registered names, descriptions and sources; Remove changes the editable selection.
Save the draft and publish it through the usual version fences. The advisor uses
this same catalog, proposes portable references for review, and preserves an existing
selection when its suggested profile omits tools. It cannot install or execute tools.
**Tool library** browses the installed inventory and lists explicit draft and
published revision references. Legacy use is described separately because those
profiles inherit their runtime catalog rather than an explicit list.

A portable `tools` array contains only canonical implementation identities and
versions, for example:

```json
{
  "tools": [
    { "id": "mitzo:Read", "version": 1 },
    { "id": "mitzo:GetConnectionGuide", "version": 1 }
  ]
}
```

An absent field preserves legacy behavior and historical hashes. An explicit
`"tools": []` permits no optional tools. **AskUserQuestion** is the required platform
interaction tool on enrolled API routes; it cannot grant execution permission.
Choosing **Use legacy catalog** deliberately restores inherited behavior for new
sessions. Save, publish, export/import, working-copy recovery, profile proposals,
and exact historical revision reads preserve these distinctions. Unknown or
unavailable versions remain inspectable in portable profiles but cannot start a
selected session. No tool installation, arbitrary server configuration or API
builder is included.

| Runtime route                           | Explicit selections                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Local OpenAI Responses                  | Supported by the host API runner; existing runtime/account enrollment still applies     |
| Local Gemini/Vertex API                 | Same host API enforcement; existing provider limitations still apply                    |
| Claude SDK / native Claude              | Explicit refusal; use a legacy profile until its entire native tool surface is enrolled |
| Local/native Codex                      | Explicit refusal; dynamic-tool filtering cannot restrict provider-native tools          |
| OpenShell / brokered Codex              | Explicit refusal; native sandbox and host-wrapper enrollment remains separate           |
| Native Symposium seats / search threads | Explicit refusal at profile/seat admission                                              |
| Configured stdio MCP tools              | Supported on enrolled local API routes with verified source-bound discovery receipts    |

The inventory is derived from exported native, connection, repository, profile,
web, publishing and Telos registrations. Telos tools remain visible with their
unsupported selection route. Read/write/mixed classifications describe behavior,
not authorization. See the [route inventory](../design/agent-tool-inventory.md).

Selection is an additional ceiling over existing permissions. It never creates a
connection, supplies credentials, grants a capability, changes permission mode,
or bypasses approval. Connection operations require an active configured connection
and the selected **RequestConnectionAccess** helper for their existing approval
flow. Home Assistant and WebSocket tools require their matching configured access.
Missing dependencies fail explicitly before the model runs. Current skill policy,
connection and account revocation, cancellation, runtime ownership and action
validation still apply at execution, including after human approval.

New supported sessions expose only the selected optional definitions plus the
required interaction tool. Dispatch checks that exact admitted name set before
hooks or execution. Unknown aliases, provider MCP wire names, publishing wrappers
and capability-wrapper names cannot widen it. Explicit selections start only their
selected configured MCP sources after receipt verification; they do not run project
command hooks. **Bash** remains a general
workspace command tool; selecting it permits commands within its existing OS
sandbox. Tool selection restricts invocation identities, not the semantic content
of every allowed program or request. Use the existing workspace/connection policy
for resource restrictions.

The conversation retains its exact published profile and a private admitted catalog
snapshot bound to the account, profile hash and full definitions. Cold resume
rechecks current authority and compares those definitions; catalog drift fails
explicitly instead of substituting a tool. Intentional incompatible implementation
changes require a new tool version. Existing chats cannot adopt edits or refresh
native catalogs. Start a new chat after publishing a new selection.

Offline evidence and remaining live qualification are tracked in
[the Phase 1 acceptance record](agent-tool-selection-acceptance.md) and
[Phase 2 acceptance](configured-tool-selection-acceptance.md). Source tests
and intercepted browser fixtures do not establish live provider execution.

## Discovering configured stdio tools

Refresh configured servers in Tool library explicitly discovers the already
configured and authorized host stdio sources that opt in with a unique
`librarySourceId` UUID in the existing MCP configuration. Add that field to the
existing source entry; this feature installs no server and accepts no command,
URL, credential or launch directory from the picker. Sandbox-only and remote
transports remain outside this connector. Legacy sources without a library ID
retain their existing runtime behavior and are not discovered for selection.

Refresh may start configured processes. It requires interactive operator
authorization and the retained owner's current custody. Loading the page reads
saved receipts only. Refresh is cancellable, bounded to 64 sources, 100 pages per
source, 1,000 tools and 1 MiB of discovery data, and has a two-minute request limit.
Failed or superseded refreshes preserve the saved catalog. A cancellation near
publication may need another refresh to confirm the saved result. Source failures
are reported without returning private process diagnostics.

Duplicate names appear separately under their source labels. Add selects the
exact version and opaque discovery receipt; changing labels cannot rebind an ID.
Description, schemas and annotation hints are untrusted data. Every discovered
tool retains the existing permission boundary; hints never allow a call or a
credential. The full descriptor and trusted launch inputs are bound privately.
The source process starts in its pinned discovery directory even when the chat
uses a different authorized task workspace. Changed configuration or launch
environment requires discovery and deliberate selection again. These receipts do
not attest to executable bytes or a remote implementation behind the same contract.
When replacing an implementation under unchanged launch inputs, the operator must
assign a new source UUID rather than treating the old receipt as an attestation.

New discoveries never rewrite the editor's references, published profiles or
admitted sessions. Additions become available for new selections. Changed or
removed selected tools refuse effects and cold resume; they cannot replace an
old contract by sharing its name. Existing approvals, source configuration,
account/session ownership, revocation and cancellation are rechecked at calls,
including after awaited approval. No active-session catalog refresh is enrolled;
start a new chat after publishing a changed selection.

Portable exports contain source/tool identity, version and an opaque revision,
with no command, path, environment, credential or grant. Importing on an
installation without the exact private receipt remains inspectable but unresolved,
even if a configured source has the same name, UUID or schema. Configure and
discover its authorized source, then deliberately replace the unavailable
selection and publish a new revision. There is no automatic cross-installation
receipt migration. Native Codex, Claude SDK, OpenShell and native reviewer/search
routes still refuse explicit profile selections.

## Configuring reviewed API tools

In Tool library, choose **Configure API tool**. The initial template reads one Home
Assistant entity state through an existing managed Home Assistant connection.
Choose that connection, name the tool and enter an entity such as
`sensor.office_temperature`. **Save draft** validates the configuration without a
request. **Authorize verification** uses existing app reauthorization, then
**Verify API read** makes one GET and validates the bounded response. **Publish
tool** is available only after the saved draft verifies successfully. Verification
failure, cancellation or further edits require another successful verification.
These are product operations; offline development fixtures do not qualify a live
connection.

The implementation disclosure shows the fixed operation and source. Published
cards retain the template and source fingerprint. Endpoint, method, input schema,
output mapping and code are owned by the reviewed template; they are not editable
request-proxy fields. Authentication stays in Connections. Verification's temporary
grant is removed, and each chat still requires its own connection approval.

Select the published API tool and **RequestConnectionAccess** in an agent draft,
publish the profile, then start a new local API chat. Explicit tools work on local
OpenAI Responses and Gemini/Vertex routes. The invocation takes no arguments and
returns only the configured entity's ID, state and last-change timestamp. Existing
native/SDK route refusals and the new-session requirement remain in force.

Configuration, connection authority or reviewed source-closure drift makes old
publications unavailable. Re-save and verify the draft, publish a new tool version,
and deliberately select it in a new profile/session. Existing sessions and cold
resumes never adopt a replacement definition. Portable exports retain only the
opaque tool ID/version/revision; private configuration, grants and credentials do
not travel. Imported references on another installation remain unresolved.

See [Phase 3 acceptance](api-tool-templates-acceptance.md). Source acceptance does
not close Phase 1 or Phase 2 live qualification; canonical staging remains stood
down and production deployment requires a separate explicit request.
