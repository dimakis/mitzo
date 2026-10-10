# Agent Library

Agent Library lives at `/agent-library`, alongside the existing Agents taskboard at `/tasks`. Desktop navigation and mobile More expose both. A profile has a user-chosen name, short descriptor, description, instructions, expected output, acceptance criteria, and an optional reusable recipe. Names such as **Bob · The architect** appear in Library, chat selection, and Symposium setup.

## Storage and publication

Library uses the existing owner-scoped Symposium profile version table in `.mitzo/events.db`. Its draft and retry tables add an editable lifecycle without changing existing published versions or their hashes. Identity fields are optional for legacy definitions. Portable validation includes descriptor and description fields.

Draft saves require the expected draft version and published base revision. Draft version numbers keep increasing across publication cycles. Publishing atomically appends an immutable profile version and retires the draft. Exact retries return the original result. Concurrent edits and publication through another profile consumer return a conflict, preserving the working editor contents.

Versioned imports verify the source content hash and create a new local draft identity. An unversioned advisor draft in a `{ "definition": ... }` wrapper passes the same portability validation and enters as a new draft without claiming a source revision. Credentials, machine paths, runtime grants, and transcript dumps are rejected by the existing portability contract. The exported artifact is the same versioned definition consumed by Symposium.

`/api/agent-library` routes require interactive operator authentication. In custodian mode the closed IPC protocol forwards these routes to the retained owner, including exact version reads; unsupported aliases cannot fall through to a local catalog.

## Using a profile

New chats select a published profile alongside account/model selection. The v2 send message carries only profile ID and revision. Before provider dispatch, the server resolves that exact revision through the authenticated transport, verifies its identity/hash and provider compatibility, stores the full portable snapshot on the conversation, and appends its behavioral guidance to the existing platform prompt. Missing or incompatible selections fail explicitly.

Resumes use the saved snapshot. Profile edits do not replace it, and an active chat cannot change its binding. Boot context, published knowledge adoption, account selection, permission modes, and sandbox ownership retain their existing paths. Recipes remain advisory setup guidance; they do not grant access, install tools, or replace sandbox context compilation. Prompt preview renders the profile guidance and identifies context as unresolved until execution.

Library’s **Use as reviewer** action selects an existing chat and opens its existing add-agent setup with the chosen profile’s guidance. The setup remains editable and follows the same account, sharing, grant, activation, and recovery checks as a manually selected saved profile. This handoff creates no seat or provider turn by itself. Published profiles are also immediately available in the existing Symposium picker.

## Agent advisor

**Create with advisor** opens a normal chat with a prepared brief asking about the agent’s job, success criteria, name, descriptor, and behavior. It uses the existing `SymposiumProposeProfile` tool when available. Proposals appear in the existing chat draft controls for explicit user review and save. That tool can propose guidance, but cannot publish a profile or issue runtime grants. Runtimes without the tool can return portable profile JSON for manual review/import; the UI does not simulate a successful proposal.

## Validation and rollout

Unit tests cover owner separation, draft/publication conflicts, retries and restart, immutable historical identities, import integrity, private identity fields, exact chat admission, provider compatibility, logout during retained-owner lookup, and reviewer handoff without activation. A mocked SDK startup test checks prompt injection and persistence before dispatch. Offline browser tests serve the compiled app through request interception with synthetic catalogs, without any running Mitzo service or model calls.

This change does not deploy to staging or production. Live validation must follow the canonical staging procedure and the supported Luna/account declaration rules. Context-recipe execution beyond the existing runtime path, centralized tool grants, and automated catalog selection by task templates require explicit follow-up integration.
