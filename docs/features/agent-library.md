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

Resumes use the saved profile snapshot. Profile edits do not replace it, and an active chat cannot change its binding. Published knowledge adoption, account selection, permission modes, and sandbox ownership retain their existing paths. The older `recipe` field remains advisory reviewer setup guidance. The separate `contextRecipe` field selects compilation. Version 2 packs support every existing account/runtime adapter; version 1 workspace/preset recipes retain their local-chat scope. Neither field grants tools or installs them.

Library’s **Use as reviewer** action selects an existing chat and opens its existing add-agent setup with the chosen profile’s guidance. The setup remains editable and follows the same account, sharing, grant, activation, and recovery checks as a manually selected saved profile. This handoff creates no seat or provider turn by itself. Published profiles are also immediately available in the existing Symposium picker.

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

For account-independent context, select published [context packs](context-packs.md) in the Context tab. The version 2 recipe pins each pack's identity, revision and content hash plus a final composed token budget. Compilation resolves accepted Git objects from the host-enrolled Knowledge source, independently of writable task roots. Draft previews, new chats and Symposium seats use this same compiler and source authorization contract.

OpenShell retains the profile snapshot once in persistent provider instructions. Verified publication retrieval guidance is delivered separately; it does not replace the pinned boot body or add another default bundle. Symposium grants bind the selected profile recipe, then persist the compiled snapshot for the exact seat membership generation before native setup/dispatch. Source grants and provider permissions remain enforced by their existing owners. Legacy workspace/preset recipes require local chat execution; select packs for portable runtime use.

## Agent advisor

**Create with advisor** opens a normal chat asking about the agent’s job, success criteria, name, descriptor and behavior. It prefers exact published context-pack references for portable profiles, distinguishes the final composed budget from each pack's preview budget, and asks for confirmed references. It uses the existing `SymposiumProposeProfile` tool when available. Proposals appear in the chat draft controls for explicit user review and save. That tool cannot publish a profile or issue runtime grants. Runtimes without the tool can return portable profile JSON for manual review/import.

## Validation and rollout

Unit tests cover owner separation, draft/publication conflicts, retries and restart, immutable historical identities, import integrity, private identity fields, exact chat admission, provider compatibility, logout during retained-owner lookup, and reviewer handoff without activation. Mocked startup tests check prompt injection, immutable context persistence, cold resume without recompilation, failure before dispatch, and operator revocation during compilation. Compiler tests cover heading selection, required budgets, source confinement, bounded preset responses, cancellation and receipt verification. Offline browser tests serve the compiled app through request interception with synthetic catalogs, without any running Mitzo service or model calls.

Runtime source authorization remains active through asynchronous provider setup and dispatch. Logout or expiry aborts the owning run. A retained snapshot reauthorizes its source namespace, scopes and accepted revision metadata without rereading or recompiling its body. The context disclosure distinguishes preparation from actual provider acknowledgement and preserves source/pack revisions, hashes, budgets and omissions.

No deployment is implied. Live validation follows canonical staging and the supported Luna/account declaration rules. Centralized tool grants and automated catalog selection by task templates remain separate work.
