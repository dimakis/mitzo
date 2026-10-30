# Local checkout and Git failures — 30 October 2026

The retained rescue conversation `54f78226-329b-81b1-8f84-ffdbd5f134b8` failed three
`PrepareLocalRepository` calls on release `46a75b907288`. Its Work OpenAI account
had eight nonretired standalone records, including adopted tasks. The account-wide
count therefore prevented selection of another repository even though the source
checkout and its unpublished commits were intact. The rejection was an ordinary
Error and became `internal_failure`, reason `unknown`, effect status `unknown`.

A signed native offline callback reproduces that result using controlled retained
ledger data and actual SQLite/Git source facts. Adopted claimed tasks now leave
the unfinished-preparation budget. Unadopted claimed records remain counted.
Reservation is checked again in an immediate transaction; a competing insertion
between the initial check and reservation is refused. Local-source preparation
also checks the existing 2 GiB plus 256 MiB disk headroom. Refusals are typed,
pre-effect `resource_exhausted` diagnostics. No retained task is erased or reassigned.

Conversation `2eedc885-2a09-84e6-92f0-663109a3ec74` received an explicit session Git
metadata grant but shell commits still failed to write objects or `index.lock`.
Its fallback submitted 218 paths to `GitCommit`, whose schema accepts 64. Those
paths included integration of newer main. `Invalid native tool input` concealed
the limit, and the narrow selected-file service cannot represent normal merges.

The pinned official Codex 0.160.0 binary reproduces the root Git denial with no
inference: a writable workspace still has an implicit read-only `.git` carveout.
The actual production profile compiler now uses a nested workspace-relative
`.git` write rule. The same native fixture commits a task change and creates a
two-parent merge containing 218 upstream files. Unselected work is preserved;
Ask Git writes, credential reads and writes outside the workspace remain denied.
This uses ordinary native Git, not an expanded parallel commit implementation.
The existing narrow service now describes its limit and returns actionable copy.

The original child-creation conversation retained a completed prepared-checkout
continuation, a later interrupted explicit command and a queued new prompt. New
offline coverage passes that sequence through the public cold entry using genuine
stores/owners and synthetic provider RPC. It preserves the old command and work.
The production log dropped the exception from the original cold task failure;
this test does not establish its exact cause or claim that a live session resumed.

Validation uses one worker and a command-local 1 GiB Node heap under macOS warning
pressure. The pinned native command fixture makes zero model calls, uses synthetic
homes/repositories/credentials, and runs outside Seatbelt to exercise its own
sandbox. It qualifies command execution under production-generated profiles;
turn/session grant lifecycle remains separately qualified by existing fixtures.
No production sessions/stores/configuration were modified, no model credentials
were borrowed, and no staging or deployment action was performed. Hosted CI and
review remain required before merge.
