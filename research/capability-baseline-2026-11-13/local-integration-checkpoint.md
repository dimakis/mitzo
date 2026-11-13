# Local functional integration checkpoint

13 November 2026. Branch `docs/capability-approval-notification-baseline` in the
existing admitted checkout. No push, competing PR, hosted CI, model call, merge
to main or deployment was performed.

## Functional candidate

Accepted base `23816770cc1d80b16c557dd88f7078c7cf53f163` includes the visibility
delivery from PR #1322. It was integrated once into this task branch. The
preserved TaskExecution repair `76ee005a` was reproduced against that source:
all three SDK consumer tests failed at the unsupported profile route before
implementation. The applied repair retains the newer shared helper registration.

Local implementation commits:

- `601d242a`: guarded ordinary SDK TaskExecution catalog/registration/callback
  agreement, with profile-dependent task instructions. An actual application
  regression failed when an omitted profile still received the instructions;
  selected and omitted profiles now pass startup/continuation checks.
- `a01cdf8c`: SDK completion delivery defers to the installed shared notification
  owner. The real query-loop consumer reproduced an independent ntfy send under
  that owner before the fix. The standalone path is preserved; unexpected legacy
  sender rejection has a correlated diagnostic.
- `bf5771a7`: stronger SDK MCP consumer qualification through the real native
  executor and permission checks, substituting only sandbox effects and push.
  Denial, Ask/account/owner changes, in-flight expiry/revocation/owner cancellation,
  uncertain receipts and refusal to replay are covered. Two in-scope command
  variants reuse one task decision and one eligible alert.

The retained task grant still uses `network: none`; its authority was not widened.
It cannot authorize native shell operations, another account/root, publication,
merge, deployment or a live provider call. An owner-cancellation fixture exercises
the actual guard signal; it does not prove an OS process was terminated in a live
Claude session.

## Focused checks and limits

- Task/catalog/application/connection/visibility selection: 127 checks passed;
  one existing Access HTTP endpoint test was blocked by `listen EPERM` under the
  grant's network scope. The blocked case is not accepted as green.
- Query-loop/notification center/approval lifecycle: all 141 checks passed.
- Strengthened SDK-to-native task consumer: all ten cases passed, including
  in-flight expiry, revocation and owner cancellation. The expiry fixture starts
  near grant expiry so it tests that boundary before the separate MCP deadline.
- Package TypeScript builds, scoped ESLint, formatting, source fingerprints and
  whitespace checks passed for the changed source. Runtime/source revision is
  `v1.0.1133-claude-task-parity`.

These runs overlap; their counts are not a unique-test total. Existing task
dependencies were copied locally without network installation. The SQLite native
artifact was reused only after matching its source files. An initial missing
artifact and fixture-isolation failures were corrected before substantive red
claims. Logs remain local under `.verification/`. Broad server/frontend checks,
browser rendering, live device/provider qualification and final trusted review are
not claimed.

## Existing feature candidates and integration proposal

Read-only fetch and `git merge-tree` inspected these exact published heads without
changing their branches or this working tree:

| Candidate                   | Preserved head                             | Compatibility result against local functional candidate                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session controls, PR #1342  | `6dc2ba3322dbdc2a870c25b35b4b4f2d5c4f132d` | Conflicts in `server/session-access.ts` and source fingerprints. Move its additive `controls: SessionControlSupport` into the accepted shared protocol interface; preserve `helperSupport` and sanitized Access diagnostics. No readiness-schema replacement is needed. |
| Restricted skills, PR #1343 | `b9e2adaba6288b4de69f02259b33c72181757cd0` | Only source fingerprints conflict. Its early `chat.ts` skill-support guard merges textually, but still needs semantic regression checks against SDK admission and continuation.                                                                                         |

Proposal: retain the three local functional commits, integrate the existing two
slice heads into one designated feature candidate, resolve the shared Access
interface once, regenerate combined source fingerprints, and run targeted
projection/skill/task/application regressions before coordinated final CI. Preserve
the slice PRs and their owners. No remote feature-candidate custody has yet been
assigned here, so no existing PR branch has been overwritten and no competing PR
has been opened.

Restricted prompt enablement stays unsupported. New immutable command-ceiling work,
the reported `srt-mux` startup failure, real process/device qualification and
unsupported engine/target combinations are outside this bounded repair. Current
local Access listener coverage needs a route with loopback authority or the
coordinator's selected CI validation; no repeated approval card was requested.

Routine Telos mutations remain deferred. This file is local evidence for the
coordinator's single reconciliation, not an applied Telos status or assignment.
