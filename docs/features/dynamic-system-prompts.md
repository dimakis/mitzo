# Dynamic System Prompts

**Status:** Design
**Date:** 2026-04-03 (proposed)
**Author:** Claude (with Dimitri)

## Problem

The system prompt is a hardcoded 5-line string in `chat.ts:241-246`:

```
This is Mitzo, a mobile chat interface. The user is on their phone.
- Never take mutating actions (writes, comments, transitions, commits) without explicit user approval...
- Read operations are fine without asking.
- Keep responses concise — small screen.
- Read CLAUDE.md and .cursor/rules/ for project context before doing substantive work.
```

Every repo, every session, every model gets the same instructions. This creates three problems:

1. **No context tailoring.** A Jira triage session in mgmt gets the same prompt as a Mitzo debugging session. The model doesn't know it's talking to a manager doing release prep vs an engineer fixing WebSocket bugs.

2. **No learning loop.** When memory consolidation surfaces insights like "Jira mutations require draft-then-approve" or "always search Drive by name before asking for URLs," there's no path from observation to prompt. The prompt is frozen in source code.

3. **No prompt experimentation.** Different models (Opus, Sonnet, Haiku) respond differently to the same instructions. There's no way to measure this, vary it, or learn from it.

## Design: Three-Layer Prompt Stack

```
┌─────────────────────────────────────────────┐
│           SDK systemPrompt.append            │
│  ┌───────────────────────────────────────┐   │
│  │  Layer 3: Session (persona)           │   │
│  │  "Architecture mode — challenge hard" │   │
│  ├───────────────────────────────────────┤   │
│  │  Layer 2: Repo (.mitzo.json)          │   │
│  │  Context, rules, available personas   │   │
│  ├───────────────────────────────────────┤   │
│  │  Layer 1: Global (defaults.md)        │   │
│  │  HITL, mobile UX, governance          │   │
│  └───────────────────────────────────────┘   │
├─────────────────────────────────────────────┤
│  Prompt Mode: preset | custom | hybrid       │
│  (determines what sits below the layers)     │
└─────────────────────────────────────────────┘
```

Layers are concatenated top-down. Each layer is optional. Assembly is deterministic — same inputs produce the same prompt.

### Layer 1: Global Defaults

**Source:** `~/tools/mitzo/prompts/defaults.md` (repo-tracked, deployed with server)

Contains instructions that apply to every session regardless of repo or task:

- HITL governance (never mutate without approval, present analysis first)
- Mobile UX (concise responses, small screen awareness)
- Read project context (CLAUDE.md, .cursor/rules/) before substantive work
- Memory vault awareness (conditional on repo — only for repos that have one)

This replaces the hardcoded string. Loaded at server start, reloaded on deploy.

**Why a file, not code:** Editable without a rebuild. Reviewable in PRs. A non-engineer could read and understand it. Same reason CLAUDE.md is markdown, not a TypeScript constant.

### Layer 2: Per-Repo Context

**Source:** `.mitzo.json` in the session's `cwd` (already loaded by `repo-config.ts`)

New optional `prompt` section:

```json
{
  "prompt": {
    "context": "Short description of what this repo is and how the user works in it.",
    "rules": ["Rule 1 — specific to this repo", "Rule 2 — specific to this repo"],
    "personas": {
      "manager": {
        "label": "Manager",
        "desc": "Jira triage, 1:1 prep, status",
        "instructions": "Focus on operational clarity. Summarize blockers, risks, actions."
      },
      "architect": {
        "label": "Architect",
        "desc": "RFC reviews, positions, kagenti",
        "instructions": "Focus on technical depth. Challenge proposals hard."
      },
      "builder": {
        "label": "Builder",
        "desc": "Code, scripts, dashboards",
        "instructions": "Focus on implementation. TDD. Feature branches. Ship."
      }
    }
  }
}
```

**`context`** — injected into every session for this repo. Gives the model orientation without reading CLAUDE.md (saves a tool call on mobile).

**`rules`** — repo-specific behavioral constraints. This is where memory insights land: when a dream pass surfaces "Jira mutations require draft-then-approve," it becomes a rule in mgmt's `.mitzo.json`.

**`personas`** — named instruction sets the user can select at session start. Each persona adds task-specific focus on top of the repo context.

### Layer 3: Per-Session Persona

**Source:** User selection at chat start (UI) or quick action config

When starting a new chat, available personas (from the repo's `.mitzo.json`) appear as selectable chips. Selecting one injects that persona's `instructions` into the prompt stack. No selection = layers 1 + 2 only.

The selected persona is recorded in the session metadata for logging.

### Prompt Modes

Three modes determine what sits _beneath_ the three layers:

| Mode                 | systemPrompt value                                                                             | What you get                                             | What you lose                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Preset** (default) | `{ type: 'preset', preset: 'claude_code', append: assembled }`                                 | Full CC tools, safety, environment context + your layers | No control over CC personality                                                       |
| **Hybrid**           | `{ type: 'preset', preset: 'claude_code', append: assembled }` + selective overrides in append | CC foundation + explicit tone/style overrides            | CC defaults still present but suppressed by append                                   |
| **Custom**           | `assembled` (plain string)                                                                     | Full control, lean prompt, per-model tuning possible     | Lose CC tool instructions, safety, environment context. Must recreate critical bits. |

**Preset** is the safe default — what Mitzo uses today, just with richer `append` content.

**Hybrid** is the recommended mode for daily use. Same as preset but the assembled layers explicitly set tone, verbosity, and challenge mandate, which override CC's defaults where they conflict. The model follows the most specific instruction.

**Custom** is the experimental mode. Useful for:

- Testing how raw Claude behaves with only your instructions
- Measuring the CC preset's impact on response quality/style
- Building specialized agents that don't need file editing tools
- Prompt A/B testing across models

Custom mode requires the global defaults to include critical tool instructions (Read before Edit, prefer Grep over shell grep, etc.) that the CC preset normally provides. A `prompts/tool-essentials.md` fragment handles this — included automatically in custom mode, skipped in preset/hybrid.

### Assembly

New `server/prompt.ts`:

```typescript
interface PromptConfig {
  mode: 'preset' | 'hybrid' | 'custom';
  globalPath: string; // defaults.md
  toolEssentialsPath: string; // tool-essentials.md (custom mode only)
  repoPrompt?: RepoPromptConfig;
  persona?: string; // key into repoPrompt.personas
  model?: string; // for future per-model tuning
}

function buildSystemPrompt(config: PromptConfig): string | SystemPromptPreset {
  const sections: string[] = [];

  // Layer 1: Global
  sections.push(readPromptFile(config.globalPath));

  // Tool essentials (custom mode only)
  if (config.mode === 'custom') {
    sections.push(readPromptFile(config.toolEssentialsPath));
  }

  // Layer 2: Repo
  if (config.repoPrompt) {
    if (config.repoPrompt.context) sections.push(config.repoPrompt.context);
    if (config.repoPrompt.rules?.length) {
      sections.push(config.repoPrompt.rules.map((r) => `- ${r}`).join('\n'));
    }
  }

  // Layer 3: Persona
  if (config.persona && config.repoPrompt?.personas?.[config.persona]) {
    sections.push(config.repoPrompt.personas[config.persona].instructions);
  }

  const assembled = sections.join('\n\n');

  if (config.mode === 'custom') {
    return assembled; // plain string
  }

  return {
    type: 'preset' as const,
    preset: 'claude_code' as const,
    append: assembled,
  };
}
```

### Prompt Logging

Every `startChat` call logs to `~/.mitzo/prompt-log.jsonl`:

```json
{
  "ts": "2026-04-03T12:00:00Z",
  "sessionId": "abc-123",
  "model": "claude-opus-4-6",
  "repo": "/Users/dsaridak/redhat/mgmt",
  "mode": "hybrid",
  "persona": "manager",
  "promptHash": "sha256:abc...",
  "promptTokenEstimate": 1200,
  "layers": ["global", "repo:mgmt", "persona:manager"]
}
```

This is the foundation for experimentation. It doesn't score or compare — it records what was used. Analysis tools can be built later as a separate project (prompt-lab) that reads this log.

### Memory Integration Path

The connection between memory vault and system prompt is **manual but systematic**:

1. Dream consolidation surfaces an observation (e.g. "Jira mutations require draft-then-approve")
2. If the observation is behavioral guidance (not just a note), the dream report flags it as a "prompt candidate"
3. Dimitri reviews and adds it to the appropriate `.mitzo.json` rules array
4. Next Mitzo session picks it up automatically

The dream skill can be extended to check: "Are there validated observations that should be prompt rules but aren't in any `.mitzo.json`?" This is a gap-detection step, not auto-modification.

## UI Changes

### Chat Start

- Persona chips appear below the model selector (if repo has personas defined)
- Prompt mode toggle (preset/hybrid/custom) in settings, not per-session — this is a power-user knob, not a daily choice
- Selected persona shown as a pill in the chat header (like the branch pill)

### Settings

- Prompt mode selector: Preset / Hybrid / Custom
- Link to view/edit `defaults.md` (opens in file browser)
- Prompt preview: "Show me what will be sent" — renders the assembled prompt for the current repo + persona

## File Changes

| File                              | Change                                                         |
| --------------------------------- | -------------------------------------------------------------- |
| `server/prompt.ts`                | **New** — assembler, file reader, logger                       |
| `prompts/defaults.md`             | **New** — global default instructions                          |
| `prompts/tool-essentials.md`      | **New** — critical tool instructions for custom mode           |
| `server/repo-config.ts`           | **Modify** — extend RepoConfig with prompt section             |
| `server/chat.ts`                  | **Modify** — replace hardcoded append with buildSystemPrompt() |
| `server/__tests__/prompt.test.ts` | **New** — TDD for assembly, layering, logging                  |
| `mgmt/.mitzo.json`                | **Modify** — add prompt section with context, rules, personas  |

## What NOT to Do

- **Don't auto-generate prompts from memory.** Memory informs what to put in prompts, but a human decides what actually goes in.
- **Don't make the assembled prompt too long.** Target under 2K tokens for preset/hybrid mode. Custom mode can be leaner.
- **Don't vary the prompt mid-session.** The prompt is fixed at `startChat` time. Changing it requires a new session.
- **Don't add prompt mode as a per-session selector initially.** Start with a global setting. Per-session mode switching is a future enhancement once the logging data shows it's needed.

## Future: Prompt Lab (Separate Project)

The experimentation dimension — A/B testing prompts across models, scoring response quality, comparing persona effectiveness — is a separate project that reads from `prompt-log.jsonl` and the Mitzo session history. It has different concerns (eval harnesses, rubrics, statistical comparison) and shouldn't live inside Mitzo's server codebase.

Potential home: `~/projects/prompt-lab/` or `ideas/prompt-lab/`.

Core questions it could answer:

- Does Opus perform better with the challenge mandate than Sonnet?
- Does custom mode produce more concise responses than preset?
- Which persona correlates with the most productive sessions?
- What's the token overhead of the CC preset vs custom?

## Implementation Phases

**Phase 1: Foundation** — `prompt.ts`, `defaults.md`, replace hardcoded string. No UI changes. No personas. Logging in place. Ship as PR.

**Phase 2: Repo context** — extend `.mitzo.json` with prompt section, wire into assembler, add mgmt config. Ship as PR.

**Phase 3: Personas** — UI persona chips, session metadata, persona in prompt log. Ship as PR.

**Phase 4: Custom mode** — `tool-essentials.md`, mode toggle in settings, prompt preview. Ship as PR.

**Phase 5: Prompt Lab** — separate project, reads logs, analysis tools. Scope TBD.
