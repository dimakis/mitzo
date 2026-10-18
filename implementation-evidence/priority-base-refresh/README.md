# Accepted-base refresh and retained gate history

18 October 2026. One necessary base integration: merge `82235f31` incorporates
accepted main `0a048b5b` (#1008/#1011 ToolBuilder and #1009 priority). Only the source
manifest conflicted. Its entries are unioned, and the combined Todo type includes
both accepted `priority?:number` and the existing optional saved-artifact source
metadata. Only that combined file's hash is regenerated. No original fix is replayed
into core, and no source/store/route/approved UI redesign is introduced.

The eacc producer and original test bytes, SavedArtifactDialog/CSS and WorkOutputs
remain identical to the clean34f04 head. Accepted production source, priority UI,
protected checks and approval references remain byte-identical to accepted main,
except the documented manifest/type/design-document unions. Existing artifact
captures are preserved; new renders are separate evidence, not new approvals.

## Combined validation

- 194 source/component checks /7files pass, zero skips.
- 105 accepted priority-contract checks /6files pass, zero skips.
- 108 design checks pass, one pre-existing skip.
- 12 artifact/priority browser journeys plus 2 startup checks pass, zero failures or
  retries, one worker / 1 GiB outside Seatbelt. Mobile WebKit/Chromium and desktop
  Chromium, dark/light, large text, reduced motion, saved-version reload/export,
  Files Back, current refusal and priority save/refusal/navigation are covered.
- Protocol build, strict targeted TypeScript including the corrected fixtures,
  complete source fingerprints and normal hooks pass. No broad frontend build is
  inferred from focused checks. No model, live account, staging or deployment used.

Inspected new captures: [artifact mobile](artifact-mobile-dark.png),
[artifact desktop](artifact-desktop-light.png),
[priority mobile](priority-mobile-dark.png),
[priority desktop](priority-desktop-light.png).
[Receipt](receipt.json) pins source, checks and output hashes.

## Historical review and current gates

The actual published clean report is review5561003331 / node
PRR_kwDOR2Rn9s8AAAABS3YtQw, head34f04ef3, published01:48:54UTC on18October:
LGTM/merge, zero new/unresolved blockers, one verified resolution. It is retained
as one historical qualifying candidate, not relabelled as current-head approval.
Two distinct approved rounds remain the preparation baseline, with final whole-PR
approval required for the exact current head. A new blocker resets the clean sequence.
The prior ordinary CI run39086843568 has all8jobs successful. Other reported checks
are not added to that count. Its required Centaur context was still pending.

The configured required Centaur App binding is5169606. The old status creator is
`dimakis-mitzo-centaur-status[bot]`; public App lookup returned404, so no extra App
identity claim is inferred. No status or credentials were changed.
The sole outdated CEN-873972402DBA thread was resolved to match the actual source
fix/regressions and trusted report's verified resolution; no review was dismissed,
no approval body was rewritten and no new approval was manufactured.

Queue inspection used only the reviewer-provided SQLite `mode=ro&immutable=1`
snapshot. Job4850 on34f04 is complete/succeeded/attempt1/revision0/force0. Older
heads are skipped after advancement. This is a snapshot, may omit live/WAL state,
and grants no request/control authority. No manual review request, queue write,
service/config change or credential read was made. Prefer the normal automatic
follow-up after the final push and inspect current job/head/review state before any
additional request. Core was notified that the change is ancestry/union only.

New exact-head CI, trusted whole-PR review and the managed App gate must pass.
This remains draft preparation, with no ready/auto-merge/merge authority.
