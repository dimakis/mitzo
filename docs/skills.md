# Skills System

Skills are reusable prompt packages invoked via `/slash-command` in the chat input. They provide a way to package common workflows, enforce tool restrictions, and share prompt templates across repos.

## Using Skills

Type `/` in the chat input to see all available skills. The `SlashPicker` component shows skill names, descriptions, source badges, and collision notes.

```
/simplify          -- reduce complexity and duplication
/risk-scan         -- failure modes, missing tests, unsafe assumptions
/pr-review         -- review a pull request
/person            -- people profile lookup and update
/review-response   -- triage and fix PR review comments
/land-pr           -- shepherd a PR from open to merged
/pr-shepherd       -- persistent PR lifecycle monitoring
```

Skills can accept arguments:

```
/pr-review 42              -- review PR #42
/person akram              -- look up Akram's profile
/pr-shepherd mitzo#350     -- monitor PR #350 in the mitzo repo
```

## Bundled Skills

Mitzo ships with these skills in the `skills/` directory:

| Skill              | Description                                                                        | Arguments        |
| ------------------ | ---------------------------------------------------------------------------------- | ---------------- |
| `/simplify`        | Code review focused on reducing complexity, duplication, and cleanup opportunities | None             |
| `/risk-scan`       | Security-oriented audit -- failure modes, missing tests, unsafe assumptions        | None             |
| `/pr-review`       | Review a pull request -- diff analysis, code quality, architecture alignment       | PR number or URL |
| `/person`          | People profile lookup and update                                                   | Person name      |
| `/review-response` | Triage and fix PR review comments                                                  | PR number or URL |
| `/land-pr`         | Land a PR -- rebase, squash, merge                                                 | PR number or URL |
| `/pr-shepherd`     | Persistent PR lifecycle monitoring -- conflicts, CI, reviews, merge-readiness      | repo#number      |

## Custom Skills

Create your own skills by adding markdown files with YAML frontmatter.

### Skill file format

```markdown
---
name: deploy
description: Deploy to staging or production
allowed-tools: [Bash, Read]
arguments:
  - name: environment
    description: Target environment (staging or production)
    required: true
  - name: branch
    description: Branch to deploy
    required: false
---

Deploy the application to the {{environment}} environment.

{{#if branch}}
Deploy from the {{branch}} branch.
{{/if}}

Run the deployment script and report the result.
Include the deployment URL in your response.
```

### Frontmatter fields

| Field           | Type       | Required | Description                              |
| --------------- | ---------- | -------- | ---------------------------------------- |
| `name`          | `string`   | Yes      | Skill name (used as `/name` command)     |
| `description`   | `string`   | Yes      | One-line description shown in the picker |
| `allowed-tools` | `string[]` | No       | Tool restriction ceiling (see below)     |
| `arguments`     | `array`    | No       | Named arguments with descriptions        |

### Arguments

Each argument has:

| Field         | Type      | Required | Description                                         |
| ------------- | --------- | -------- | --------------------------------------------------- |
| `name`        | `string`  | Yes      | Argument name                                       |
| `description` | `string`  | Yes      | Description shown in help                           |
| `required`    | `boolean` | No       | Whether the argument is required (default: `false`) |

Arguments are injected into the skill body via `{{argument_name}}` template syntax. Positional arguments map to the declared order.

## Discovery Scopes

Skills are discovered from three locations, in precedence order:

```
1. Repo-local:  <REPO_PATH>/.mitzo/skills/*.md
2. User:        ~/.mitzo/skills/*.md
3. Bundled:     <mitzo>/skills/*.md
```

### Precedence Rules

When skills from different scopes share the same name, the highest-precedence scope wins:

1. **Native commands** (TypeScript) -- highest precedence. Currently: `/skills`.
2. **Repo-local** -- skills in your project's `.mitzo/skills/` directory.
3. **User** -- skills in `~/.mitzo/skills/` (available in all repos).
4. **Bundled** -- skills shipped with Mitzo.

The `/` picker shows collision notes when a skill shadows another. For example, if you have a repo-local `/simplify` that shadows the bundled one, the picker will note "overrides bundled".

## Tool Restrictions

The `allowed-tools` frontmatter field enforces a ceiling on what tools Claude can use during the skill's execution:

```yaml
allowed-tools: [Read, Glob, Grep]
```

This means Claude can **only** use Read, Glob, and Grep during this skill -- even if the user is in Auto mode. The restriction never expands permissions beyond the current mode. It is enforced by `skill-policy.ts` via the `canUseTool` callback.

If `allowed-tools` is not specified, the skill uses the mode's default permissions.

## API

### GET /api/skills

Returns the merged skill registry with collision metadata.

**Query parameters:**

| Parameter | Type     | Description                                 |
| --------- | -------- | ------------------------------------------- |
| `cwd`     | `string` | Working directory for repo-scoped discovery |

**Response:** Array of skill objects with `name`, `description`, `source` (scope), and collision information.

## Adding Skills to Your Repo

1. Create `.mitzo/skills/` in your repo root
2. Add markdown files with the frontmatter format above
3. Skills appear immediately in the `/` picker -- no restart needed

Example: a deployment skill for your project:

```markdown
---
name: deploy
description: Deploy to production
allowed-tools: [Bash, Read]
---

Deploy the application:

1. Run `npm run build`
2. Run `npm run deploy`
3. Verify the deployment succeeded
4. Report the deployment URL
```

Example: a code review skill with restricted tools:

```markdown
---
name: audit
description: Security audit of recent changes
allowed-tools: [Read, Glob, Grep]
---

Audit the most recent commit for security issues:

1. Read the diff with `git diff HEAD~1`
2. Check for hardcoded secrets, SQL injection, XSS
3. Report findings with severity ratings
```

## Native Commands

Native commands are TypeScript-implemented commands that bypass the prompt system entirely. Currently:

- `/skills` -- lists all available skills with their sources and collision info

Native commands always take precedence over prompt-based skills.
