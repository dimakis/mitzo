# Session Isolation

Every Mitzo session gets deterministic isolation via git worktrees. Each session operates on its own branch in its own directory, preventing cross-session contamination.

## How It Works

When a new session starts with isolation enabled:

1. **Worktree creation** -- `createSessionWorktrees()` creates a git worktree for the primary repo and every repo listed in `.mitzo.json`
2. **Branch creation** -- each worktree gets a dedicated branch: `session/<session-id>`
3. **Path setup** -- worktree paths are injected into the system prompt so the agent knows where to work
4. **Env vars** -- `MITZO_SESSION_ID` and `MITZO_REPO_<NAME>` are set for every repo

### Paths and Branches

| Item              | Pattern                                                 |
| ----------------- | ------------------------------------------------------- |
| Worktree path     | `<repo>/.claude/worktrees/<session-id>/`                |
| Branch name       | `session/<session-id>`                                  |
| Primary env var   | `MITZO_REPO_PRIMARY`                                    |
| Secondary env var | `MITZO_REPO_<NAME>` (uppercase, hyphens to underscores) |

### Multi-Repo

When `.mitzo.json` declares secondary repos, all of them get worktrees at session start:

```json
{
  "repos": {
    "mitzo": "/Users/you/tools/mitzo",
    "team-home": "/Users/you/redhat/team_home",
    "centaur": "/Users/you/projects/centaur"
  }
}
```

This creates four worktrees per session: one for the primary repo (`REPO_PATH`) and one for each secondary repo. The agent can work across all of them in a single session.

## Write Enforcement

The worktree guard (`checkWorktreePolicy()` in `@mitzo/harness`) inspects every tool call that could modify files:

| Tool    | Checked | What's Inspected                            |
| ------- | ------- | ------------------------------------------- |
| `Write` | Yes     | `file_path` parameter                       |
| `Edit`  | Yes     | `file_path` parameter                       |
| `Bash`  | Yes     | Command string (path extraction heuristics) |
| `Read`  | No      | Read operations are unrestricted            |
| `Glob`  | No      | Read operations are unrestricted            |
| `Grep`  | No      | Read operations are unrestricted            |

If a write target falls outside the session's worktree directories, the tool call is **denied** with a redirect message telling the agent the correct worktree path. The agent self-corrects. No user prompt, no approval flow.

### Enforcement by Client

| Client      | Enforcement          | Mechanism                                    |
| ----------- | -------------------- | -------------------------------------------- |
| Mitzo       | Programmatic deny    | `checkWorktreePolicy()` in `canUseTool`      |
| Claude Code | cwd + system prompt  | `SessionStart` hook sets working directory   |
| Cursor      | Advisory + git guard | `alwaysApply` rule + pre-commit rejects main |

### System Prompt Injection

`buildWorktreeSystemPrompt()` generates a lookup table of all repo paths for the agent:

```
## Session Worktrees
Session ID: 2026-07-01-abc123

- **primary (cwd)**: /path/to/repo/.claude/worktrees/2026-07-01-abc123
- **mitzo**: /path/to/mitzo/.claude/worktrees/2026-07-01-abc123
- **team-home**: /path/to/team_home/.claude/worktrees/2026-07-01-abc123
```

This ensures the agent knows the exact paths without guessing.

## External Hooks

Mitzo creates worktrees for Claude Code and Cursor sessions too, not just its own.

### How It Works

1. On startup, Mitzo generates an internal token and persists it to `~/.mitzo/internal-token`
2. A `SessionStart` hook in your repo's `.claude/hooks/` or `.cursor/hooks/` reads this token
3. The hook calls `POST /api/sessions` with the internal token
4. The server creates worktrees for all configured repos and returns the paths
5. Claude Code/Cursor sessions get the same isolation as Mitzo sessions

### Claude Code Hook

```bash
#!/bin/bash
# .claude/hooks/session-isolate.sh
TOKEN=$(cat ~/.mitzo/internal-token 2>/dev/null)
if [ -z "$TOKEN" ]; then exit 0; fi

RESPONSE=$(curl -s -X POST http://localhost:3100/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $TOKEN" \
  -d '{"source": "claude-code"}')

if [ $? -eq 0 ]; then
  CWD=$(echo "$RESPONSE" | jq -r '.worktrees.primary // empty')
  if [ -n "$CWD" ]; then
    echo "{\"cwd\": \"$CWD\"}"
  fi
fi
```

### Cursor Hook

Similar pattern, but outputs `agent_message` with all worktree paths for the system prompt.

## Cleanup

### Automatic Cleanup

Stale worktrees (older than 96 hours) are cleaned up automatically on server startup. The cleanup scans both `.claude/worktrees/` and `.cursor/worktrees/` directories in all configured repos.

### Dirty Worktree Handling

Worktrees with uncommitted changes are **not** deleted during cleanup. Instead:

1. The cleanup process detects uncommitted work
2. Creates a commit with the uncommitted changes
3. Creates a draft PR from the session branch
4. Flags the worktree in the mgmt inbox for human review
5. Then removes the worktree directory

This prevents losing work from sessions that were interrupted before the agent could commit.

### Manual Cleanup

```bash
# Via the mgmt CLI (if using mgmt workspace)
./mgmt session cleanup [session-id]

# Or manually
git worktree list                    # see all worktrees
git worktree remove <path>           # remove a specific worktree
git branch -d session/<session-id>   # delete the session branch
```

## Session Index

Mitzo maintains a YAML session index at `<repo>/.claude/sessions/index.yaml`. This tracks:

- Active and closed sessions
- Worktree paths per repo
- Session metadata (title, creation time, last activity)

The index is useful for finding prior session work without grepping through worktree directories.

## Configuration

### Enabling/Disabling

Set `WORKTREE_ENABLED=false` in `.env` to disable isolation entirely. Sessions work directly on the main repo. This is the kill switch.

### Skipping Worktree Creation

Sessions with explicit `cwd` or `resume` parameters skip worktree creation. This allows:

- Resuming an existing session in its original worktree
- Starting a session in a specific directory (e.g., a quick action with a `cwd` override)

### Data Files

Worktrees are lightweight git checkouts. They don't include:

- `.venv/` (Python virtual environments)
- Parquet data files
- `node_modules/` (uses the main repo's copy via npm workspace resolution)
- Any gitignored files

This is expected. The agent works with code, not data artifacts.

## Troubleshooting

| Problem                    | Fix                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Worktree creation fails    | Run `git worktree list` in the failing repo to check for conflicts                       |
| Stale worktrees piling up  | Run `git worktree prune` then restart Mitzo (auto-cleanup runs on start)                 |
| Agent writes to wrong path | Check that the system prompt includes worktree paths (should be automatic)               |
| Branch already exists      | A prior session with the same ID left a branch. Delete with `git branch -d session/<id>` |
| npm/node_modules missing   | Expected in worktrees. Symlink or use the main repo's packages                           |
| Data files missing         | Expected. Worktrees only contain tracked files                                           |
