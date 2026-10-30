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

`POST /api/repository-workspaces/preview` optionally accepts a caller-generated
UUID `requestId`, retained before submission. The existing workspace row uses
that ID and a private server-derived fingerprint of the original account/model,
connection, canonical repository and ordinary runtime selection. Retrying that
exact intent renews authorization and returns the original record and pinned
commit, including any later preparation state. Changed intent conflicts; concurrent
metadata captures cannot overwrite the first committed row. Legacy callers can
continue omitting the ID. Neither the ID nor its fingerprint grants source or
runtime access, and preview does not acquire a checkout or start a session.

After a lost response, read the known workspace ID with the original account/model
or repeat the original preview request. A missing status response does not prove
that an earlier request stopped; retain its ID. Preparation continues through the
existing explicit `/:id/prepare` operation. An expired, failed, discarded or uncertain
original operation must not be silently replaced or rewound by preview recovery.

Discarded and failed ordinary preparations remain recoverable as terminal metadata
after their source directory is removed. Recovery still renews the original
account, runtime and connection authorization. It neither marks cleanup complete
nor clears the retained source identity, restarts preparation or returns a runnable
runtime. Missing or replaced source custody on a ready preparation still refuses.

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

For an admitted native Local Mac chat, repository discovery, inspection and
preparation retain the startup operator's authenticated login independently of
the browser's event connection. Suspending or reconnecting a phone does not
revoke that run's tool authorization. The retained binding is released with the
chat, including failed startup; it cannot fall back to a viewer after release.
Logout, expiry and revocation still invalidate it through the existing auth
registry. Native call, account, workspace, profile and one-use preparation
approval checks remain required. This applies to Local Mac Codex with API and
subscription accounts; it does not change queue controls or deployment.

After a cold resume, these tools use the current signed primary operator under
the same ownership rule as ordinary chat admission. The creating login remains
unchanged in the custody record; its login ID is not a permanent device ACL.
The original admission, pending native call and current operator must still be
valid, including after the viewer disconnects.

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

iOS background suspension buffers chat events while the current turn continues.
It does not revoke repository discovery, preparation or draft recovery. Those
tools still require the owning live session and its current account, model,
connection scope and skill permissions; closing or cancelling the session blocks
them. Preparation still requires Agent or Auto mode. The user must review and
send the returned draft before its new provider or sandbox starts.

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

### Adding a repository to an existing GitHub connection

Each AI account has one managed GitHub connection. To authorize another repository,
extend that connection instead of creating a second connection for the same account.
An authenticated operator can add one exact `owner/repository` pair with
`POST /api/connections/:id/github-repositories`, supplying the current connection
`revision`, a recent reauthorization `csrf` value and `repository`.

The operation requires fresh operator authorization, verifies the original gateway
provider and commits the additional repository and audit event atomically. It
preserves all existing repositories, base branches, account assignments, provider
identity and credentials. The additional repository is available to every account
already assigned to that connection. It does not grant publication permission;
the existing capability and per-publication approval checks still apply. Old
connection revisions require refresh and any revision-bound approvals must be renewed.

This endpoint only adds repository consent. It cannot remove repositories, change
base branches, replace credentials or change gateway network policy. Repository
preview still verifies actual access and pins the selected upstream commit.

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
- At most 10,000 current-tree files, 512 MiB of Git storage and 512 MiB of expanded
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

Enable only through reviewed deployment configuration and accepted sources. Canonical staging is stood down; use offline checks and CI. Live qualification needs a separately selected authorized target, and production deployment needs a separate explicit user action. A real model acceptance test
must announce its exact supported Luna model and charged account first.

Live acceptance should demonstrate one accessible private repository: acquire the
previewed revision, edit and test it, commit, publish a draft PR through the
ordinary broker, reopen the same conversation, and publish a second change to
that PR. Also exercise denial, changed connection/branch, interrupted preparation,
missing retained sandbox and account switching. Until those gates pass, this
remains an opt-in implementation rather than a claim of a finished development
workflow.

## Development setup

Source preparation checks for 3 GiB free before acquisition. The digest and
independent-copy bounds allow 1 GiB combined Git storage and expanded content;
copying requires another 2 GiB free for dependencies/builds. These are admission
checks, not reserved disk quotas; concurrent use can still consume the disk.

For Mitzo development, run `npm run setup:dev -- --install` inside the selected
workspace. The existing setup owner requires 2 GiB free and verifies
Git/Python/make/C++. It prepares Node 24 and npm 11.18.0 in an ignored
`.mitzo-devtools/toolchains/<platform-and-specification-key>/` scope, installs the
root lockfile with development dependencies, then checks the dependency tree,
native SQLite/PTY modules and test/build entrypoints. Use the reported
`toolchainPath` at the front of PATH for later commands. No other checkout's
`node_modules` is borrowed.

The setup owner derives HOME, XDG, temporary, npm prefix/cache and node-gyp
header directories from this task's `.mitzo-devtools/`. No caller-supplied
TMPDIR or writable host home/cache is required. Setup refuses directory symlinks
that redirect these paths outside the task. Native builds receive both the
[current node-gyp environment setting](https://github.com/nodejs/node-gyp#environment-variables),
`npm_package_config_node_gyp_devdir`, and its npm 11 compatibility setting.

`readiness.json` records only a successful verified installation identity:
canonical task root, platform, architecture, Node version/ABI, npm/toolchain
specification, prerequisite versions, manifest and lockfile. Toolchain receipts
also fingerprint its Node/npm entrypoints and installed toolchain lockfile.
Another `--install` rechecks those artifacts, the installed dependency lock,
`npm ls` and the native/entrypoint probes before reusing the installation. A
changed lockfile, manifest or ABI reinstalls dependencies; changed toolchain
artifacts reacquire only their toolchain scope. Downloads remain in separate
platform/toolchain and installation-keyed npm caches, using npm's integrity
checks; header caches are scoped by platform/toolchain, Node version and ABI.
Cache retention does not grant readiness or authorization. A failed `npm ci`
invalidates readiness before its effect and cannot leave a successful receipt.
`npm run setup:dev` verifies an unchanged receipt without installing; missing or
stale readiness requires explicit `--install`.

Installation needs public npm registry/GitHub access. Public pinned GitHub
dependencies use HTTPS without a host SSH agent or credential helper. Child
processes inherit only PATH and the Windows system directory; they receive empty
npm user/global configuration and no inference, hosting or API credential
environment. This contract does not grant new sandbox access. The CLI reports
JSON with `ready`, `phase`, `reason` and `effectStatus`, distinguishing filesystem
denial, insufficient space, network failure, lockfile mismatch and native
toolchain failure. Raw package/Git stderr is used only for safe classification
and is never retained or printed. `may_have_changed` means an install was
attempted, so a failure must not be treated as a clean pre-effect refusal.
Cleanup failures retain their own safe reason. A successful setup check is not
evidence of model execution, deployment or OpenShell egress approval.

Size failures return a specific 512 MiB diagnostic (HTTP 413), and low-space
failures return a capacity diagnostic (HTTP 507), through the existing picker
error display. Other failures retain sanitized account/access guidance.

Failed repository-tool results keep their error status and their source-chat-bound recovery card. The card decoder accepts only a validated failed receipt from an error-marked tool; it still rejects error-marked ready receipts, unrelated source chats and noncanonical links. Opening the original recovery link reads its retained failed status without repeating acquisition or starting a conversation. Shared card links use the existing control-height token for a 44px target.

The intercepted `repository-failure-card` browser fixture covers collapsed error groups, both preparation/recovery calls, keyboard activation, the actual recovery hook and status notice, narrow/large-text layouts and zero execution requests on mobile WebKit/Chromium and desktop Chromium in dark Mint/System and light Teal/Georgia. Inspected captures: [mobile recovery card](../design/assets/repository-failure-card-mobile-dark.png) and [desktop recovery card](../design/assets/repository-failure-card-desktop-light.png).
