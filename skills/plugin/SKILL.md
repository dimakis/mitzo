---
description: "Manage skill marketplaces — browse, install, and remove plugins"
mutating: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - AskUserQuestion
---

You are a plugin manager for Mitzo skills. Parse `$ARGUMENTS` and execute the matching subcommand below.

## Config Paths

- **Marketplace registry**: `~/.mitzo/plugins/config.json`
- **Installed plugins**: `~/.mitzo/plugins/installed.json`
- **Skills install target**: `~/.mitzo/skills/`

Create `~/.mitzo/plugins/` on first use if it does not exist.

## Subcommands

### No arguments → Status overview

Show registered marketplaces (from `config.json`) and installed plugins (from `installed.json`). If nothing is configured, show a quick-start guide:

```
No marketplaces registered. Get started:
  /plugin marketplace add opendatahub-io/skills-registry
  /plugin browse
  /plugin install rfe-creator@opendatahub-skills
```

### `marketplace add <owner/repo>`

Register a GitHub repo as a marketplace source.

1. Validate the repo exists and contains `registry.yaml`:
   ```bash
   gh api repos/<owner/repo>/contents/registry.yaml --jq '.name' 2>&1
   ```
2. Fetch and parse `registry.yaml` to extract the marketplace `name`:
   ```bash
   gh api repos/<owner/repo>/contents/registry.yaml --jq '.content' | base64 -d
   ```
3. Read existing `config.json` (or start with `{"marketplaces":[]}`)
4. Add entry: `{name, repo: "<owner/repo>", addedAt: ISO timestamp}`
5. Write updated `config.json`
6. Report success with the marketplace name and plugin count

### `marketplace list`

Read `config.json` and display registered marketplaces.

### `marketplace remove <name>`

Remove a marketplace by name from `config.json`. Warn if plugins from that marketplace are still installed.

### `browse [marketplace-name]`

Fetch `registry.yaml` from each registered marketplace (or a specific one) and display available plugins.

1. Read `config.json` for marketplace repos
2. For each marketplace:
   ```bash
   gh api repos/<repo>/contents/registry.yaml --jq '.content' | base64 -d
   ```
3. Parse the YAML `plugins` list. For each plugin show:
   - Name, description, version, category, author
   - Skill count and skill names
   - Whether it's already installed (check `installed.json`)
4. Group by category for readability

### `install <name>@<marketplace-name>`

Download a plugin's skills from its source repo into `~/.mitzo/skills/`.

1. Read `config.json` → find the marketplace by name → get its repo
2. Fetch `registry.yaml` from the marketplace repo:
   ```bash
   gh api repos/<marketplace-repo>/contents/registry.yaml --jq '.content' | base64 -d
   ```
3. Find the plugin entry by name. Extract:
   - `source.repo` — the GitHub repo containing the skills
   - `source.ref` — the git ref (default: `main`)
   - `skills_dir` — subdirectory containing skills (default: `.claude/skills`)
4. List skill directories in the source repo:
   ```bash
   gh api repos/<source-repo>/contents/<skills_dir>?ref=<ref> --jq '.[].name'
   ```
5. For each skill directory, list its files:
   ```bash
   gh api repos/<source-repo>/contents/<skills_dir>/<skill-name>?ref=<ref> --jq '.[] | "\(.name)\t\(.download_url)"'
   ```
6. Download each file and write to `~/.mitzo/skills/<skill-name>/`:
   ```bash
   mkdir -p ~/.mitzo/skills/<skill-name>
   curl -sL "<download_url>" -o ~/.mitzo/skills/<skill-name>/<filename>
   ```
7. Update `installed.json` with:
   ```json
   {
     "name": "<plugin-name>",
     "marketplace": "<marketplace-name>",
     "sourceRepo": "<source-repo>",
     "ref": "<ref>",
     "version": "<version from registry>",
     "skills": ["<skill-name-1>", "<skill-name-2>"],
     "installedAt": "<ISO timestamp>"
   }
   ```
8. Report installed skills. They are immediately available — the file watcher auto-reloads.

**Important**: If the plugin has `depends_on` entries in the registry, warn the user and suggest installing dependencies first.

### `remove <plugin-name>`

Remove an installed plugin.

1. Read `installed.json` → find the plugin → get its skill list
2. **Validate each skill name**: reject any name containing `/`, `..`, or path separators. Only delete directories directly inside `~/.mitzo/skills/`.
3. Delete each skill directory:
   ```bash
   rm -rf ~/.mitzo/skills/<skill-name>
   ```
4. Remove the plugin entry from `installed.json`
5. Report removed skills

### `update [plugin-name]`

Re-install a plugin (or all plugins) to get the latest version.

1. Read `installed.json` → get plugin(s) to update
2. For each: re-run the install flow (step 4-7 from `install`)
3. Update the version and `installedAt` in `installed.json`
4. Report what changed

## Error Handling

- If `gh` is not available, tell the user to install GitHub CLI
- If a marketplace repo is not accessible, report the error clearly
- If a plugin name is not found in the registry, show available plugins as suggestions
- If skills already exist from a different plugin, warn about conflicts before overwriting

## Output Style

Keep output concise. Use markdown tables for listings. Show progress during install (which skill is being downloaded).
