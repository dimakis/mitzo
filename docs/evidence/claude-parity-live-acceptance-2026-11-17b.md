# Claude SDK (Local Mac) live acceptance sweep after #1387 — 17 November 2026 (evening)

Third live sweep. Earlier sweeps: 16 Nov after #1377 and 17 Nov after #1378
(`claude-parity-live-acceptance-2026-11-17.md`, Telos artifact
`951e0b63d1bec2704c5709c07ae58e8e`). This one ran from an ordinary Claude SDK chat
(Personal Claude, Sonnet 5.5) whose workspace is a linked repository task worktree,
with a standalone clone of `dimakis/mitzo` at accepted main `9f1a3e707` (#1387)
under `.repository-tasks/mitzo`.

Scope: live tool calls only, plus the focused regression tests named below. Nothing
here is a deployment, merge or acceptance claim.

## Is #1387 running?

The deployed build identity could not be read (no process, log or health access from
this sandbox). Four behaviours that exist only in #1387 code were observed live, so the
running route includes at least slices A and B:

| Observation                                                                      | #1387 source          |
| -------------------------------------------------------------------------------- | --------------------- |
| `TaskExecution authorize` returns `repositoriesWithoutLocalRoot`                 | slice A               |
| `TaskExecution commit` of a nested-clone file refused with the new wording       | slice A               |
| `SymposiumConsult authorize` returns `repository_source_unassigned` with guidance | slice B               |
| `StartSession` with a Claude account returns a Codex-only `startupBlocker`       | slice B               |

The 17 Nov Telos note that the running release is still `main-f986db0` is therefore out
of date for this route. Slices C and D (cards, iOS) were not independently identified.

## Result by slice

| Slice | Criterion                                                        | Live result                                                                                                           | Status |
| ----- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| A     | Nested-clone file is not committed into the parent                | Refused: `File belongs to nested repository .repository-tasks/mitzo; commit there with native git`. Parent HEAD unchanged (`63d8f603`), index clean | PASS (was FAIL) |
| A     | `gh` limit in `run` disclosed                                    | `gh auth status` in `run`: not logged in. Tool description and refusals now say so                                      | PASS (by design) |
| A     | Repositories without a local root disclosed                      | Both named repositories listed. `dimakis/mgmt` is listed although the workspace is a mgmt worktree (matched by `worktreePaths`, not by cwd) | PASS / note |
| B     | `InspectLocalRepository` on the workspace root (linked worktree) | Full structured result: head, branch, git dirs, instructions                                                           | PASS (was FAIL) |
| B     | `InspectLocalRepository` outside the session roots               | Named: `access-required`, `read-access-required`                                                                       | PASS (was opaque) |
| B     | `DiscoverLocalRepository` by name and by path                    | Selected for `mitzo`, `mgmt`, `contexgin` and an explicit clone path. A nonexistent name returns a structured `ambiguous` with `timeout` reasons | PASS |
| B     | `SymposiumConsult authorize` on an unassigned account            | `repository_source_unassigned`: pick a listed repository or ask the operator to assign the connection                  | PASS (was opaque) |
| B     | `AgentCommunication` to a cold peer                              | `recipient_unavailable`, stage `ownership`: "Open it explicitly before sending"                                         | PASS (named) |
| B     | `StartSession` with a Claude account                             | Proposal carries `startupBlocker`: Claude child sessions are not available yet                                         | PASS (honest, slice E open) |
| B     | `RequestGithubPublish` with no assigned connection               | See the publication section below                                                                                      | see below |
| C     | Reads need no card in Auto                                       | `ToolSearch`, `TelosManageItem` read, `TelosFindArtifacts`, `TelosReadArtifact` returned immediately. Card count is not observable from inside the session | UNCONFIRMED |
| D     | Keyboard flash, first-send delay                                 | Device behaviour; not testable from a chat                                                                             | NOT TESTED |
| E     | Fresh Personal Claude sessions                                   | Not implemented (see `StartSession` above)                                                                             | OPEN |

Carried-forward checks that still pass: Write, Edit and Bash write/delete in the own
workspace; `TMPDIR` and `CLAUDE_CODE_TMPDIR` both set to the private scratch directory;
Write and Bash to a sibling checkout rejected by the PreToolUse hook;
`dangerouslyDisableSandbox` refused with a named message; web search and public HTTPS
fetch; `ReadToolOutput` literal-query paging; Calendar `fields` + `singleEvents`;
`HomeAssistantDashboard` list; `SchedulePrompt` and `SessionTimers` create/cancel;
`SymposiumReadProfiles`; `AgentReadTasks`; `ReadKnowledge` list; `TelosGetItem`
refusal naming `TelosManageItem`; `TaskExecution` authorize, run, github_read, and
commit refusal.

## Gaps found

1. **`InspectLocalRepository` fails opaquely on a standalone clone root.** Path
   `.repository-tasks/mitzo` returns `internal_failure`, `reason: unknown`, every time
   (diagnostics `7f5d49e5-7041-4023-95ac-57dcd6361450`,
   `a2772bd9-8cc8-4859-808b-24ce660d837a`). The same tool succeeds on the workspace root
   and on a subdirectory of that clone (`docs`). One `DiscoverLocalRepository` for a
   name that does not exist also failed once with `internal_failure`
   (`739530fe-84c1-4a9a-b21f-c9856cf28161`), while a repeat with another nonexistent name
   returned a structured timeout result. The failing stage is not visible to the model;
   the cause is not proven and host logs were not readable. This is the same
   observability gap that slice B set out to close, now narrowed to one input shape.
2. **Oversized results bypass the bounded preview and cannot be read back.**
   `InspectLocalRepository` (102,334 characters on the `docs` subdirectory) and the
   `RequestWebAccess` fetch (about 54 KB) were saved by the SDK to a file under the
   Claude account directory. The harness message tells the agent to read that file, but
   the `Read` hook denies it ("Claude sign-in and private account files are unavailable
   to agent tools") and the `Bash` hook denies the path as outside the worktrees. In
   contrast, `SymposiumConsult catalog`, `AgentCommunication list` and `ReadKnowledge
   list` return a `tool-output-preview` with an `outputId` for `ReadToolOutput`.
   `projectToolOutput` is called from `server/credential-sdk-tools.ts` but not from
   `server/sdk-local-repository-tools.ts`; the web-access server's wiring was not
   checked. This is the live shape of finding 6 from the 16 Nov probe.
3. **`ReadKnowledge published` remains unavailable** (`published_host_store_unavailable`).
   Operator action: enable the Local Mac knowledge enrolment. Unchanged.
4. **Knowledge Library `list` enumerates paths of the private spokes.** The listing
   from `github:dimakis/mgmt@main` includes documents under `career/`, which
   `knowledge-publication-policy.json` and `docs/knowledge-publication.md` classify as
   private operator knowledge. Titles and paths only were seen; no document was read.
   The Library source is separate from the published memory view, so the exclusion does
   not appear to apply to it. Needs an operator decision before anything reads them.
5. **`HomeAssistantDashboard` with an unknown connection id** returns "Connection access
   failed. Check Connections and retry", which reads as an outage. The real connection id
   worked. Four connections are configured; two share the label "Home Assistant Admin".
6. **Steering and peer send remain unproven.** All 50 listed peers are `unavailable`
   (`recipient_not_live`) and self-send is refused, so mid-turn steering needs a second
   live participant.
7. **Auto-mode card counts are not measurable from inside the session.** Reads returned
   without delay, which is consistent with slice C but does not prove it.

## Not exercised

- Live `SymposiumConsult` consult (model call; needs an approved Luna model and a named
  charged account).
- `SaveKnowledgeDraft`, `SymposiumProposeProfile`, Home Assistant `save`, Drive/Docs/Sheets reads.
- The OS-level write fence beneath the hook, and iOS device behaviour.

## Environment

Node 24.10.0, npm 11.21.2 (satisfies `>=11.18`). The macOS keychain credential helper
printed `failed to store: -60008` during `gh repo clone`; the clone itself succeeded.
