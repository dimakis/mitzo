# Claude development parity repair — 16 November 2026

This repair follows the read/write trials in conversations `0a1a0281…` and
`42686ec8-5b51-839f-a527-22cdaa1c69ad`, and continues the stopped repair in
`8f0645ca-3852-8e64-89eb-204c40c5f277`. The original trial report is retained
as Telos artifact `d89a294a3e3c6b624ea8e71d4d2f11d8`, revision 1, under slice
`16143f0ea2b21a34`. That artifact was identified through the public trial
transcript; its bytes were not reread during this takeover.

The implementation preserves the existing ordinary Claude query and history.
It starts no specialist, agent or Symposium session. The source baseline is
accepted Mitzo `57a3df15c8751bca6dcfb30450c24134e9509c56`; the original
unpublished commits and unfinished edits were recovered without editing their
source checkout.

| Trial finding                                                | Source change and verification                                                                                                                                                                                                                                                                                                                                     | Remaining acceptance                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Own task writes denied; unrelated checkouts writable         | SDK writes are limited to the launch workspace, selected/default Claude state directory and per-process scratch. The executable and profile file themselves are protected instead of their entire parent directories. Startup/policy regressions cover the ancestor overlap.                                                                                       | Real OS write-denial test must pass in CI; live Claude writes remain unverified.                                                                                                                                   |
| Git storage is linked; native commits fail                   | Guidance uses retained checkout facts. Standalone task Git storage is writable; external linked-worktree administration remains fenced. Linked tasks commit through TaskExecution with explicit cwd. The regression exercises TaskExecution, the native executor and trusted Git, then reopens unfinished task work while preserving staged/untracked source work. | Live Claude development acceptance remains.                                                                                                                                                                        |
| Another repository cannot be acquired in this chat           | Shared discovery and inspection tools use the original acknowledged SDK callback/read authority. Prepare attaches an existing local source through the existing secondary worktree lifecycle, retaining task identity and restoring it on reopen.                                                                                                                  | Clone/new remain native Git operations inside admitted roots. Preparation does not claim a primary-workspace transition.                                                                                           |
| Known failed search bricks the turn                          | Completed web failures retain settled callback outcomes. Search scratch is outside private credential storage. Offline regressions preserve unknown effects and cancellation fences.                                                                                                                                                                               | Actual provider search must be verified on the selected route after activation.                                                                                                                                    |
| Large timer/tool results spill into unreadable private files | SDK results return bounded previews with query-owned ReadToolOutput paging, expiry, retention bounds and original source authorization. A revoked/expired output read settles without replaying its source operation or bricking the turn.                                                                                                                         | Live large-output acceptance remains.                                                                                                                                                                              |
| Calendar fields rejected; recurring definitions returned     | Canonical Calendar reads accept fields and expand instances with singleEvents/orderBy. Existing regressions verify the shared request contract.                                                                                                                                                                                                                    | Live Calendar acceptance remains.                                                                                                                                                                                  |
| Published memory unavailable                                 | Startup tests read an enrolled immutable publication through the actual Personal and Vertex SDK MCP tool. Missing host enrollment and missing turn selection now have distinct diagnostics; Library listing remains separate.                                                                                                                                      | A published read also failed in the takeover's Codex chat. Repair/enable the existing host publication enrollment or selection; no private host configuration was changed and no checkout fallback was introduced. |
| Sandbox-disable request silently ignored                     | Bash requests with dangerouslyDisableSandbox receive an explicit refusal explaining the outer host boundary.                                                                                                                                                                                                                                                       | Live UI acceptance remains.                                                                                                                                                                                        |
| Task approval lists a repository without a local folder      | Approval text distinguishes GitHub read repositories from registered writable roots and explains that authorization does not acquire a checkout.                                                                                                                                                                                                                   | Live approval-card acceptance remains.                                                                                                                                                                             |
| TelosGetItem/UpdateItem report unavailable                   | Those operations retain their canonical assigned-lead restriction and now identify TelosManageItem as the ordinary-chat path. Actual SDK tests verify both refusal and assigned-lead success.                                                                                                                                                                      | No role or authority is silently added.                                                                                                                                                                            |
| Steering/discoverability failure                             | Existing actual SDK user-steering and cross-runtime peer-delivery/visibility regressions passed in the broader run. Self-exclusion from AgentCommunication listing and self-message refusal are intentional.                                                                                                                                                       | The reported live steering failure has not been reproduced independently of callbacks_failed. No root cause or completed live fix is claimed.                                                                      |

## Verification recorded during this repair

- 359 affected server checks passed across 20 selected suites; four existing
  OS sandbox checks were skipped under their normal opt-in gate.
- A broader run passed 395 checks and found one outdated offline catalog fixture,
  subsequently regenerated from the authoritative registration catalog.
- Type checking, linting of changed TypeScript, the server build, reviewed
  source closure, IANA data and security-backport verification passed before
  publication. The separate tool-catalog UI regression was updated for Claude's
  new route while retaining approval and write-capability assertions.
- The new development sandbox test was attempted through TaskExecution. The
  runner refused nested sandbox application with `sandbox_apply: Operation not
permitted`; this is incomplete qualification. The existing native CI job now
  requires this test alongside its three existing Git-setup checks, with no
  skipped result accepted as qualification.
- All checks here are offline protocol/adapter tests or disposable local Git
  fixtures. No live model call was made. CI, Centaur review, merge, activation
  and live user acceptance are separate delivery evidence.

The final profile check reproduced an additional transport gap: an explicit
Claude profile could receive a preview while excluding ReadToolOutput. The
reader is now a required transport helper on supported native/Claude routes;
its original source authorization and frozen skill checks still apply, and no
saved profile or source-tool selection is changed. Missing/expired output has
an explicit `tool_output_unavailable` / `not_started` diagnostic. All 77 checks
in the affected catalog, SDK tool, real startup and catalog UI suites pass.

CI on the first published head also exposed outdated schema/route/native-count
fixtures and an actual missing-parent failure for an explicitly configured
search scratch root. Those six failures were reproduced locally. The scratch
parent is now created before exclusive temporary allocation; discovery/admission
and restart tests retain the exact execution-ledger cwd. All 36 checks in the
affected five suites pass. New-head CI and trusted review still remain required.

The final aggregate affected-suite run passed 386 checks across 26 suites, with
four opt-in native checks skipped. The server build and source/security checks
also passed. Accepted main subsequently advanced to `dc122db8` with the separate
shared-composer repair (#1374); integration preserves that work and combines
both source-fingerprint registrations under a new runtime revision. Native CI,
trusted review and live acceptance remain separate requirements.

Native CI on integrated head `1b029b0b` passed protected Claude startup and the
complete repository workflows on both owned account routes. Retained artifact
`native-repository-workflows-43900513759-1` exposed three failures in the Git
setup step: both SDK modes still asserted that the owned `.git/config` was
read-only, and the new OS probe received `/tmp/claude` instead of its approved
scratch path. The worker launcher was copying SRT's TMPDIR over the target's
explicit directory after policy creation. It now retains explicit scratch and
uses the runtime directory only when no target directory was supplied. Actual
launcher/process regressions exercise directory creation in both cases; all
71 focused checks pass (four opt-in native checks skipped locally). The native
test now verifies owned config writes while retaining parent/sibling denials.
Environment-transfer failures also retain structured stderr diagnostics instead
of an empty error handler. New-head OS qualification remains required.

The same CI run exposed eight unit failures, reproduced locally. The required
output transport is now included in explicit-profile inventory assertions while
omitted TaskExecution remains unavailable. More substantially, the repository
callback hook had been appended to every SDK query, including reviewed-context
advisers. It is now enabled only by the ordinary SDK query owner; the adviser
retains empty MCP/tool/hook settings and denies tool calls. Assertions now run
outside the mocked SDK callback so startup cleanup cannot conceal their failure.
All 71 checks in the affected adviser, cross-runtime messaging, TaskExecution,
repository-callback and ordinary startup suites pass.

The remaining excluded-source and authority fixtures similarly assumed an empty
MCP server rather than required output transport. Their eight failing cases now
pass while retaining source-tool denial and post-approval authority revocation.
The unfiltered five-suite reproduction exceeded TaskExecution's 120-second
limit during native process fixtures; its partial result is not a full pass and
was not replayed. The affected cases were selected explicitly for verification.
Browser fixtures now include the output reader in Library search and scope the
imported stop-message assertion to its status dialog. Local WebKit was installed
in task scratch, but its startup/teardown timed out; the four selected browser
cases did not run. Current-head CI must verify those browser assertions.

Keep the defect slice active until its own live criteria are fulfilled, or each
remaining gap is explicitly retained with its owner and next action. A source
patch, passing fixture or published PR alone does not establish working
production Claude development.
