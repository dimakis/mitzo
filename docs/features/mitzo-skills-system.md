# Mitzo Skills System

**Status:** Design
**Date:** 2026-04-04 (proposed)
**Author:** Claude (with Dimitri)

## Mental Model First

If this design feels fuzzy, use this mapping:

| Thing              | What it is                                                                        | Where it lives                              | Example                      |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| **Quick action**   | A home-screen shortcut that opens Mitzo with a prefilled route/prompt             | Repo `.mitzo.json`                          | "Deploy staging" button      |
| **Skill**          | A reusable prompt package with metadata, arguments, and optional tool constraints | Built into Mitzo, user scope, or repo scope | `/deploy staging`            |
| **Native command** | Actual Mitzo product behavior implemented in TypeScript                           | Mitzo repo only                             | `/resume`, `/skills`, `/mcp` |
| **Plugin**         | Future code extension point for Mitzo itself                                      | External package                            | Not in scope for v1          |

The key point:

- A **quick action** is just a launcher.
- A **skill** is reusable workflow content.
- A **native command** is real application logic.

So no: skills should **not** all live in the Mitzo repo.

The **skill runtime** lives in Mitzo.
The **skill content** can live in Mitzo, in the user scope, or in the target repo.

## Problem

Mitzo currently has one reusable workflow primitive: `quickActions` in `.mitzo.json`, loaded by `server/repo-config.ts` and rendered on the home screen in `frontend/src/pages/SessionList.tsx`.

That works for one-tap shortcuts, but it is too weak to model the kinds of things Claude Code exposes as slash commands:

1. **No reusable command surface.** Quick actions are buttons, not commands. They do not create a durable command vocabulary like `/deploy`, `/review`, or `/jira-triage`.

2. **No arguments.** A quick action can carry a full prompt, but it cannot express a reusable pattern like `/deploy staging` vs `/deploy prod`.

3. **No ownership model.** Today every reusable workflow has to become either:
   - a Mitzo feature, or
   - a repo-specific button.

   That collapses three distinct scopes into one bucket.

4. **No clear boundary between content and product behavior.** Some things should be markdown-defined workflows. Other things require direct app behavior. Without a design, everything gets shoved into prompts or everything gets shoved into TypeScript.

5. **Poor portability.** Repo-specific workflows do not belong in the Mitzo product repo. They belong with the repo they operate on, so they can be reviewed, versioned, and evolved there.

## Design Goal

Add a first-class **skills system** to Mitzo that:

- gives users a slash-command style workflow surface,
- keeps project-specific workflow content with the project,
- preserves Mitzo-owned native commands for app/runtime behaviors,
- reuses the current repo-config model instead of fighting it,
- stays simpler and safer than Claude Code v1.

## Non-Goals

This design does **not** try to ship every Claude Code feature immediately.

Out of scope for v1:

- plugin marketplace
- automatic model-triggered skill invocation
- shell execution inside skill markdown
- subagent/fork execution from skills
- scheduling/orchestration heavy commands like `/batch`
- a new permission model that bypasses Mitzo's existing HITL rules

## Core Decision

Mitzo should separate **runtime**, **content**, and **ownership**.

### Runtime

Mitzo owns:

- skill discovery
- slash-command parsing
- registry merging
- UI picker and skill browser
- prompt rendering
- permission enforcement
- native command execution

### Content

Skills are markdown files with frontmatter plus instructions.

Mitzo renders them into prompts at send time.

### Ownership

Skills can come from three content scopes:

1. **Bundled**: shipped with Mitzo
2. **User**: reusable across repos
3. **Repo**: versioned with the target repo

Native commands remain a fourth category, but they are not content files.

## Why Repo-Local Skills Exist

This is the part that tends to feel odd at first.

Why not just keep all skills in the Mitzo repo?

Because most workflows are not product features. They are project behavior.

Example:

- `/deploy staging` for Mitzo itself belongs in the Mitzo repo
- `/refresh-okrs` for `mgmt` belongs in `mgmt`
- `/prepare-release-note` for some other repo belongs there instead

If everything lives in Mitzo:

- Mitzo becomes a dumping ground for repo-specific workflows
- changing a repo workflow requires a Mitzo release
- switching repos shows irrelevant commands
- repo teams cannot review workflow changes in their own PRs

That is the wrong ownership model.

## Scope Model

Mitzo loads commands from four categories:

| Category  | Kind               | Owner        | Versioned with | Can be overridden?                   |
| --------- | ------------------ | ------------ | -------------- | ------------------------------------ |
| `native`  | TypeScript handler | Mitzo        | Mitzo repo     | No, reserved names                   |
| `bundled` | Skill file         | Mitzo        | Mitzo repo     | Yes, by repo/user skill of same name |
| `user`    | Skill file         | User         | User home dir  | Yes, by repo skill of same name      |
| `repo`    | Skill file         | Current repo | Current repo   | Highest skill precedence             |

Resolution order for `/name`:

1. Native command
2. Repo skill
3. User skill
4. Bundled skill

This preserves Mitzo-owned reserved behaviors while letting the repo define its own local workflows.

### Collision behavior

When multiple skills share the same name, Mitzo should:

1. resolve deterministically by precedence
2. keep all colliding definitions in the registry metadata
3. tell the user that a collision exists

Example:

- `repo:/deploy`
- `user:/deploy`
- `bundled:/deploy`

Invocation of `/deploy staging` should use the repo skill automatically, but the UI should surface that the repo skill shadows the others.

Required UX:

- slash picker shows the winning entry plus a collision note
- `/skills deploy` shows every definition and its source
- invocation emits a small local notice like `Using repo skill deploy; user and bundled versions also exist`

## Directory Layout

### Built-in skills

```text
~/tools/mitzo/skills/
  review/
    SKILL.md
  explain-code/
    SKILL.md
```

### User-global skills

```text
~/.mitzo/skills/
  deploy/
    SKILL.md
  release-check/
    SKILL.md
```

### Repo-local skills

```text
<repo>/.mitzo/skills/
  jira-triage/
    SKILL.md
  deploy/
    SKILL.md
```

This intentionally mirrors the mental model of Claude Code skills without making Mitzo dependent on Claude's directory names.

Bundled skills are just first-party skill files shipped in the Mitzo repo. In v1 they are still markdown prompt packages, not embedded code, shell scripts, or mini-plugins.

## Discovery and Loading

Mitzo should separate **discovery**, **registry metadata**, and **model context**.

### `cwd` decides repo-local scope

Repo-local skills should be resolved from the active session `cwd` or worktree, not just the server's base `REPO_PATH`.

That means:

- a session in the main repo sees that repo's `.mitzo/skills/`
- a session in a worktree sees the worktree's repo-local skills
- a session launched from a subdirectory still resolves against that repo root

`REPO_PATH` remains the default starting point, but it should not be the hardcoded source of truth once a session has a concrete `cwd`.

### Lazy loading

Mitzo should not scan and load all skill bodies at server boot.

Instead:

- skill metadata is discovered on demand when needed for UI or resolution
- full `SKILL.md` content is only read when the user explicitly invokes that skill
- no skill content is injected into the model unless the user calls it

This keeps startup cheap and preserves the mental model that skills are explicit tools, not ambient context.

### Practical caching

Mitzo can cache discovered metadata by resolved repo root plus source scope, with simple invalidation on mtime change or explicit refresh.

That gives the best of both worlds:

- no boot-time eager loading
- fast slash picker after first lookup
- correct behavior when switching `cwd` or worktrees

## Skill Format

Mitzo skills should use a markdown file with YAML frontmatter.

Example:

```yaml
---
name: deploy
description: Deploy this project to an environment
argument-hint: [environment]
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(git status)
  - Bash(npm test)
---

Deploy $ARGUMENTS for this repo.

Required flow:
1. Read repo instructions first
2. Validate current branch and status
3. Run required tests
4. Summarize the planned deployment
5. Wait for explicit approval before any mutation
```

### Supported v1 frontmatter

| Field           | Purpose                                                    | Notes                             |
| --------------- | ---------------------------------------------------------- | --------------------------------- |
| `name`          | Slash command name                                         | Defaults to directory name        |
| `description`   | Short command description                                  | Shown in picker                   |
| `argument-hint` | UI hint for expected args                                  | Example: `[environment]`          |
| `allowed-tools` | Optional restriction on tools usable while skill is active | Restrictive only, never expansive |
| `paths`         | Optional future path scoping                               | Parsed but not required for v1 UX |

There is intentionally no `manual-only` or `disable-model-invocation` field in v1.

Reason: Mitzo v1 does not auto-invoke skills at all. Every skill is explicit-only by design. If Mitzo later adds auto-suggestion or Claude compatibility, it can introduce a compatibility layer then.

### Important constraint

In Mitzo v1, skill files are **prompt packages**, not executable code.

That means:

- no inline shell execution from markdown
- no hidden code hooks
- no custom JavaScript per skill
- no permission bypass just because a skill asked for it

This is deliberate. Claude Code supports more here, but that surface is exactly where trust gets muddy.

## Execution Model

### What happens when the user types a slash command

If the user sends:

```text
/deploy staging
```

Mitzo does **not** call a separate "skill runtime process."

Instead:

1. The server parses the first token as `/deploy`
2. The registry resolves `deploy` to a native command or skill
3. If it is a skill, Mitzo renders the skill body with substitutions
4. Mitzo wraps that rendered content as the actual user prompt
5. The chat session proceeds normally through the existing `startChat()` / `sendToChat()` flow

So the simplest mental model is:

> A skill is a structured prompt expansion step before the model sees the message.

### Example rendered prompt

Input:

```text
/deploy staging
```

Rendered prompt sent to the model:

```text
[Mitzo skill: deploy]
Source: repo
Arguments: staging

Deploy staging for this repo.

Required flow:
1. Read repo instructions first
2. Validate current branch and status
3. Run required tests
4. Summarize the planned deployment
5. Wait for explicit approval before any mutation
```

The response still streams back through the existing chat pipeline. Nothing special changes in the transport.

## Native Commands vs Skills

Not everything should be a skill.

Use a **native command** when the behavior is primarily about Mitzo itself:

- browsing skills
- resuming sessions
- toggling runtime features
- inspecting MCP server config
- opening hook configuration UI
- stateful scheduled loops

Use a **skill** when the behavior is primarily "give the model a reusable workflow prompt."

### Recommended native commands

These should be implemented in TypeScript, not markdown:

- `/skills` — browse available commands/skills
- `/resume` — open or search past sessions
- `/mcp` — inspect configured MCP servers
- `/hooks` — view configured Mitzo hooks once that system exists
- `/loop` — only if it includes real scheduler/state behavior

### Recommended bundled skills

Bundled skills should be:

- cross-repo, not tied to one codebase's workflow
- mostly model-driven, not runtime-driven
- low-assumption about external tools and CI providers
- useful from a phone-sized UI
- safe by default, ideally analysis-first rather than mutation-first

Good first bundled skills for the initial pack are:

- `/simplify`
- `/risk-scan`
- `/pr-review`

Good follow-on bundled skills are:

- `/explain-code`
- `/trace-flow`

These are content-heavy, model-driven, and do not need custom Mitzo runtime behavior.

### What bundled skills should not be

Bundled skills should not be:

- repo-specific workflows like `/jira-triage` or `/refresh-okrs`
- deployment commands like `/deploy prod`
- stateful runtime features like `/loop`
- wrappers that depend on embedded shell execution in markdown
- commands whose main value comes from Mitzo owning UI, scheduler, or session state

That boundary keeps bundled skills clean:

- if it is reusable workflow content, it can be a bundled skill
- if it is product behavior, it should be a native command

## Permission Model

This is a critical design boundary.

Skills must **not** become a side door around Mitzo permissions.

### Rule

`allowed-tools` can only **restrict** the effective tool set for that skill.

It cannot expand permissions beyond the current session mode.

Effective tools are:

```text
effective = session_mode_tools
          ∩ skill_allowed_tools (if present)
          ∩ existing policy gates
```

Examples:

- In `ask` mode, a skill cannot grant shell access
- In `agent` mode, a skill can choose to be read-only
- In `auto` mode, a skill still cannot bypass unknown-tool prompts

This keeps the security model understandable:

- session mode defines the ceiling
- skills can narrow the surface
- native policy still decides prompts and denials

## UI Model

### Slash picker

When the user types `/` in the chat input:

- show merged registry entries
- show a type badge: `native`, `repo`, `user`, `bundled`
- show description and argument hint
- prefer repo-local entries near the top

### Skill browser

Mitzo should expose a simple skill browser view, either:

- as a dedicated page, or
- first via `/skills`

The browser should answer:

- what commands exist
- where they came from
- what they do
- whether they are native or skill-based

This matters because phone UX needs discoverability more than raw power.

### Quick actions

Quick actions should stay.

But they should evolve from "store a big opaque prompt" to "launch a command cleanly."

Example:

```json
{
  "label": "Deploy staging",
  "desc": "Run deploy workflow for staging",
  "prompt": "/deploy staging"
}
```

That gives quick actions a better substrate without removing the existing home-screen UX.

## API / Runtime Changes

### New server module

Add `server/skills.ts`:

Responsibilities:

- discover built-in, user, and repo skills lazily
- parse frontmatter
- merge registry by precedence
- resolve `/name` lookups
- render prompt expansions with arguments
- preserve collision metadata for UI

### New HTTP route

Add `GET /api/skills`:

- optional `cwd` parameter
- returns merged registry for the current repo context
- used by slash picker and future `/skills` browser
- returns collision info, not just winning entries

### Chat send path

Before `startChat()` / `sendToChat()` enqueue the prompt:

1. inspect the outgoing text
2. if not slash-prefixed, send as normal
3. if slash-prefixed, resolve through the skill/native registry
4. execute native command or render skill
5. continue through the current chat flow

This keeps the skills feature additive rather than rewriting the session transport.

## Compatibility With Claude Code Skills

There are two different compatibility questions:

1. **Conceptual compatibility** — should Mitzo use the same general idea?
2. **File compatibility** — should Mitzo read `.claude/skills/*` directly?

The answer to the first is **yes**.

The answer to the second is **not in v1 by default**.

### Why not read `.claude/skills` immediately

Because that drags in extra semantics too early:

- shell preprocessing
- more fields than Mitzo needs initially
- ambiguity about ownership between Mitzo and Claude Code
- risk of silently executing workflows the user did not design for Mitzo

### Better approach

Mitzo should define its own canonical path:

- `.mitzo/skills/`

But keep the file format intentionally close enough that future import/compatibility is cheap.

Possible future extension:

- optional read-only import of `.claude/skills/`
- explicit UI toggle
- clear source badge (`claude-import`)

## Rollout Plan

### Phase 1: Manual skills foundation

Ship:

- skill registry loader
- slash picker
- bundled + user + repo skill discovery
- native command registry
- prompt rendering with `$ARGUMENTS`
- `allowed-tools` as restriction-only
- `/skills` native command

Do **not** ship yet:

- auto-invocation
- shell expansion in skill files
- subagent execution
- `.claude/skills` import

### Phase 2: Better UX

Ship:

- dedicated skill browser
- source badges everywhere
- quick actions that point to slash commands cleanly
- duplicate-name disambiguation UI if needed

### Phase 3: Advanced capabilities

Consider:

- path-based suggestion/loading
- optional auto-suggestion
- forked/subagent skill execution
- controlled `.claude/skills` compatibility

## Example End State

Repo config:

```text
mgmt/
  .mitzo.json
  .mitzo/
    skills/
      jira-triage/
        SKILL.md
      eod-summary/
        SKILL.md
```

Home screen:

- quick action "Morning triage"

Quick action payload:

```json
{
  "label": "Morning triage",
  "desc": "Start Jira triage workflow",
  "prompt": "/jira-triage today"
}
```

Chat input:

```text
/jira-triage today
```

Mitzo behavior:

- resolves repo-local skill
- renders structured workflow prompt
- sends it through the normal session pipeline
- preserves current mode/permission ceiling

That is the architecture in one line:

> Quick actions launch commands. Skills define reusable workflows. Native commands own real Mitzo behavior.

## Remaining Open Questions

1. Should bundled skills ship in the first implementation, or should v1 land native commands plus repo/user skills first and add bundled skills immediately after?
2. What is the best cache invalidation strategy for skill metadata: mtime polling, explicit refresh, or both?
3. Should `/skills <name>` be a chat-native view first, or should Mitzo prioritize a dedicated browser page immediately?

## Recommendation

Build this in the smallest useful shape:

- native commands for Mitzo-owned behavior
- markdown skills for reusable workflows
- multi-scope loading from day one
- repo-local ownership as a first-class concept
- no shell execution inside skills in v1

That gives Mitzo the same **product shape** as Claude Code commands without importing the messier parts of Claude Code's execution model too early.
