# Token Visibility — Design Document

> **Status:** Draft
> **Author:** Dimitri + Claude
> **Date:** 2026-04-12
> **Depends on:** feat/token-capture (#178), feat/goal-wiring (#179)

## 1. Problem

Mitzo captures token usage (PR #178) and reports to ContexGin's Goal Registry (PR #179), but none of this is visible in the UI. Users can't see:

- How large the current agent's context window is (the 200k ceiling)
- How many tokens the current session has burned across agent reconnects
- How much a goal has cost across all sessions, subagents, and external systems

These are three different numbers answering three different questions.

## 2. Key Distinction: Agent vs Session vs Goal

### Agent

A single Claude API conversation. Has a context window that grows with each turn. Ephemeral — destroyed on disconnect, recreated on reconnect.

**What it answers:** "Am I about to hit the context ceiling? Should I decompose or wrap up?"

**Signal:** `input_tokens` from the latest SDK response. This IS the context window size. No estimation needed.

**Lifecycle:** Resets on reconnect. A session might cycle through multiple agents.

### Session

Mitzo's persistent concept. Survives disconnects, has message history, has an ID. When a user returns to a session, a new agent is created and fed compressed history.

**What it answers:** "How much have I spent on this conversation so far?"

**Signal:** Sum of all `input_tokens + output_tokens` across every agent lifecycle in this session. Monotonically increasing.

**Lifecycle:** Created when user starts a chat. Lives until archived.

### Goal

A task board item with a purpose. May span multiple sessions, subagents, Centaur reviews, and ContexGin compiles.

**What it answers:** "How many tokens did it take to accomplish this objective?"

**Signal:** Sum of all token usage reported to the Goal Registry via `X-Goal-Id`. This is tokens-to-goal — the north star.

**Lifecycle:** Created when a goal is added to the task board. Completed when all subtasks are done.

## 3. Data Flow

```
SDK result event
  │
  ├─→ input_tokens  ─→  Agent counter (replace on each response)
  │                       └─→ Session bar: "Context: 87k/200k"
  │
  ├─→ input_tokens + output_tokens ─→  Session counter (accumulate)
  │                                      └─→ Session bar: "Session: 142k"
  │
  └─→ POST /goals/:id/contribute  ─→  Goal Registry (accumulate)
                                        └─→ Task board: "Goal: 198k"
```

### Subagent Attribution

Subagents (worktree agents, background tasks) are separate API calls with independent context windows. They:

- **Do NOT** count toward the parent agent's context window (they don't bloat it)
- **DO** count toward the session total (the session spawned them)
- **DO** count toward the goal total (they contributed work)

The agent counter is local. The session and goal counters are inclusive.

## 4. UI Design

### 4.1 Session Bar (Phase 1)

Persistent header element in the chat view. Always visible. Minimal.

```
┌──────────────────────────────────────┐
│ ‹  fix auth module                   │
│    ◉ 87k / 200k        total: 142k  │
├──────────────────────────────────────┤
```

- Left: agent context gauge — `input_tokens` from last response / 200k ceiling
- Right: session total — cumulative tokens burned
- Color thresholds:
  - Green: < 100k (plenty of room)
  - Yellow: 100k–160k (getting heavy)
  - Red: > 160k (wrap up or decompose)
  - Flashing: > 190k (hard ceiling approaching)

Tapping the bar expands a detail panel:

```
┌──────────────────────────────────────┐
│ Agent context:    87,204 / 200,000   │
│ Agent #:          3 (this session)   │
│ Session tokens:   142,580            │
│ Subagent tokens:  28,400             │
│ Session cost:     ~$1.82             │
│ Goal:             Refactor auth      │
│ Goal total:       198,200            │
└──────────────────────────────────────┘
```

### 4.2 Goal Rollup (Phase 2 — requires task board)

Each goal on the task board shows cumulative tokens:

```
┌──────────────────────────────────────┐
│ ★ Refactor auth module               │
│   3/4 tasks · 198k tokens · ~$2.50   │
│   ├─ Audit auth flow     ✓    52k    │
│   ├─ Extract validation  ✓    68k    │
│   ├─ Add tests           ●    42k    │
│   └─ Update docs              —      │
│                                      │
│   ▁▂▃▅▇▆▄▃▂▁ efficiency curve        │
└──────────────────────────────────────┘
```

### 4.3 Efficiency Curve (Phase 3)

Sparkline showing tokens consumed over time for a goal. Shape tells a story:

- **Steep start, then flat:** Bad context — spent tokens orienting
- **Flat, then steep:** Good context — hit a wall late
- **Steady climb:** Consistent progress — ideal
- **Staircase:** Subagent spawns — each step is a decomposition

## 5. Implementation

### Phase 1: Session Bar

**Server changes:**

```typescript
// In session state, add:
interface TokenState {
  agentContextTokens: number; // input_tokens from last response
  agentLifecycleIndex: number; // increments on reconnect
  sessionInputTokens: number; // cumulative input across all agents
  sessionOutputTokens: number; // cumulative output across all agents
  subagentTokens: number; // tokens from child agents
}
```

On each SDK `result` event:

- Set `agentContextTokens = result.usage.input_tokens`
- Add `result.usage.input_tokens` to `sessionInputTokens`
- Add `result.usage.output_tokens` to `sessionOutputTokens`

On agent reconnect (new API call for existing session):

- Increment `agentLifecycleIndex`
- `agentContextTokens` resets naturally (first response will set it)

On subagent completion:

- Add subagent's total tokens to parent session's `subagentTokens`

**Frontend changes:**

- New `TokenBar` component in session header
- Receives token state via existing session SSE stream
- Color logic based on `agentContextTokens` thresholds
- Expandable detail panel on tap

**Wire format** — add to session SSE events:

```json
{
  "type": "token_update",
  "agentContext": 87204,
  "sessionTotal": 142580,
  "subagentTotal": 28400,
  "agentIndex": 3
}
```

### Phase 2: Goal Rollup

Depends on task board (global-task-board.md). The Goal Registry in ContexGin already stores per-contribution token counts. The UI queries:

```
GET /goals/:id → { totalTokens, contributions: [...] }
```

### Phase 3: Efficiency Curve

Store timestamped token snapshots per goal contribution. Plot as sparkline. The SWE-Effi AUC model from the ROADMAP gives the formal metric.

## 6. Cost Estimation

Token-to-dollar conversion using published pricing. Display as approximate (`~$1.82`) since pricing varies by model and caching.

```typescript
const COST_PER_1K = {
  'claude-opus-4': { input: 0.015, output: 0.075 },
  'claude-sonnet-4': { input: 0.003, output: 0.015 },
};
```

Update when pricing changes. Don't over-engineer — a lookup table is fine.

## 7. Open Questions

1. **200k ceiling:** Should this be configurable? Different models have different limits. Claude Opus 4 is 200k but future models may differ.
2. **Subagent depth:** If a subagent spawns its own subagent, does it roll up to the grandparent session? (Probably yes — follow the goal ID.)
3. **Historical comparison:** "This goal cost 198k tokens. Similar goals averaged 150k." Needs a goal taxonomy or tagging system to define "similar."
4. **Alerts:** Should Mitzo proactively suggest decomposition when context crosses a threshold? Or just show the number and let the user decide?

## 8. Phasing

| Phase | What                                        | Depends on                            | Effort            |
| ----- | ------------------------------------------- | ------------------------------------- | ----------------- |
| 1     | Session bar (agent context + session total) | token-capture (#178)                  | Small — 1 session |
| 2     | Goal rollup on task board                   | global-task-board, goal-wiring (#179) | Medium            |
| 3     | Efficiency curves + historical comparison   | Phase 2 + goal taxonomy               | Large             |

Phase 1 is standalone and immediately useful. Start there.
