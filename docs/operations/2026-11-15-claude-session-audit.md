# Claude session naming, history and context audit

As of / verified: 15 November 2026. Source baseline: accepted Mitzo
`b7762c11818d`. Scope: a focused sample of recent operator-authorized public
conversation text, the supplied Chats/history screenshots, read-only runtime
logs and trace observations, and the source paths below. This is a bounded
investigation, not a complete inventory or a live provider qualification.
Private conversation content and account storage are excluded from this report.

## Findings and disposition

| Finding                                                                 | Evidence                                                                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal Claude chats retain workspace-envelope titles.                 | The owned SDK route skips legacy naming callbacks and previously echoed admitted input without triggering naming. `isGenericSessionName` did not recognize these old titles.                                                                 | Name newly echoed owned SDK commands through the shared account-bound naming path. Repair old display titles from public request text; preserve manual titles, event history and list ordering.                                                                                                                                           |
| Auto-naming unnecessarily loads complete event history.                 | `tryAutoRename` used `getSessionEvents`, including tool payloads, before extracting public text.                                                                                                                                             | Reuse `getSessionNamingEvents`: at most 256 prefix events / 32 KiB, plus eight recent ordinary user requests / 32 KiB, so later substantive requests remain discoverable. Account-bound naming remains local; no additional provider call is introduced.                                                                                  |
| The newest personal Claude chat fails to open on iOS.                   | Repeated HTTP 500s from `/api/sessions/:id/messages`; correlated trace identifies the selected conversation and shows 2,091 events read successfully, successful workspace recovery, and failed `transcript.projection`.                     | Root cause remains unknown. The route previously discarded the exception; add fixed failure categories, deepest failing stage and a diagnostic ID, preserving the original cause in memory and the existing failed response. This diagnostic change does not recover the affected live conversation.                                      |
| Earlier stuck completion reports are stale relative to accepted source. | Public [PR #1363](https://github.com/dimakis/mitzo/pull/1363) merged as `bb9b6218`; the current source includes it.                                                                                                                          | Keep provider result correlation separate from the new history-projection failure. Merge is not proof that an older uncertain turn was recovered or the phone was retested.                                                                                                                                                               |
| Claude's default local context differs from Codex.                      | `server/chat.ts` selects an empty boot fallback for `ordinarySdkAuthority` when no compiled agent context exists, and uses explicit settings isolation. `server/codex-chat-session.ts` includes the selected published MGMT knowledge block. | Follow up through the existing context owner. Preserve explicit account/settings isolation; reuse reviewed knowledge publication and context recipes rather than exposing private Claude memory/configuration directories. Compiled Claude context is already supported, so “Claude gets no context in every configuration” is too broad. |
| Google Workspace schema publication remains suspect.                    | `server/google-workspace-sdk.ts` passes a discriminated union directly to MCP registration; recent session evidence reports an empty listed object schema.                                                                                   | A separate schema owner should verify actual `tools/list` output, publish a discoverable schema and retain strict per-operation validation. No live Google call or schema repair is included here.                                                                                                                                        |

## Context-efficiency follow-up

1. Select the same reviewed knowledge revision and concise boot recipe for the
   default Claude and Codex routes. Record what was delivered and what the
   provider acknowledged; do not equate source availability with adoption.
2. Keep instructions and retained source snapshots in their existing context
   channels. Keep public user text free of generated repository setup envelopes.
   Naming now strips the known legacy envelope without rewriting saved evidence.
3. Use useful chat names and one retained audit/handoff to avoid repeated broad
   history scans. Recent Claude summaries were empty, so metadata-only searches
   missed them; transcript search recovered the relevant conversations. A recent
   session/engine filter would be a separate history-tool improvement.
4. Measure delivered system/tool-schema bytes, cache creation/read usage,
   compactions and repeated retrieval before reducing context. No comparative
   token savings or cache improvement is measured by this audit. The bounded
   naming read is an independently verified reduction in host-side history I/O.

## Validation and remaining boundary

The naming regressions cover subscription, Vertex and Messages accounts,
duplicate echoes, manual renames, historical list projection and bounded public
history reads. The transcript diagnostic regressions compose the real replay
adapter with HTTP failure delivery for history, full transcript and reconnect,
and verify that private error/result content is absent from diagnostics.

No production restart, provider test, credential migration, stored transcript
repair, merge or deployment is performed by these changes. Recovering the
specific iOS failure still requires the original replay exception/category from
the owned runtime. Do not delete history, replay the user command or relax
provenance checks to make the conversation open.
