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

OpenShell retains the profile snapshot once in persistent provider instructions. Verified publication retrieval guidance is delivered separately; it does not replace the pinned boot body or add another default bundle. Symposium grants bind the selected profile recipe, then persist the compiled snapshot for the exact seat membership generation before native setup/dispatch. Source grants and provider permissions remain enforced by their existing owners. Legacy workspace/preset recipes also support reviewed managed OpenShell sandboxes, as described below. Symposium compiled recipes require packs.

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

## Agent advisor

**Create with advisor** opens a normal chat asking about the agent’s job, success criteria, name, descriptor and behavior. It prefers exact published context-pack references for portable profiles, distinguishes the final composed budget from each pack's preview budget, and asks for confirmed references. It uses the existing `SymposiumProposeProfile` tool when available. Proposals appear in the chat draft controls for explicit user review and save. That tool cannot publish a profile or issue runtime grants. Runtimes without the tool can return portable profile JSON for manual review/import.

Legacy workspace/preset proposals can target local or supported managed OpenShell chats. Sandbox presets require confirmed host-owned mappings; the host sample preview may use different sources. Select published packs for compiled Symposium context.

## Validation and rollout

Unit tests cover owner separation, draft/publication conflicts, retries and restart, immutable historical identities, import integrity, private identity fields, exact chat admission, provider compatibility, logout during retained-owner lookup, and reviewer handoff without activation. Mocked startup tests check prompt injection, immutable context persistence, cold resume without recompilation, failure before dispatch, and operator revocation during compilation. Compiler tests cover heading selection, required budgets, source confinement, bounded preset responses, cancellation and receipt verification. Offline browser tests serve the compiled app through request interception with synthetic catalogs, without any running Mitzo service or model calls.

Runtime source authorization remains active through asynchronous provider setup and dispatch. Logout or expiry aborts the owning run. A retained pack snapshot reauthorizes its source namespace, scopes and accepted revision metadata without rereading or recompiling its body. The context disclosure distinguishes preparation from actual provider acknowledgement and preserves source/pack revisions, hashes, budgets and omissions.

Sandbox snapshots additionally verify their owning runtime and installed compiler identities. No deployment is implied; compatible sandbox image enrollment remains separate acceptance work. Live validation follows canonical staging and the supported Luna/account declaration rules. Centralized tool grants and automated catalog selection by task templates remain separate work.
