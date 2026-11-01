# Prepared repository chat and publication

The ordinary chat workflow includes repository preparation, subsequent prompts,
selected-file commits, independent review, publication approval and a verified PR
receipt. A successful checkout or commit alone does not establish that this flow
works. Deployment and live verification are separate operations.

## Handoff and retained input

Repository adoption changes the execution workspace while preserving the
conversation, operator, account, context and native history. New sends must select
the adopted workspace. Selected-session metadata updates, reconnect and foreground
events invalidate the mounted composer even when adoption keeps the same branch
name. Send remains fenced until fresh metadata arrives; an old render callback
cannot submit after that invalidation.

An outbox command freezes its original wire body and ID;
metadata refresh cannot silently rewrite or replay it. Receipt observation is
read-only. Acceptance retires only the exact accepted command, preserving newer
composer drafts and attachments.

An explicit continuation can qualify a never-admitted command that still names
an ancestor workspace. A private, single-use admission scope binds the exact wire
hash to the canonical adoption lineage and current native owner. Its evidence and
ordinary execution admission commit atomically. Existing ambiguous commands cannot
be converted into this bridge. Subsequent receipt checks require the stored exact
wire evidence and preserve its original execution identity across later adoption.

After deployment, an old discovery revision qualifies only when it reconstructs
the initial server-accepted command fingerprint. Current account, model, thinking,
route, agent, context and permission checks still run. Unknown revisions, including
a later revision with no retained historical anchor, remain blocked. Receipt
observation cannot create this qualification or release work.

Local storage can reject a write even after the server consumed a command. When
a different valid durable composer revision already protects the newer draft,
retiring the old command does not require an obsolete submitted-revision marker.
Absent, malformed or matching revision records still require the journal before
retirement. A storage failure must not turn confirmed acceptance into another
provider invocation.

## Commit and publication

For an ordinary Mitzo chat, commit the selected work and use `RequestGithubPublish` to create or update its feature-branch PR. The tool does not run AI reviews, select a review model or assemble source into an inference packet. The former 800,000-byte review-evidence budget, review-round limits and model-response requirements do not apply to PR creation. Local development reviews and CI/Centaur/human PR reviews are independent of the publishing operation.

Changed-file counts and long paths do not gate publication. Approval and result cards show explicitly bounded file previews with the complete count and list hash. PR descriptions accept up to 65,536 characters; long descriptions have an explicit preview, full byte count and full-content hash in approval, while execution sends the original complete text. Recovery stores only bounded identity/lookup fields because it never resubmits a description or creates another PR. Existing committed-bundle transfer and GitHub limits remain distinct from model-review budgets.

Publication still checks the signed operator, exact active call, current account and connection, repository and branch scope, committed source identity and explicit operation authorization. Those checks remain fresh around asynchronous work and at mutation boundaries. A renewed verified primary-operator login can publish without rewriting the conversation's creator provenance. Native callback expiry, authorization revocation and runtime replacement stop further work; publication has no dependency on model or thinking settings.

The host reconstructs the committed Git artifact, pushes the approved feature branch, creates or updates the PR, and verifies the resulting PR and branch before reporting success. Credentials remain on the controller. Restart and ambiguous writes use read-only recovery before another attempt; a missing PR is not invented as a successful publication.

Standalone task Git metadata includes empty real reflog parent directories before publication into the task. The projector admits only the required fixed directory chain; arbitrary reflog files, symlinks and substitute paths remain forbidden. The trusted commit executor continues to stage only selected files.

Required CI, repository merge checks, Centaur and deployment authorization remain separate. Opening or updating a PR is not approval to merge or deploy. Symposium retains its separately owned sealed-artifact publication contract.

Interrupted native recovery preserves known terminal command failures and completed
file patches. An observed nonzero exit settles a failed shell command; it does not
mark that command successful or rerun it. Applied patches retain their original
files. Missing exit results, active commands, partial patches, unsupported effects
and unmatched host-tool receipts remain fenced. Fresh account, task, policy and
terminal-turn checks still precede release of queued work. After a deployment
changes the current policy, the original accepted native execution receipt may
prove the historical phase's exact policy. Its identity is rechecked under the
writer lock after the current owner check. This settles past effects only; every
subsequent turn uses freshly admitted current permissions.

## Effects to verify

| Order | Required consequence                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Repository adoption leaves the composer able to submit the next explicit prompt.                                               |
| 2     | Retries, response loss and reconnect retain one command identity and dispatch at most once.                                    |
| 3     | Later prompts, images and newer drafts survive acceptance and local storage pressure.                                          |
| 4     | Trusted commits preserve unrelated files; publication approval remains bound to the current signed owner and committed source. |
| 5     | Publication returns a verified PR receipt, while restart and ambiguous writes cannot create a duplicate.                       |

Offline regressions use real SQLite, admission, native FIFO and Git object
operations with synthetic provider responses and GitHub effects. They do not use
production task files, credentials or real models. The retained production
conversation must be verified separately after an explicitly authorized deployment;
offline success alone does not establish that the running release has changed.
