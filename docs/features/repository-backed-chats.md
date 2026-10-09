# Repository-backed ordinary chats

This first slice prepares a selected GitHub repository for a new ordinary chat.
It is opt-in with `MITZO_REPOSITORY_WORKSPACES_ENABLED=1`; publication, dependency
installation and live staging acceptance remain separate.

## User flow

1. Choose a supported OpenAI account and model in a new chat.
2. Add a repository from the account's managed GitHub connection, or paste an
   equivalent canonical GitHub HTTPS URL. A new repository must first be included
   in that connection's allowed repositories; this flow does not widen its scope.
3. Preview the default branch and its exact current GitHub commit.
4. Prepare an independent checkout and generated feature branch. The preview
   expires after five minutes; a branch that moved before acquisition is rejected.
5. Send the first prompt. The server claims that preparation for this conversation,
   and supplies the task checkout to the selected runtime.

Mobile and desktop share the picker. An unfinished or lost selected preparation
blocks sending instead of silently starting in the default repository. A ready
receipt can be restored after a browser reload. Removing an unused preparation
deletes only its controller-owned source copy; a claimed task cannot be removed by
this endpoint.

The task starts at the previewed commit on `mitzo/repo-<preparation UUID>`. Host
chats receive an independent copy beneath the configured repository's
`.claude/repository-tasks/repo-<UUID>/mgmt`; that directory is a standalone Git repository,
not a linked worktree. These durable tasks are outside automatic worktree cleanup;
legacy `repo-<UUID>` containers are also retained by that collector, including
interrupted claims. OpenShell receives the independently prepared source at
its existing canonical task workdir. These internal paths are not a new global
repository configuration or authority to change the original checkout.

Repository chats do not run the MGMT task compiler against arbitrary source.
Enrolled published knowledge keeps its existing separate acquisition, runtime
attestation and adoption path. Resuming preserves task edits, branches and provider
history. The conversation stores its repository identity separately from the claim
ledger; a missing or mismatched ledger blocks resume before runtime admission.
A missing or changed retained sandbox must not be replaced with the
default MGMT seed.

## Conversational preparation

An ordinary agent can discover authorized repositories with `ListRepositories`,
then call `PrepareRepositoryChat` with a repository and a focused task draft.
Mitzo resolves the account, model and unique GitHub connection from the live chat;
the tool cannot choose another account, credentials or host directory. Preparation
requires Agent or Auto mode and the same deployment enrollment as the picker.

The tool result renders a repository-ready card. Opening it creates a new chat
draft with the pinned repository, editable task and required account/model.
The user reviews and sends that draft before any new provider or sandbox starts.
The source chat keeps its workspace, branch, permissions and provider history.
The task draft carries the requested work; it does not copy the entire transcript.
Existing conversation workspaces are never switched by this tool.

Editable prompts use a browser draft keyed to their preparation. Reload preserves
edits, including an intentionally empty prompt, without changing ordinary unsent
chat drafts. Send saves the current edit before transport; only the matching new
conversation assignment consumes it. A rejected Send retains the prompt for retry,
while uncertain delivery keeps the existing pending-send fence.

The preparation and task draft are durable. `GetRepositoryChatPreparation` reads
a known ID, or recovers the latest preparation owned by this chat and the same
account/provider/profile after a lost response. A source-chat model change can
recover its old draft; the prepared model and launch binding remain unchanged. Repeated identical requests reuse the
existing preparation; a different task waits until the previous unused draft is
discarded. Failed acquisition is not retried automatically. Interrupted `preparing` or
`claiming` records remain fenced for inspection of the original operation before
any reuse or cleanup; status recovery does not prove that an old worker retired. A
claimed draft links to its original target conversation instead of creating a
replacement, and clearing it never deletes the claimed task.

Both chat layouts block sending during draft recovery, account/model mismatch,
missing preparation or a stale active-session transition. Only the matching
server assignment consumes the preparation receipt and removes the handoff URL.
Browser defaults are preserved; a prepared account/model cannot silently fall
back to another selection. The authenticated draft endpoint derives its binding
from stored server state and accepts no client account override.

## Acquisition and custody

The controller resolves the AI binding from its current account catalog. Both
preview and preparation require an active managed `github-readonly` connection
assigned to that exact account and scoped to the selected repository. The current
controller GitHub identity must match the connection. Revisions and account
identity are rechecked after asynchronous operations and before claiming/uploading
source. Neither HTTP nor WS inputs can select a source directory, credentials,
replacement account, feature branch or arbitrary clone command.

GitHub metadata reads discover the default branch and commit. Acquisition uses a
canonical GitHub URL, isolated Git configuration, no templates or shared object
storage, and a bare clone before materialization. No project hook, configured
filter, package installation or repository program runs on the controller. Task
Git configuration uses the existing portable `Mitzo Sandbox
<sandbox@mitzo.invalid>` author identity; publication still uses the separately
verified GitHub connection and its ordinary forced approvals.

Controller metadata is persisted in the private Codex directory under
`repository-sources/workspaces.db`. Frozen source digests include Git metadata and
working files. Each preparation has one conversation claim. Interrupted
`preparing` or `claiming` states remain fenced and require inspection of that
original record; there is no automatic overwrite, reset or fallback. Once startup
settles and the task workspace is independently retained, the controller seed copy
is reclaimed. Task files, Git history and conversation metadata remain intact.
At most eight unreleased preparing/ready/claimed sources may be held per account.

## Resource use

Host tasks retain independent full copies of files and Git metadata. An isolated
Python helper copies through pinned directory descriptors on macOS/Linux, applying
no-follow lookups and exclusive creation so a replaced path cannot redirect later
writes. It runs only during a host copy, preserves file modes, and fails closed if
Python or the required descriptor operations are unavailable. The original claim
and partial copy are retained for inspection. Filesystem cloning remains future
work.

Source verification reads files in 64 KiB chunks, retaining the existing frozen
digest format. It rejects files that change or exceed their inspected size during
reading. Verification still reads the entire bounded source, including Git data.

Each preparation still acquires its own repository history. The eight-source
limit bounds unreleased preparations per account, and successful provider startup
reclaims its seed. Retained tasks have no aggregate storage quota or automatic
archiving policy yet. Shared downloads, active sandbox admission and idle runtime
management remain subsequent resource work. Task files are preserved by default.

## Initial support and limits

- Ordinary `openai` and compatible `openai-codex` accounts, using host execution or
  the existing managed OpenShell runtime. Native Symposium account enrollment is
  excluded.
- GitHub's default branch and complete reachable history; no user-selected refs,
  local-path attachment, GitLab, forks or submodule/LFS provisioning in this slice.
- Tree metadata has a separate 64 MiB command-output bound; short-content files with long paths do not share the 2 MiB diagnostic-output cap.
- A claimed preparation links to its existing conversation and cannot start another first send.
- At most 10,000 current-tree files, 64 MiB of Git storage and 64 MiB of expanded
  current-tree content. GitHub's advertised repository size is checked before
  cloning; actual storage/content checks follow acquisition. This is not an OS
  disk quota on the network transfer.
- Current-tree files must be regular blobs. Symlinks, submodules, escaping paths,
  control characters and case/normalization collisions are rejected. Unsupported
  acquisition preserves the original repository and does not start a model turn.
- Source readiness does not mean dependency readiness. Dependency/network setup,
  the changes panel, CI presentation and a unified publish button are subsequent
  workflow slices. Existing `GitCommit` and `RequestGithubPublish` paths remain the
  means to commit and request a feature-branch PR.

## Verification and rollout

Local Git fixtures cover pinning, branch movement, independent storage, commit
creation and export through the existing publishing boundary. Router, account
revision, concurrency, restart, seed mutation, retention and both chat-layout
tests use local data and mocked provider/transport boundaries. They do not prove
real GitHub authentication, physical sandbox upload, model execution, dependency
setup or external publication. Static mobile/desktop picker rendering is also
distinct from device acceptance.

Enable only through reviewed deployment configuration. Use the canonical staging
procedure in `docs/operations/canonical-staging.md`, accepted sources and an
independently reviewed staging provider configuration. Do not borrow production
credentials or create a parallel staging backend. A real model acceptance test
must announce its exact supported Luna model and charged account first.

Live acceptance should demonstrate one accessible private repository: acquire the
previewed revision, edit and test it, commit, publish a draft PR through the
ordinary broker, reopen the same conversation, and publish a second change to
that PR. Also exercise denial, changed connection/branch, interrupted preparation,
missing retained sandbox and account switching. Until those gates pass, this
remains an opt-in implementation rather than a claim of a finished development
workflow.
