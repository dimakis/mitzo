# Mitzo Onboarding

Get Mitzo running on your Mac in a single Cursor session. By the end of this guide you'll have Claude Code accessible from your phone.

## What is Mitzo?

Mitzo is a self-hosted web UI for Claude Code. You run it on your laptop, access it from your phone over Tailscale. It gives you:

- **Streaming chat** with Claude Code (thinking blocks, tool use, markdown)
- **Three modes** — Ask (read-only), Agent (file edits), Auto (shell access)
- **File browser** — view and edit repo files from your phone
- **Slash-command skills** — reusable workflows like `/simplify`, `/risk-scan`, `/pr-review`
- **Session persistence** — phone sleeps, session survives, resume where you left off
- **Quick actions** — one-tap commands customized per repo

It's built on the [Anthropic Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) — same engine as Claude Code, different interface.

## Prerequisites

Run these checks in your Cursor terminal to confirm you have what you need:

```bash
# Node.js 20+ required
node --version

# npm comes with Node
npm --version

# Git (you definitely have this)
git --version

# Claude Code CLI — Mitzo uses this under the hood
claude --version
```

**If you're missing anything:**

| Tool        | Install                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| Node.js 20+ | `brew install node@22` or [nodejs.org](https://nodejs.org)               |
| Claude Code | `npm install -g @anthropic-ai/claude-code` then `claude` to authenticate |

You also need an active Claude Code subscription (Claude Max or API key) — the Agent SDK authenticates through the same credentials as `claude` CLI.

## Step 1: Clone and install

```bash
cd ~/tools  # or wherever you keep personal tools
git clone https://github.com/dimakis/mitzo.git
cd mitzo

# Install backend dependencies
npm install

# Install frontend dependencies
cd frontend && npm install && cd ..
```

## Step 2: Configure environment

```bash
cp .env.example .env
```

Open `.env` and set these three required values:

```
AUTH_PASSPHRASE=pick-something-memorable
AUTH_SECRET=any-random-string-at-least-32-characters-long
REPO_PATH=/absolute/path/to/your/main/repo
```

| Variable          | What it does                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PASSPHRASE` | The password you'll type to log in from your phone                                                                                                                                                                                                                                                       |
| `AUTH_SECRET`     | JWT signing key — any random string, 32+ chars. Generate one with `openssl rand -hex 32`                                                                                                                                                                                                                 |
| `REPO_PATH`       | The default repo for Claude sessions (absolute path). This is where Claude starts — file browser, quick actions, and new chats all default to this directory. Pick the repo you work in most. If you work across multiple repos, you'll configure `roots` in `.mitzo.json` later to switch between them. |

Leave everything else at defaults for now.

## Step 3: Build and start

```bash
# Build the frontend
npm run build

# Start the server
npm start
```

You should see output like:

```
Mitzo listening on http://localhost:3100
```

Open http://localhost:3100 in your browser. You'll see a login screen — enter your `AUTH_PASSPHRASE`. That's it, Mitzo is running.

## Step 4: Access from your phone (Tailscale)

This is where it gets good. Mitzo is designed for mobile use over [Tailscale](https://tailscale.com) — a zero-config VPN that connects your devices over encrypted WireGuard tunnels.

1. **Install Tailscale** on your Mac: `brew install tailscale` or [tailscale.com/download](https://tailscale.com/download)
2. **Install Tailscale** on your phone (App Store / Play Store)
3. **Sign in** to both with the same account (Google, GitHub, etc.)
4. **Find your Mac's Tailscale IP**: run `tailscale ip -4` in terminal

Now open `http://<your-tailscale-ip>:3100` on your phone. Log in with your passphrase. You're in.

**Tip:** Add it to your phone's home screen — in Safari, tap Share → Add to Home Screen. It behaves like a native app.

## Step 5: Try it out

### Start a chat

Tap **Chat** on the home screen. Type a message. Claude responds with full streaming — thinking blocks collapse, tool use shows as pills, markdown renders inline.

### Switch modes

The mode selector is in the chat header:

| Mode      | What Claude can do                                                 |
| --------- | ------------------------------------------------------------------ |
| **Ask**   | Read files only. Safe for exploration.                             |
| **Agent** | Read + write files. You'll be prompted for permission on writes.   |
| **Auto**  | Full access including shell. Prompts only for elevated operations. |

Start in Ask mode to explore. Switch to Agent when you're ready to make changes.

### Browse files

Tap **Files** to browse your repo. Markdown files have an Edit button — you can make quick edits right from your phone.

### Use skills

Type `/` in the chat input to see available slash commands:

| Skill        | What it does                               |
| ------------ | ------------------------------------------ |
| `/simplify`  | Code review focused on reducing complexity |
| `/risk-scan` | Security-oriented audit                    |
| `/pr-review` | Review a pull request                      |

Skills are extensible — you can add your own (covered below).

## Step 6: Make it persistent (recommended)

Right now Mitzo stops when you close the terminal. To keep it running across reboots:

```bash
# Install pm2 globally
npm install -g pm2

# Start Mitzo via pm2
cd ~/tools/mitzo  # or wherever you cloned it
npm run pm2:start

# Persist across reboots
pm2 save
pm2 startup  # follow the printed instructions
```

Now Mitzo survives terminal closes and system restarts. Manage it with:

```bash
pm2 status          # check if it's running
pm2 logs mitzo      # view logs
pm2 restart mitzo   # restart after config changes
```

## Configuring your repo (`.mitzo.json`)

The `.mitzo.json` file in your repo root is how you teach Mitzo about your workspace. It controls the home screen, what Claude can access, and what domain knowledge gets injected into sessions. Drop this in the repo you set as `REPO_PATH`.

Here's a full example — adapt it to your setup:

```json
{
  "quickActions": [
    {
      "label": "Status Check",
      "desc": "What needs my attention",
      "prompt": "Check the current state of the repo and summarize what needs attention.",
      "extraTools": "Bash"
    },
    {
      "label": "PR Summary",
      "desc": "Open pull requests",
      "prompt": "List open PRs with a one-line summary of each. Flag any that are stale or need review.",
      "extraTools": "Bash"
    }
  ],
  "roots": [
    { "label": "My Repo", "path": "/Users/you/projects/my-repo" },
    { "label": "Other Repo", "path": "/Users/you/projects/other-repo" }
  ],
  "allowedPaths": ["/Users/you/projects"],
  "contextBlocks": {
    "Team Structure": "/Users/you/projects/my-repo/docs/team.md",
    "Architecture": "/Users/you/projects/my-repo/docs/architecture.md"
  },
  "venvPaths": [".venv/bin"]
}
```

### Quick actions

One-tap buttons on the home screen. Each starts a chat with the given prompt.

| Field        | Required | Description                                          |
| ------------ | -------- | ---------------------------------------------------- |
| `label`      | Yes      | Button text                                          |
| `desc`       | Yes      | Subtitle under the button                            |
| `prompt`     | Yes      | The prompt sent to Claude when tapped                |
| `extraTools` | No       | Additional tools to allow (e.g. `"Bash"`)            |
| `cwd`        | No       | Working directory override (relative to `REPO_PATH`) |

Think of these as the things you do repeatedly — status checks, report generation, triage. If you find yourself typing the same prompt more than twice, make it a quick action.

### Roots (multi-repo navigation)

```json
"roots": [
  { "label": "Main", "path": "/Users/you/projects/main-repo" },
  { "label": "Tooling", "path": "/Users/you/projects/tooling" }
]
```

Roots let you switch between repos from the Mitzo file browser without restarting. The first root is your default; the others appear as tabs. Useful if you work across multiple repos.

### Allowed paths

```json
"allowedPaths": [
  "/Users/you/projects",
  "/Users/you/tools"
]
```

By default Claude can only access files under `REPO_PATH`. If you need it to read or write files in other directories (sibling repos, shared tooling, config files), list those paths here. These are additive — `REPO_PATH` is always accessible.

### Context blocks (domain knowledge injection)

```json
"contextBlocks": {
  "Team Structure": "/Users/you/docs/team.md",
  "Workflow": "/Users/you/docs/workflow.md"
}
```

Context blocks are markdown files that get injected into every Claude session as reference material. This is how you give Claude persistent domain knowledge without repeating yourself — org structure, project conventions, Jira workflows, architecture docs.

Each entry is a label (shown in the UI) and an absolute path to a markdown file. The files are read at session start and included as context. They don't need to live in the same repo — they can be anywhere on your filesystem.

Good candidates for context blocks:

- Team structure and responsibilities
- Project architecture overviews
- Workflow docs (how your team uses Jira, Git, etc.)
- `CLAUDE.md` or `CONSTITUTION.md` from repos you work in often

### Python virtual environments

```json
"venvPaths": [".venv/bin"]
```

If your repo uses Python venvs, list the paths (relative to `REPO_PATH`) so Claude sessions have the right Python and packages on `PATH`.

### Custom skills

Create reusable slash commands by adding markdown files:

- **Repo-scoped**: `.mitzo/skills/my-skill.md` (in your repo)
- **User-scoped**: `~/.mitzo/skills/my-skill.md` (available everywhere)

A skill file is markdown with YAML frontmatter:

```markdown
---
name: deploy
description: Deploy to staging or production
allowed-tools: [Bash, Read]
arguments:
  - name: environment
    description: Target environment
    required: true
---

Deploy the application to the {{environment}} environment.
Run the deployment script and report the result.
```

Invoke it with `/deploy staging` in chat.

## MCP integration

Mitzo reads your Cursor MCP config (`~/.cursor/mcp.json`) and passes those servers to every Claude session. If you have Jira, GitLab, or other MCP servers configured in Cursor, they'll be available in Mitzo automatically — no extra setup.

## Push notifications (optional)

Get notified on your phone when Claude needs permission approval:

1. Install [ntfy](https://ntfy.sh) on your phone
2. Pick a topic name (e.g. `mitzo-cat`)
3. Add to `.env`:

```
NTFY_TOPIC=mitzo-cat
```

4. Restart Mitzo (`pm2 restart mitzo`)

Now when Claude hits a permission prompt, you'll get a push notification with a direct link to approve.

## Troubleshooting

| Problem                         | Fix                                                                    |
| ------------------------------- | ---------------------------------------------------------------------- |
| `claude: command not found`     | Install Claude Code: `npm install -g @anthropic-ai/claude-code`        |
| Port 3100 already in use        | Change `PORT` in `.env` or kill the existing process                   |
| Can't connect from phone        | Check Tailscale is running on both devices (`tailscale status`)        |
| Session hangs on start          | Verify `claude` works standalone: run `claude` in terminal             |
| Permission errors on file edits | Switch to Agent or Auto mode (Ask mode is read-only)                   |
| Phone disconnects lose messages | Normal — Mitzo auto-recovers. Messages buffer and replay on reconnect. |

## Updating

When there's a new version:

```bash
cd ~/tools/mitzo
git pull --ff-only origin main
npm install
cd frontend && npm install && cd ..
npm run build
pm2 restart mitzo
```

Or if you've set up pm2, use the deploy script:

```bash
bash ~/tools/mitzo/scripts/deploy.sh
```

## Architecture (if you're curious)

```
Phone (Tailscale) ──┬── HTTP: REST API
                    └── WebSocket: v2 streaming protocol
                        │
                    Your Mac (Node.js + TypeScript)
                        │
                        ├── Anthropic Agent SDK (same engine as Claude Code)
                        ├── Session registry (detach/reattach/recovery)
                        ├── MCP servers from Cursor config
                        └── Passphrase + JWT auth
```

The server translates Agent SDK stream events into a WebSocket protocol the React frontend consumes. Sessions survive disconnects — when your phone reconnects, it picks up where it left off.

## What's next

Once you're comfortable with the basics:

- **Worktree isolation** — toggle "WT" in chat header to sandbox sessions into git worktrees
- **Voice** — push-to-talk input and auto-speak output (requires [Yapper](https://github.com/dimakis/yapper))
- **Image attachments** — send screenshots and photos to Claude from your camera
- **Session history** — swipe left on old sessions to dismiss, tap to resume
