# Briefing API — Design Spec

## Status: Draft (captured 2026-04-19)

## Problem

The morning briefing currently runs as a Python script (`command_center/morning_briefing.py`) that outputs a markdown file to `command_center/briefings/`. The only way to consume it in Mitzo is by sending a prompt to Claude that runs the script via Bash — resulting in a wall of text in a chat bubble.

The BriefingCard UI shell exists on the home page (PR #TBD, `feat/mobile-ui-redesign`) but has no data source.

## Goal

A structured briefing API that the BriefingCard can fetch, with modular sections the user can configure.

## Architecture

```
morning_briefing.py (launchd, 7AM weekdays)
  │
  └──→ command_center/briefings/YYYY-MM-DD.md
         │
         ├──→ GET /api/briefing/latest  (server parses → JSON)
         │      │
         │      └──→ BriefingCard (frontend fetches on mount)
         │
         └──→ POST /api/briefing/run    (triggers script, returns when done)
                │
                └──→ "Run Briefing" button in BriefingCard
```

## API

### `GET /api/briefing/latest`

Returns the most recent briefing, parsed into sections.

```json
{
  "date": "2026-04-19",
  "generatedAt": "2026-04-19T07:00:12Z",
  "sections": [
    {
      "key": "calendar",
      "label": "Calendar",
      "summary": "3 meetings today. First at 10:00 — AAETI standup.",
      "items": [
        { "time": "10:00", "title": "AAETI Standup", "attendees": 8 },
        { "time": "14:00", "title": "1:1 with Catherine", "attendees": 2 },
        { "time": "16:00", "title": "OKR Review", "attendees": 12 }
      ]
    },
    {
      "key": "email",
      "label": "Email",
      "summary": "12 unread, 3 flagged. 1 from Catherine re: staffing.",
      "items": []
    },
    {
      "key": "jira",
      "label": "Jira",
      "summary": "2 blockers, 5 PRs awaiting review.",
      "items": []
    },
    {
      "key": "slack",
      "label": "Slack",
      "summary": "No significant signals overnight.",
      "items": []
    }
  ]
}
```

### `POST /api/briefing/run`

Triggers the morning briefing script. Returns 202 immediately, or waits and returns 200 with the parsed result.

### `GET /api/briefing/config`

Returns the user's section preferences (which sections are enabled, order).

### `PUT /api/briefing/config`

Updates section preferences. Stored in `.mitzo.json` or a dedicated `briefing-config.json`.

## Server Implementation

1. Add `briefing.ts` route module in `server/`
2. Parse the markdown briefing file — the current format has `## Calendar`, `## Email`, etc. as section headers
3. Extract a one-line summary per section (first paragraph or a heuristic)
4. Extract structured items where possible (calendar events, email subjects)
5. Return as JSON

## Frontend Implementation

1. `BriefingCard` calls `GET /api/briefing/latest` on mount
2. Populates section summaries from the response
3. "Start Session" injects the full briefing as context into a new chat
4. "Run Briefing" calls `POST /api/briefing/run` and refreshes
5. Section toggles stored in localStorage, synced to server config

## Modular Sections (Future)

Each section could be a plugin:

- Calendar: `gws calendar` data
- Email: `gws inbox` data
- Jira: parquet snapshot or live query
- Slack: `slack_observe/` signals
- PRs: GitHub PR status across repos
- Agents: `mgmt_lib/agents/` journal summaries

Users configure which sections appear and in what order.

## Context Injection (Future)

"Start Session" should compile the briefing sections into a structured context block that gets injected into the Claude session's system prompt — not just as a user message. This gives Claude the full day's context before the first prompt.

## Dependencies

- `gws` CLI (already installed, used by morning_briefing.py)
- `command_center/briefings/` directory (already exists, populated by launchd)
- Jira parquet data (already in `jira_process/data/`)
