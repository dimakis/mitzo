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

Standalone task Git metadata includes empty real reflog parent directories before
publication into the task. The projector admits only the required fixed directory
chain; arbitrary reflog files, symlinks and substitute paths remain forbidden.
The trusted commit executor continues to stage only selected files.

Ordinary `RequestGithubPublish` prepares a host-owned reconstruction of the exact
committed source. Two isolated review passes inspect complete changed files,
applicable policies and relevant unchanged context from pinned Git objects. Each
pass can request bounded additional source reads and literal searches. Missing
context, evidence limits, malformed output or blocking findings stop publication.
These reviews cannot execute tools or checks; their reports state that limitation.
The originating account, model, operator and permission selection remain fenced
through asynchronous allocation and dispatch.

Creating-login IDs remain provenance. A renewed verified primary-operator login
can request review; the review then retains and rechecks that current signed
authorization. Provider requests use the exact invoking command's model and
thinking selection. Startup metadata and later queued commands cannot retarget
that review.

Credential-free reads address pinned objects in the private host reconstruction.
Runtime qualification surrounds each complete evidence batch; individual Git
reads retain cancellation checks. Qualification before inference and publication
remains separate. This avoids multiplying a full physical task check by every
unchanged source file while still refusing a batch whose owner was revoked.

An approved review receipt is private, short-lived and tied to the exact operation,
source, connection and original owner. User approval follows review and binds that
evidence. Execution reconstructs and verifies the source again before any push.
Restarting does not manufacture a replacement receipt. Read-only recovery may
observe an existing PR; it cannot create a missing one. A positively proved failure
before push permits a fresh reviewed request. A possibly dispatched write retains
its uncertainty for verification.

## Effects to verify

| Order | Required consequence                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------- |
| 1     | Repository adoption leaves the composer able to submit the next explicit prompt.                                       |
| 2     | Retries, response loss and reconnect retain one command identity and dispatch at most once.                            |
| 3     | Later prompts, images and newer drafts survive acceptance and local storage pressure.                                  |
| 4     | Trusted commits preserve unrelated files; review and approval remain bound to the original owner and committed source. |
| 5     | Publication returns a verified PR receipt, while restart and ambiguous writes cannot create an unreviewed duplicate.   |

Offline regressions use real SQLite, admission, native FIFO and Git object
operations with synthetic provider responses and GitHub effects. They do not use
production task files, credentials or real models. The retained production
conversation must be verified separately after an explicitly authorized deployment;
offline success alone does not establish that the running release has changed.
