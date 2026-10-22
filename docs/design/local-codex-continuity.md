# Owned Local Codex continuity

This source increment extends the existing ordinary Local Codex route through the
approved picker. OpenShell remains the new-session default. The Local route stays
behind its existing explicit configuration gate. Source tests do not enroll a
provider, deploy the feature or qualify its behavior against a live model.

## Production account configuration

With `MITZO_ORDINARY_LOCAL_CODEX_ENABLED=1`, production bundle validation accepts
an ordinary file-backed ChatGPT host-login profile alongside existing OpenShell
accounts. The host profile declares its absolute `credentialRef`, email and
non-API plan. It must omit workspace identity, native sandbox authentication and
every sandbox provider/grant field. Host runtime declarations still need to be
regenerated for the actual accepted release and measured executable; deployment
validation of profile shape does not establish login or runtime readiness.

The host login is a separate connection from the brokered OpenShell OAuth
profile, even when both belong to the operator's same ChatGPT subscription.
Keep the existing broker profile and authentication unchanged. OpenAI API
profiles use canonical Keychain custody and durable rotation/enrollment fences on the host; sandbox replica checks belong to sandbox consumers. Brokered API consumers retain their sandbox provider checks, and brokered subscription
profiles retain provider ID, grant and credential-isolation validation.

## Retained conversation and command selection

The existing EventStore admission receipt freezes each command's prepared prompt,
model, thinking, permission and agent/context snapshot. Later commands must retain
the original account identity, target revision, workspace and published context.
A different supported model or thinking setting belongs to the new command; it
does not change the native conversation's original account binding or rewrite an
already admitted command. Completed history is not a perpetual model allowlist:
account/source custody validates routing independently of the historical native
model key, while new, queued and running selections retain their own current
configuration and actual native-model authorization checks.

The retained authenticated owner admits later commands into the existing native
FIFO. A queued continuation remains undispatched until its outer receipt commits
consumed. An earlier turn completing during enqueue cannot bypass that fence.
Failed admission retains uncertainty; saved retries do not enqueue or dispatch
again. Queued cancellation retains the original history and settings. Interrupts
and ambiguous native turns retain their existing recovery records rather than
becoming replayable.

## Cold resume

Builtin and published profiles retain their exact namespace, revision and content
hash. Supported workspace and ContexGin context recipes compile once after the
original checkout claim while admission remains uncertain. Provider acceptance
uses the existing context delivery/adoption receipts. Native custody records
profile and compiled context digests before thread effects; cold continuation
verifies that exact snapshot without a source refresh. Legacy recipe history
without those original digests stays unavailable. Pinned packs remain unsupported
until a trusted native continuation barrier exists.

Before native thread creation, the existing CodexConversationStore row records
strict internal physical custody: original signed operator session ID, bootstrap
identity, private home and source credential directory identities, auth-file inode
and content hashes, and measured original/copied executable identities. These
values are not client inventory and cannot be supplied by a browser request.

A fresh explicit command can reopen the same private home and provider thread
when a current signed login for the primary interactive operator is valid, durable revocation checks are
available, and the account, target, workspace, published context and physical
custody still match. Cold bootstrap records the new command's uncertainty before
reopening the retained native process. It qualifies the new command's model and
thinking while preserving the original native history binding. Saved consumed
FIFO entries keep their own selections. Interrupted commands are not reexecuted.
Running or unresolved native thread ownership blocks reopening.

Legacy sessions without this custody evidence remain unavailable for execution
resume. Mitzo currently has one primary interactive subject (`user`) under its configured signing realm. Separate device login IDs are revocable credentials for that subject, not separate users. A verified new login in that realm can explicitly continue the same chat; a forged, expired, revoked, custodian-realm or internal token cannot. Original creating-login custody remains provenance. A future multi-user deployment must add stable subject identity rather than reuse this single-operator rule. Location/account
changes require a new conversation and independent checkout. Missing custody,
revoked authorization, changed native bytes, source/login drift, incompatible
models or target revisions fail explicitly rather than choosing another route.

## Deployment identity and runtime bundle

Strict target configuration version 2 adds `continuityContract: "codex-native-thread-v1"`.
The target revision binds the host, configured target, reviewed compatibility family
and supported native CLI version. `runtimeContractRevision` still binds the exact
current reviewed implementation, full source closure and both selected native binaries;
each accepted deployment must generate that declaration from its accepted sources.
The private native selector must be version 2 and explicitly pin both
`executableSha256` and `codeModeHostSha256`; the containing directory is not
implicit authority for another executable. Version 1 native selectors are refused
by this source until the separately authorized deployment prepares a v2 successor.
A stale or edited declaration fails the independent host observer. Code changes do
not by themselves replace a conversation's native target identity.

The only legacy bridge currently qualified in source is accepted release
`8c3e5062c5df`, with the exact reviewed source closure retained in
`server/host-codex-continuity.ts`. The bridge derives its original target revision
from that closure, the current measured native bytes, host and target. It never
accepts a client alias, arbitrary old hash or an unknown deployment. Continuation
keeps the original runtime binding, receipts, native thread, private home, account,
workspace and context. Actual native/source custody still must match; compatibility
is not credential renewal or permission to replace a binary. The current deployment
must explicitly adopt the v2 declaration at an independently authorized deployment;
this source change does not edit a running installation.

The real repository and ordinary-workspace preparation owner applies the same
reviewed target compatibility check. New subscription preparation proofs mark
credential digest version 2 and bind the source login root/auth file independently
of deployment attestation; current native/code attestation remains requalified.
Known legacy proofs are checked against freshly measured current authority and
the exact six-field published v1 observation reconstructed only for accepted
8c3e5062c5df. The original preparation proof remains unchanged. Changed source
credentials, keys, accounts, unknown targets and native custody remain refused.

This migration is Local Codex only. OpenShell's source-bound target revision remains
an independent migration requirement; PR #1091 changes workspace selection and its
startup deadline, not the OpenShell continuity contract.

The supported Mac native distribution contains both `codex` and its sibling
`codex-code-mode-host`. The host observer preflights both. Private runtime capture
pins both with the same physical custody and launch hashing. A retained single-file
runtime can append only the missing companion, from the original installed sibling,
after original custody and explicit command admission. The existing native row records
a FULL-synchronous upgrade intent before file effects, bound to exact original custody,
source metadata/hash and private directory identity. Only that journal permits rebuilding
its interrupted partial copy. The append and journal retirement commit before native
launch; a crash or failed launch can reopen the completed custody. Unexplained artifacts
remain refused and command uncertainty is preserved. Existing main,
login, context and thread evidence cannot be rewritten by that append.

## Send acceptance and recovery

The ordinary server startup budget is 120 seconds; clients allow 135 seconds for
the bounded response, including its body. This is a ceiling, not a dispatch target.
A lost response does not mean the server rejected a command. A streamed/persisted
reply prompts a read-only exact-receipt lookup, which returns acceptance only for
the original consumed command after current authentication and historical custody
validation. It cannot reserve, prepare, bootstrap, replay or dispatch anything.
Only that receipt clears submitted input; independent later edits remain drafts.
It also retires its obsolete HTTP wait so a subsequent explicit send is not
held behind that transport until its deadline. No command is automatically resent.

Explicit sends can renew the retained driver's current login authority under its
existing revocation controller. Reading or subscribing does not silently transfer
execution authority. Logout/expiry still closes authority owned by that login.

## Credential renewal limitation

Auth-file renewal remains a strict refusal. The current native account proof
exposes email and plan, which do not independently establish a stable authenticated
principal or workspace identity. An inode replacement or changed token hash in
the source or retained private home invalidates the owner, even if those labels
match. This can stop a long-lived conversation or block cold resume after normal
credential refresh.

Supporting renewal requires independently reviewed authenticated principal
proof and a safe-turn-boundary custody revision under the existing native owner.
The operator, source/home roots, native executable and provider continuation must
remain bound; active or ambiguous work cannot acquire new credentials silently.
Unsigned token claims and matching email/plan are insufficient. This increment
does not weaken those guards or claim live renewal qualification.

## Offline evidence and remaining qualification

Focused tests cover immutable future selections, queued consumption/cancellation
races, exact retries, rejected operator/legacy adoption, physical replacement,
reopened competing stores, and cold model/thinking changes with saved FIFO and
interrupted history.

The offline development fixture uses a real reserved Git checkout, a TypeScript
esbuild build and node:test regressions. It edits and publishes to a mocked draft
PR, reopens the original native custody/thread, makes a second tested edit and
updates the same mocked PR/branch. A second conversation retains an independent
checkout of accepted source. Git commits occur only inside temporary fixture
repositories; publication and provider transports are mocked.

This proves source ownership and continuity paths under offline fixtures. It
provides no live provider/tool qualification or actual GitHub publication evidence.
The Local tool surface retains its existing native and MCP tools; it does not
claim parity with ordinary OpenShell publishing helpers. Current-head CI, the
exact-head Centaur/MGMT acceptance gate and separately reviewed provider/tool
qualification remain required. Staging remains stood down; production activation
requires a separate explicit user action. Any later real model test must select
a supported Luna model and name its charged account before execution.
