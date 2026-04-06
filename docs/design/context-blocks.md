# Context Blocks — Dynamic Context Injection

## Problem

When working in Mitzo, you often need the agent to have specific reference material — org charts, workflow definitions, config files — loaded into a particular prompt. Today the options are:

- Paste the content manually (noisy, error-prone)
- Hope the agent reads the right file via CLAUDE.md instructions (non-deterministic)
- Use system prompt injection (session-scoped, not per-message)

None of these give the user precise, per-message control over what context the agent sees.

## Solution

**Context blocks**: user-configurable named references to files that can be selected per-message and injected into the prompt. Think image attachments, but for documents.

## Configuration

Defined in `.mitzo.json` alongside existing config:

```json
{
  "contextBlocks": {
    "Workflow": "jira_process/context/workflow.md",
    "Org Structure": "jira_process/context/org_structure.md",
    "CLAUDE.md": "CLAUDE.md",
    "Boot Context": ".cursor/rules/boot-context.mdc"
  }
}
```

Paths are relative to `REPO_PATH`. Absolute paths and `~` expansion are supported.

## UX Flow

### Selection

1. User types `@` in the chat input (or taps a future command strip button).
2. A picker appears (same pattern as `SlashPicker` for `/` skills).
3. Multi-select: tap to toggle blocks on/off. Selected blocks get a checkmark.
4. Picker closes on blur or explicit dismiss.

### Display (pre-send)

Selected context blocks appear as dismissible pills in the input area, above the textarea, similar to image attachment previews:

```
┌──────────────────────────────────┐
│  /  +  🎤    main                │
│  ┌──────────┐ ┌──────────────┐   │
│  │ Workflow ×│ │ Org Structure ×│ │
│  └──────────┘ └──────────────┘   │
│ ┌──────────────────────────┐ ┌─┐ │
│ │ Explain the team struct  │ │↑│ │
│ └──────────────────────────┘ └─┘ │
└──────────────────────────────────┘
```

Each pill shows the block name, a subtle size indicator (e.g. `2.1k`), and a dismiss button.

### Display (post-send — user bubble)

The user bubble does **not** show the injected file contents. It shows a compact context summary line above the prompt text:

```
┌─────────────────────────────────┐
│ 📎 Workflow, Org Structure      │
│                                 │
│ Explain the team structure and  │
│ how tickets flow through review │
└─────────────────────────────────┘
```

This keeps the chat history readable. The full content is in the prompt the agent received — the user doesn't need to see it again.

### Lifecycle

- Context blocks are **per-message** — selected, sent, then cleared (like images).
- No persistence across turns. If you need the same context in the next message, re-select it.
- This is intentional: context should be deliberate, not ambient.

## Prompt Assembly

On send, the assembled prompt looks like:

```
The user has attached the following reference files for this message.
Use them to inform your response.

<context name="Workflow" source="jira_process/context/workflow.md">
{file contents}
</context>

<context name="Org Structure" source="jira_process/context/org_structure.md">
{file contents}
</context>

---CONTEXT_END---
Explain the team structure and how tickets flow through review
```

The preamble tells the agent what the blocks are and why they're there. The `<context>` tags give clear boundaries and source attribution. The `---CONTEXT_END---` separator marks where context ends and the user's actual message begins.

## Display Separator

The `---CONTEXT_END---` separator serves double duty:

1. **For the agent**: clear boundary between reference material and the user's question.
2. **For the UI**: on replay, split the stored prompt to render a compact `📎 Name1, Name2` line instead of dumping file contents into the user bubble.

```
<context name="Workflow" source="...">
...
</context>

---CONTEXT_END---
Explain the team structure
```

When rendering the user bubble:

- If the stored prompt contains `---CONTEXT_END---`, split on it.
- Display the pre-separator part as a compact `📎 Name1, Name2` line (parsed from `<context name="...">` tags).
- Display the post-separator part as the user's message text.
- If no separator, display the full text as-is (backward compat).

## Size Management

- Each pill shows approximate token count (chars / 4 as rough estimate).
- Total context size is shown if multiple blocks are selected.
- Warn (orange pill border) if total context exceeds 10K tokens (~40KB).
- No hard block — the user may have reasons to send large context.

## API Surface

### Config endpoint

`GET /api/config` already serves `.mitzo.json` data. Extend to include `contextBlocks`:

```json
{
  "quickActions": [...],
  "contextBlocks": {
    "Workflow": { "path": "jira_process/context/workflow.md", "sizeBytes": 3420 },
    "Org Structure": { "path": "jira_process/context/org_structure.md", "sizeBytes": 1856 }
  }
}
```

`sizeBytes` is computed on startup so the frontend can show size without fetching content.

### Content endpoint

`GET /api/context/:name` returns the file contents for a named context block. Called at send time, not at selection time (lazy loading).

Alternatively, the server assembles the prompt (context + user message) — the frontend just sends `{ prompt, contextBlocks: ["Workflow", "Org Structure"] }` and the server handles file reading and assembly. This is cleaner: the frontend never sees the raw content.

**Recommended: server-side assembly.** The frontend sends block names, the server reads files and builds the prompt. This keeps file I/O on the server and avoids sending large payloads over WebSocket.

## Implementation Phases

### Phase 1 — Core (MVP)

1. `.mitzo.json` `contextBlocks` config parsing in `repo-config.ts`
2. `GET /api/config` includes context block names and sizes
3. Server-side prompt assembly: `assemblePrompt` accepts `contextBlocks` param
4. `@` trigger + `ContextPicker` component (multi-select)
5. Context pills in input area (name + size + dismiss)
6. User bubble compact display (`📎 Name1, Name2` + message)
7. WS `start`/`send` messages include `contextBlocks` array

### Phase 2 — Polish

8. Size warning threshold
9. Stale file detection (warn if file modified since server start)
10. Context block search/filter in picker (for repos with many blocks)
11. Recently used blocks pinned to top of picker

### Phase 3 — Extensions

12. Inline context blocks (define content in `.mitzo.json` instead of file path)
13. URL context blocks (fetch from a URL at send time)
14. Glob patterns (e.g. `"Tests": "src/**/*.test.ts"` — concatenates matches)
15. Session-scoped context (opt-in: "keep this loaded for all messages")

## Open Questions

1. **Trigger character**: `@` is natural but might conflict with future @-mention features. Alternatives: `#`, a dedicated button, or `//` (double-slash).
2. **Max blocks per message**: Should there be a limit? Probably not a hard one — the size warning handles this.
3. **Binary files**: Should non-text files be silently skipped or show an error? Probably skip with a warning toast.
