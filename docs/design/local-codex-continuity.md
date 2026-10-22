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
profiles retain their sandbox provider checks, and brokered subscription
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
when the original signed login remains valid, durable revocation checks are
available, and the account, target, workspace, published context and physical
custody still match. Cold bootstrap records the new command's uncertainty before
reopening the retained native process. It qualifies the new command's model and
thinking while preserving the original native history binding. Saved consumed
FIFO entries keep their own selections. Interrupted commands are not reexecuted.
Running or unresolved native thread ownership blocks reopening.

Legacy sessions without this custody evidence remain unavailable for execution
resume. A new login cannot adopt another operator's history. Location/account
changes require a new conversation and independent checkout. Missing custody,
revoked authorization, changed native bytes, source/login drift, incompatible
models or target revisions fail explicitly rather than choosing another route.

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
