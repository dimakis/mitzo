# Tool Builder contract

This is the Phase 4 contract, delivered in dependency order. The first slice
provides deterministic draft preparation; the reusable profile, authorized
development adapter, operator review and registry bridge require later slices.
No Phase 4 source acceptance or live qualification is claimed by this document.

The Tool Builder profile works through the regular
chat composer and profile system. It interviews the user, searches the installed
catalog first, and recommends reuse, an installed reviewed API template, or a
custom implementation draft.

## Draft boundary

The catalog and template readers are read-only. A draft is private review data;
it is not an implementation registration. A custom draft contains a name,
description, input and output schemas, examples, permission behavior, compatible runtime
routes, relative source files, and test evidence. Files are written only through
the development workspace authority supplied to that builder session. The
workspace adapter rejects paths outside its root and does not accept absolute
paths, parent traversal, or symlink escapes.

The test runner accepts named repository test profiles and runs them through the
existing bounded sandbox executor. The builder cannot provide a shell command,
network destination, environment, credential, or sandbox policy. Test output is
bounded. A source digest covers the complete workspace file set, which must
match the requested files before and after tests. A separate contract digest
covers schemas, examples, permissions, compatibility and the test profile as
well as source. Returned drafts are independent snapshots. Changing any part
of a contract invalidates prior evidence. Failed or cancelled preparation
discards its workspace; a cleanup failure is reported. A failed,
cancelled, or incomplete run cannot be submitted as tested.

Schemas use a bounded object/array/primitive JSON-schema subset. Every example
input, expected value and reported actual value must validate; references,
patterns and unsupported keywords fail before development effects. Nested
schemas, source size, string length and array lengths are bounded.

The OS sandbox protects authority; it does not authenticate assertions made by
candidate code running inside the test process. Evidence records whether it is
a candidate report or a trusted executor result. Candidate reports are review
material, not publication certification. Publication additionally requires
independent qualification through the statically installed, accepted source
registration under a host-owned oracle. No candidate completion envelope can
replace those checks.

## Review and immutable publication

Draft edits create a new version. Feedback is attached to the submitted version;
revisions never mutate an accepted version. Submission freezes the version,
source and contract digests, test evidence, schemas, examples, permissions, and compatibility.
Only an independent accepted review can authorize publication. The submitting
builder cannot approve its own change.

Publication binds a tool identity and version to the exact reviewed source
and contract digests and to a statically installed executor registration. The runtime never
imports, evaluates, or executes source from a draft, review bundle, API-tool
configuration, or workspace. Custom implementations become selectable only
when their accepted code is installed in the application registry and the
requested route has an executor. The publication receipt is append-only; later
revisions receive a new implementation version. Profile assignment remains a
separate user action and uses existing selection, admission, permission and
session snapshot rules.

If an equivalent installed tool exists, the builder proposes its immutable
reference and does not allocate a workspace or create another implementation.
Template recommendations refer only to templates the existing API tool owner
reports as installed. Neither recommendation changes profile selection.

## Failure behavior

Failed tests, denied review, cancellation, source drift, unavailable runtime
support, unsupported workspace authority, and unaccepted drafts leave the
catalog unchanged. Selection resolves an exact accepted identity/version and
current runtime support; labels and aliases never resolve a draft. Promotion,
credentials, broader permissions, and agent assignment require separate
explicit user actions.

## Installing a reviewed custom implementation

Custom source installation is a normal reviewed application source change.
There is no upload-to-execution path. A code-owned registration names the draft's
opaque identity, implementation version and exact contract digest, supplies
compiled input/output validators and a statically imported executor, and maps
every draft file to its registered reviewed-source artifact. The executing
module and independent qualification module must be among those files.
Publication invokes only accepted installed qualification code, validates every
example through the installed validators, and compares actual results in the
trusted owner. Candidate output cannot certify this step. Publication checks the exact source hashes,
schemas and full current source closure; no caller can supply registrations
through the operator API. A missing registration remains unpublished.

The first custom runtime contract supports read-only computation on invocation
input on `local-api`. It supplies no filesystem, connection, credential, shell
or request capability. Drafts can describe other requirements for review, but
those requirements cannot publish through this runtime. Implementing another
runtime or permission contract needs a reviewed source change.

The private ledger uses the existing stable operator subject. Builder operations
are scoped to their originating session and create immutable version rows with
optimistic version fences and retry identities. Only the separate authenticated,
same-origin operator route can accept/reject a submitted version or publish an
accepted installed version. Operator identity is supplied by the route, never
the request body. Rejection retains feedback. Cancellation before publication
prevents publication. Exact publication retries return the original opaque
receipt. Accepted older versions remain resolvable while later drafts change;
source closure drift requires deliberate review, installation, publication,
selection and a new session.

Qualification rechecks operator, cancellation, version and source authority
after each awaited operation and immediately before inserting the publication.
A newer qualification supersedes an older attempt; failure or cancellation
cannot leave a new publication. Exact retries of an existing publication verify
its current binding and return the original receipt without executing again.

## Catalog and local API admission

The ordinary Agent Library owner mounts the private Tool Builder review routes
and projects accepted publications into its existing Tools endpoint. Custodian
owner/controller configurations retain their refusal; this does not introduce a
new proxy. The statically imported inventory is initially empty. A draft bundle
alone cannot add executable code to that inventory.

Published custom references use the existing portable profile tool selection.
Actual local OpenAI Responses and Gemini/Vertex admission resolves their immutable
receipt, installed definition and complete reviewed closure. The native private
continuation store retains these definitions and reference mappings for cold
resume. Other runtime routes retain their refusal. Invocation checks exact wire
identity, current selection, skill policy, bounded schemas and existing approval;
it captures approved input and the exact authenticated operator across awaited
approval. Logout, cancellation, ownership changes or source drift prevent the
call. Publication does not select a tool for any profile or running session.

## Reusable Builder in ordinary chat

The code-owned `mitzo-tool-builder` profile explicitly selects six bounded tools:
catalog search, exact contract reads, draft preparation, immutable revision,
inspection and submission. Missing tool selection retains legacy behavior and
does not add these development capabilities. Only the ordinary local API chat
adapter enrolls them. The same regular profile settings/composer are reused.

Preparation binds the verified native turn/call identity and exact request hash;
identical in-flight calls coalesce, durable exact retries return the original
draft, and changed retries fail. Development requires a managed isolated primary
worktree, the current authenticated operator, current skill/runtime authority,
and exact request approval without remembered grants. Ask mode refuses mutation.
Approval binds the worktree filesystem identity; descriptor-relative allocation
and operations reject replacement, private-root overlap and revoked authority.

The Builder writes and tests the complete approved source bundle in its isolated
workspace. It receives no shell command, launch configuration, credential,
connection, network destination, review decision or publication operation.
Failure discards allocated source; successful tests followed by failed storage
also discard it. Test provenance remains visible. Session-scoped inspection
returns schemas, examples, file identities and bounded source pages. Operator
feedback remains attached to the reviewed version; the next version records a
fresh tested contract without replacing accepted source.
