# Host Knowledge Library enrollment

The Library is an operator surface for a curated accepted GitHub source. Its source is
an independent private bare mirror. It never reads the application's task checkout,
dirty files, model sandbox, or other worktrees. Accepted documents are Git objects on
the explicitly enrolled accepted branch. **Save draft**, Vim `:w` and Cmd/Ctrl+S
persist the complete working copy in private SQLite state. They do not create,
update or ready a GitHub PR, and do not trigger its CI. Editing another document
adds it to the same working copy rather than replacing previously saved files.

Use **Send for review** to publish the exact saved batch and make its PR ready.
The first send creates the review; later sends update that same review with the
new saved batch. Further saves leave the published review unchanged until the
next explicit send. Acceptance remains blocked when the saved draft differs from
its current published review. An already-confirmed send is inspected on retry
without republishing it or changing an already-ready PR.

Opening accepted documents reads their content without creating a working copy.
Choose **Edit** to stage changes. Moves retain the original accepted source path and
current text in the recovered working copy; moving back to the source path cancels
that move. New folders and directory-only changes use the same draft, review and
acceptance workflow as text edits. Moves stay within the same enrolled directory
scope; individually enrolled guidance files cannot move. Empty folders are represented
by reviewed `.gitkeep` markers. Saved draft versions and exact creation request IDs
also cover structural operations, so uncertain responses can be retried without
losing later edits or folders.

Removing the last folder from a never-published saved folder-only change closes
only that local draft. For a published folder-only change, the server checks the saved draft version and canonical review identity and head before
closing it, then verifies the result before clearing the local operation. A lost
response keeps the folder recoverable for retry; a changed review blocks cancellation.
GitHub does not provide an atomic head comparison for closing a pull request, so
the server checks the head both before and after that mutation and preserves the
saved receipt if the outcome is uncertain. Cancellation does not delete the branch
or change accepted knowledge.

An uncertain initial Save is settled by replaying its exact frozen request ID and
payload before folders are changed. A missing draft read does not prove that the
original request finished. Ambiguous or conflicting replay responses preserve the
request and working copy for recovery. The cancellation route accepts only saved
folder-only drafts; document and mixed changes cannot use it.

Set `MITZO_KNOWLEDGE_LIBRARY_CONFIG` to an absolute physical host JSON file owned by
the service user, with mode `0600` and a `0700` parent. Provision and independently
review host enrollment before enabling it. A repository document cannot supply this
configuration or select credentials. The state directory must be absolute, physical,
owned by the service user and mode `0700`, outside every Git checkout and workspace
root, including `REPO_PATH`. Existing state with broader permissions is refused.
The file and state are protected from the application file tools even before the
Library is opened; removing enrollment does not remove previously observed guards.
An unreadable or malformed enrollment makes those tools fail closed.

```json
{
  "repository": "your-owner/your-knowledge-repository",
  "acceptedBranch": "main",
  "documentPaths": ["essentials", "people", "teams", "strategy", "README.md"],
  "stateDirectory": "/absolute/private/host/knowledge-library",
  "publisherLogin": "your-publishing-account",
  "trustedReviewer": "your-centaur-account",
  "acceptanceEnabled": false
}
```

Every field is host controlled; unknown fields are rejected. Repository identifiers
must be lowercase `owner/name` on github.com. `documentPaths` is an explicit list of
curated Markdown directories or individual Markdown files, not an entire repository.
The accepted branch defaults to `main`; the trusted reviewer defaults to the repository
owner. Omit `publisherLogin` for a read-only Library. Acceptance requires both explicit
publisher enrollment and `acceptanceEnabled: true`; its default is disabled.

The existing GitHub CLI host transport supplies GitHub authentication. Its account is
verified against `publisherLogin` before saving, sending, inspecting or accepting a review.
Use a separately reviewed service account and credential configuration for this
host deployment. Authenticate that service user with `gh auth login --hostname
github.com`, or provide its separately enrolled `GH_TOKEN` / `GITHUB_TOKEN` in the
controller environment. With no environment token, private Git fetches and clones
use the code-owned GitHub-scoped `gh auth git-credential` helper against the same
GitHub CLI account as API calls. With an environment token, the fixed credential
helper reads it only from the controller environment. Both paths disable global and
system Git configuration; no user-defined Git credential helpers are inherited, and
stored GitHub CLI credentials are never copied into configuration, argv or diagnostics.
Never borrow production credentials/configuration for staging, or
fall back to production. No provider or real model call is needed for Library reads,
draft editing, source review inspection or acceptance.

On first enrollment, Git initializes `stateDirectory/source.git` without templates
or a worktree, enrolls exactly `https://github.com/owner/name.git`, and fetches only
`refs/heads/acceptedBranch` into `refs/remotes/origin/acceptedBranch`. Subsequent
starts use the validated cached mirror immediately. Explicit refresh fetches the
accepted branch and persists `synchronization.json` with its successful synchronization
time; a failed refresh retains drafts and the previous synchronization time. There
is no background backend, custodian, preview or automatic deployment. The mirror
rejects changed origin/refspec, unexpected local Git configuration and alternate
object stores. Drafts live in `stateDirectory/drafts.sqlite` with private SQLite state.

Before pushing a prepared change, Send for review atomically stores its exact commit ID and a
Git recovery bundle in the draft database. Core SQLite backups include those
objects, including unpublished commits and the draft branch's ancestry. After a
restore beside a freshly fetched source mirror, Send for review validates and imports the
saved bundle before reusing the same review head or preparing further edits. The
bundle is private database state, excluded from editor responses, and limited to
16 MiB. Finished drafts discard it. Recovery does not restore mirror configuration
or credentials, and corrupt or mismatched bundles block publishing.

Older backups contain no recovery bundle. If the prepared commit still exists,
Send for review records its bundle before publishing. If it is missing, it can rebuild from
saved documents only when neither a remote branch nor a saved/existing review is
present. A known published head is never replaced as a recovery shortcut; old
backups missing those objects still require restoring the original mirror.

The explicit submission API is `POST /api/knowledge/drafts/:id/ready` with the
saved `version`. An optional legacy `head` is a caller fence; the server selects
and verifies its own publication head. The legacy `/review` endpoint no longer
publishes, because older clients invoke it as part of Save. Uncertain publication
responses retain the prepared receipt and bundle; retry **Send for review** to
recover them. Save remains a local draft operation, including during that recovery.

Sending for review checks the configured account, canonical PR repository, base
branch, author, source branch and exact saved head. It reads the open PR immediately
before the ready mutation and verifies the same head is ready afterward. An
already-ready PR is verified without another mutation. This action requires no
Centaur approval, does not merge, and works while acceptance is disabled. Review
automation must be provisioned separately; readiness confirms the GitHub review
state, not that a reviewer has run. A closed or changed review cannot be sent.

Acceptance checks the canonical PR repository, base branch, author, source branch
`knowledge/draft-id`, and exact saved head. It combines trusted-author reviews and
comments in chronological order, using the same strict final Centaur report format
as the default-branch `Centaur merge gate` workflow. Missing, stale, dismissed,
ambiguous, blocking, `fix` or `human_decision` reports block acceptance. Every required
GitHub check must pass; an empty required-check list also blocks. Acceptance requires
the PR to be already ready through the explicit review transition. It repeats
inspection and merges with `--squash` and
`--match-head-commit`, without an admin bypass. Acceptance is recorded only after
GitHub confirms that exact PR was merged. The existing dedicated Centaur status App
and branch protection provisioning remain mandatory; see
[MGMT knowledge publication](mgmt-knowledge-publication.md).

Acceptance is source acceptance. ContexGin publication and per-chat consumer adoption
remain separate, with their existing source/runtime verification and receipts. The
Library cannot fabricate publication or adoption receipts. There is no staging or
production deployment action in this workflow. Production activation always requires
a separate explicit operator action.
